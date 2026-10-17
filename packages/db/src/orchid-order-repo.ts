import { sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";

export async function claimOrchidOrderDispatch(
  db: Db, ctx: WorkspaceContext,
  input: { channelId: string; threadId: string; fingerprint: string; targetThreadId: string; message: string },
): Promise<string | null> {
  const result = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    INSERT INTO orchid_order_dispatches
      (workspace_id, source_channel_id, source_thread_id, order_fingerprint, target_thread_id, message)
    VALUES (${ctx.workspaceId}, ${input.channelId}, ${input.threadId}, ${input.fingerprint}, ${input.targetThreadId}, ${input.message})
    ON CONFLICT (source_channel_id, source_thread_id, order_fingerprint) DO NOTHING
    RETURNING id`));
  return result.rows[0]?.id ? String(result.rows[0].id) : null;
}

/** One order report per customer conversation since its latest /new, including legacy reports keyed by order details. */
export async function claimOrchidOrderReport(
  db: Db, ctx: WorkspaceContext,
  input: { channelId: string; threadId: string; targetThreadId: string; message: string },
): Promise<string | null> {
  return withWorkspace(db, ctx, async (tx) => {
    // Serialise concurrent Zalo deliveries for the same conversation before checking prior reports.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.channelId}:${input.threadId}`}, 0))`);
    const reset = await tx.execute(sql`
      SELECT id, sent_at FROM inbox_messages
      WHERE workspace_id = ${ctx.workspaceId} AND channel_id = ${input.channelId}
        AND thread_id = ${input.threadId} AND direction = 'in' AND btrim(text) ~* '^/new$'
      ORDER BY sent_at DESC, id DESC LIMIT 1`);
    const lastReset = reset.rows[0];
    const prior = await tx.execute(sql`
      SELECT 1 FROM orchid_order_dispatches
      WHERE workspace_id = ${ctx.workspaceId} AND source_channel_id = ${input.channelId}
        AND source_thread_id = ${input.threadId}
        AND (order_fingerprint ~ '^[0-9a-f]{64}$' OR order_fingerprint LIKE 'order-session:%')
        AND created_at >= ${lastReset ? new Date(String(lastReset.sent_at)) : new Date(0)}
      LIMIT 1`);
    if (prior.rows.length) return null;
    const fingerprint = `order-session:${lastReset ? String(lastReset.id) : "original"}`;
    const result = await tx.execute(sql`
      INSERT INTO orchid_order_dispatches
        (workspace_id, source_channel_id, source_thread_id, order_fingerprint, target_thread_id, message)
      VALUES (${ctx.workspaceId}, ${input.channelId}, ${input.threadId}, ${fingerprint}, ${input.targetThreadId}, ${input.message})
      ON CONFLICT (source_channel_id, source_thread_id, order_fingerprint) DO NOTHING
      RETURNING id`);
    return result.rows[0]?.id ? String(result.rows[0].id) : null;
  });
}

export async function finishOrchidOrderDispatch(
  db: Db, ctx: WorkspaceContext, id: string, messageId: string | null, error?: string,
): Promise<void> {
  await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    UPDATE orchid_order_dispatches SET
      status = ${error ? "failed" : "sent"},
      zalo_message_id = ${messageId}, error = ${error?.slice(0, 500) ?? null}, updated_at = now()
    WHERE id = ${id}`));
}
