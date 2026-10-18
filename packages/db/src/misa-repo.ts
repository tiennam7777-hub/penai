import { eq, sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";
import { misaCredentials } from "./schema.js";

export type MisaCredentialsRow = typeof misaCredentials.$inferSelect;

export async function getMisaCredentials(db: Db, ctx: WorkspaceContext): Promise<MisaCredentialsRow | null> {
  const rows = await withWorkspace(db, ctx, (tx) => tx.select().from(misaCredentials)
    .where(eq(misaCredentials.workspaceId, ctx.workspaceId)).limit(1));
  return rows[0] ?? null;
}

export async function saveMisaCredentials(db: Db, ctx: WorkspaceContext,
  values: Pick<MisaCredentialsRow, "taxCode" | "username" | "passwordEncrypted" |
    "invoiceSeries" | "vatRate" | "priceIncludesVat">): Promise<void> {
  await withWorkspace(db, ctx, (tx) => tx.insert(misaCredentials)
    .values({ workspaceId: ctx.workspaceId, ...values })
    .onConflictDoUpdate({ target: misaCredentials.workspaceId,
      set: { ...values, draftEnabled: false, updatedAt: new Date() } }));
}

/** Claim before any external POST. Never automatically retry a failed or timed-out request. */
export async function claimMisaInvoiceDraft(db: Db, ctx: WorkspaceContext, input: {
  channelId: string; threadId: string; fingerprint: string; buyerName: string; totalAmount: number;
  refId: string;
}): Promise<string | null> {
  const result = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    INSERT INTO misa_invoice_drafts
      (workspace_id, source_channel_id, source_thread_id, request_fingerprint, status, buyer_name, total_amount, misa_ref_id)
    VALUES (${ctx.workspaceId}, ${input.channelId}, ${input.threadId}, ${input.fingerprint},
      'processing', ${input.buyerName}, ${input.totalAmount}, ${input.refId})
    ON CONFLICT (workspace_id, source_channel_id, source_thread_id, request_fingerprint) DO NOTHING
    RETURNING id`));
  return result.rows[0]?.id ? String(result.rows[0].id) : null;
}

export async function finishMisaInvoiceDraft(db: Db, ctx: WorkspaceContext, id: string,
  result: { refId: string } | { error: string; uncertain: boolean }): Promise<void> {
  await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    UPDATE misa_invoice_drafts SET
      status = ${"refId" in result ? "saved" : result.uncertain ? "uncertain" : "failed"},
      misa_ref_id = COALESCE(${"refId" in result ? result.refId : null}, misa_ref_id),
      error = ${"error" in result ? result.error.slice(0, 500) : null}, updated_at = now()
    WHERE id = ${id} AND workspace_id = ${ctx.workspaceId}`));
}

export async function listMisaInvoiceDrafts(db: Db, ctx: WorkspaceContext): Promise<Array<{
  id: string; channelName: string; status: string; refId: string | null;
  buyerName: string | null; totalAmount: number | null; error: string | null; createdAt: string;
}>> {
  const result = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    SELECT d.id, c.name AS channel_name, d.status, d.misa_ref_id, d.buyer_name,
      d.total_amount, d.error, d.created_at FROM misa_invoice_drafts d
    JOIN channels c ON c.id = d.source_channel_id
    WHERE d.workspace_id = ${ctx.workspaceId}
    ORDER BY d.created_at DESC LIMIT 30`));
  return result.rows.map((r) => ({
    id: String(r.id), channelName: String(r.channel_name), status: String(r.status),
    refId: r.misa_ref_id ? String(r.misa_ref_id) : null,
    buyerName: r.buyer_name ? String(r.buyer_name) : null,
    totalAmount: r.total_amount === null ? null : Number(r.total_amount),
    error: r.error ? String(r.error) : null,
    createdAt: new Date(String(r.created_at)).toISOString(),
  }));
}

export async function getSavedMisaDraftSource(db: Db, ctx: WorkspaceContext, refId: string): Promise<{
  channelId: string; threadId: string; buyerName: string;
} | null> {
  const result = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    SELECT source_channel_id, source_thread_id, buyer_name FROM misa_invoice_drafts
    WHERE workspace_id = ${ctx.workspaceId} AND misa_ref_id = ${refId} AND status = 'saved'
    LIMIT 1`));
  const row = result.rows[0];
  return row ? { channelId: String(row.source_channel_id), threadId: String(row.source_thread_id),
    buyerName: String(row.buyer_name ?? "") } : null;
}
