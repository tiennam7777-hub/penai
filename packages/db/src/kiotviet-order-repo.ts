import { sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";

export async function claimKiotVietOrderDraft(
  db: Db, ctx: WorkspaceContext,
  input: { channelId: string; threadId: string; fingerprint: string; payloadFingerprint: string },
): Promise<string | null> {
  const result = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    INSERT INTO kiotviet_order_drafts
      (workspace_id, source_channel_id, source_thread_id, order_fingerprint, last_payload_fingerprint)
    VALUES (${ctx.workspaceId}, ${input.channelId}, ${input.threadId}, ${input.fingerprint}, ${input.payloadFingerprint})
    ON CONFLICT (source_channel_id, source_thread_id, order_fingerprint) DO NOTHING
    RETURNING id`));
  return result.rows[0]?.id ? String(result.rows[0].id) : null;
}

/** Customer follow-ups must not create another slip for a recent live order. */
export async function hasKiotVietOrderSince(
  db: Db, ctx: WorkspaceContext, channelId: string, threadId: string, since: Date,
): Promise<boolean> {
  const result = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    SELECT 1 FROM kiotviet_order_drafts
    WHERE workspace_id = ${ctx.workspaceId} AND source_channel_id = ${channelId}
      AND source_thread_id = ${threadId} AND created_at >= ${since}
      AND status IN ('sending', 'sent', 'updating', 'failed')
    LIMIT 1`));
  return result.rows.length > 0;
}

/** Staff -cn targets the latest live slip, even when its original classifier payload is unchanged. */
export async function claimLatestKiotVietOrderForStaffUpdate(
  db: Db, ctx: WorkspaceContext, channelId: string, threadId: string,
): Promise<{ id: string; orderId: number; code: string } | null> {
  const result = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    UPDATE kiotviet_order_drafts SET status = 'updating', updated_at = now()
    WHERE id = (
      SELECT id FROM kiotviet_order_drafts
      WHERE workspace_id = ${ctx.workspaceId} AND source_channel_id = ${channelId}
        AND source_thread_id = ${threadId} AND status = 'sent'
        AND kiot_order_id IS NOT NULL AND kiot_order_code IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    )
    RETURNING id, kiot_order_id, kiot_order_code`));
  const row = result.rows[0];
  return row ? { id: String(row.id), orderId: Number(row.kiot_order_id), code: String(row.kiot_order_code) } : null;
}

export async function finishKiotVietOrderUpdate(
  db: Db, ctx: WorkspaceContext, id: string,
  result: { payloadFingerprint: string } | { error: string },
): Promise<void> {
  await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    UPDATE kiotviet_order_drafts SET
      status = 'sent',
      last_payload_fingerprint = ${"payloadFingerprint" in result ? result.payloadFingerprint : sql`last_payload_fingerprint`},
      error = ${"error" in result ? result.error.slice(0, 500) : null},
      bill_image_status = ${"error" in result ? sql`bill_image_status` : "pending"},
      updated_at = now()
    WHERE id = ${id}`));
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

export async function finishKiotVietBillImage(
  db: Db, ctx: WorkspaceContext, id: string,
  result: { groupId: string; msgId: string } | { error: string },
): Promise<void> {
  await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    UPDATE kiotviet_order_drafts SET
      bill_image_status = ${"error" in result ? "failed" : "sent"},
      bill_image_group_id = ${"groupId" in result ? result.groupId : null},
      bill_image_msg_id = ${"msgId" in result ? result.msgId : null},
      bill_image_error = ${"error" in result ? result.error.slice(0, 500) : null},
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
