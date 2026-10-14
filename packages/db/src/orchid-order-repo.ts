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

export async function finishOrchidOrderDispatch(
  db: Db, ctx: WorkspaceContext, id: string, messageId: string | null, error?: string,
): Promise<void> {
  await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    UPDATE orchid_order_dispatches SET
      status = ${error ? "failed" : "sent"},
      zalo_message_id = ${messageId}, error = ${error?.slice(0, 500) ?? null}, updated_at = now()
    WHERE id = ${id}`));
}
