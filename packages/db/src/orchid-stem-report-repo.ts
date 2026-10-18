import { sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";

export interface OrchidStemMessage {
  msgId: string;
  senderId: string;
  senderName: string;
  text: string;
  sentAt: string;
}

/** Read the durable Inbox log. Its (channel_id, msg_id) uniqueness prevents duplicate Zalo events. */
export async function listOrchidStemMessages(db: Db, ctx: WorkspaceContext, channelId: string,
  threadId: string, start: Date, end: Date): Promise<OrchidStemMessage[]> {
  const result = await withWorkspace(db, ctx, tx => tx.execute(sql`
    SELECT msg_id, sender_id, sender_name, text, sent_at
    FROM inbox_messages
    WHERE workspace_id = ${ctx.workspaceId} AND channel_id = ${channelId}
      AND thread_id = ${threadId} AND direction = 'in' AND msg_id <> ''
      AND sent_at >= ${start.toISOString()} AND sent_at < ${end.toISOString()}
      AND btrim(text) <> '' AND COALESCE(meta->>'removed', '') = ''
    ORDER BY sent_at, id`));
  return result.rows.map(row => ({
    msgId: String(row.msg_id), senderId: String(row.sender_id),
    senderName: String(row.sender_name), text: String(row.text),
    sentAt: new Date(String(row.sent_at)).toISOString(),
  }));
}
