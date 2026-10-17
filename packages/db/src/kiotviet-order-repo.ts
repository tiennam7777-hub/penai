import { sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";

export async function claimKiotVietOrderDraft(
  db: Db, ctx: WorkspaceContext,
  input: { channelId: string; threadId: string; fingerprint: string },
): Promise<string | null> {
  const result = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    INSERT INTO kiotviet_order_drafts
      (workspace_id, source_channel_id, source_thread_id, order_fingerprint)
    VALUES (${ctx.workspaceId}, ${input.channelId}, ${input.threadId}, ${input.fingerprint})
    ON CONFLICT (source_channel_id, source_thread_id, order_fingerprint) DO NOTHING
    RETURNING id`));
  return result.rows[0]?.id ? String(result.rows[0].id) : null;
}

export async function finishKiotVietOrderDraft(
  db: Db, ctx: WorkspaceContext, id: string,
  result: { orderId: number; code: string } | { error: string },
): Promise<void> {
  await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    UPDATE kiotviet_order_drafts SET
      status = ${"error" in result ? "failed" : "sent"},
      kiot_order_id = ${"orderId" in result ? result.orderId : null},
      kiot_order_code = ${"code" in result ? result.code : null},
      error = ${"error" in result ? result.error.slice(0, 500) : null},
      updated_at = now()
    WHERE id = ${id}`));
}

export async function listKiotVietOrderDrafts(db: Db, ctx: WorkspaceContext): Promise<Array<{
  id: string; channelName: string; sourceThreadId: string; status: string;
  kiotOrderCode: string | null; error: string | null; createdAt: string;
}>> {
  const result = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    SELECT d.id, c.name AS channel_name, d.source_thread_id, d.status,
           d.kiot_order_code, d.error, d.created_at
    FROM kiotviet_order_drafts d
    JOIN channels c ON c.id = d.source_channel_id
    WHERE d.workspace_id = ${ctx.workspaceId}
    ORDER BY d.created_at DESC LIMIT 30`));
  return result.rows.map((r) => ({
    id: String(r.id), channelName: String(r.channel_name), sourceThreadId: String(r.source_thread_id),
    status: String(r.status), kiotOrderCode: r.kiot_order_code ? String(r.kiot_order_code) : null,
    error: r.error ? String(r.error) : null,
    createdAt: new Date(String(r.created_at)).toISOString(),
  }));
}
