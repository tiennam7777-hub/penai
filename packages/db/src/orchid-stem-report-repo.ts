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
  contentType?: string;
  quotedMsgId?: string;
  quoteOwnerId?: string;
  inRange?: boolean;
}

/** Read the durable Inbox log. Its (channel_id, msg_id) uniqueness prevents duplicate Zalo events. */
export async function listOrchidStemMessages(db: Db, ctx: WorkspaceContext, channelId: string,
  threadId: string, start: Date, end: Date): Promise<OrchidStemMessage[]> {
  const result = await withWorkspace(db, ctx, tx => tx.execute(sql`
    WITH report_group AS (
      SELECT name FROM inbox_threads
      WHERE workspace_id = ${ctx.workspaceId} AND channel_id = ${channelId} AND thread_id = ${threadId}
        AND kind = 'group' LIMIT 1
    ), group_views AS (
      SELECT t.channel_id, t.thread_id,
        CASE WHEN c.name = 'NV Bán Hàng Hot 1' THEN 0
             WHEN t.channel_id = ${channelId} THEN 1 ELSE 2 END AS priority
      FROM inbox_threads t JOIN channels c ON c.id = t.channel_id
      WHERE t.workspace_id = ${ctx.workspaceId} AND t.kind = 'group'
        AND c.kind = 'zalo_personal' AND t.name = (SELECT name FROM report_group)
    ), group_messages AS (
      SELECT m.*, v.priority
      FROM inbox_messages m JOIN group_views v
        ON v.channel_id = m.channel_id AND v.thread_id = m.thread_id
      WHERE m.workspace_id = ${ctx.workspaceId} AND m.msg_id <> ''
        AND COALESCE(m.meta->>'removed', '') = ''
        AND (m.direction = 'in' OR m.direction = 'out')
        AND m.source IN ('zalo', 'app', 'web', 'mcp')
    ), dated AS (
      SELECT * FROM group_messages
      WHERE sent_at >= ${start.toISOString()} AND sent_at < ${end.toISOString()}
    ), photo_ids AS (
      SELECT DISTINCT msg_id FROM dated WHERE content_type = 'photo'
    ), quote_targets AS (
      SELECT DISTINCT meta->'quote'->>'msgId' AS msg_id FROM dated
      WHERE meta->'quote'->>'msgId' IS NOT NULL
    ), selected AS (
      SELECT * FROM group_messages m
      WHERE (m.sent_at >= ${start.toISOString()} AND m.sent_at < ${end.toISOString()})
         OR (m.content_type = 'photo' AND m.msg_id IN (SELECT msg_id FROM quote_targets))
         OR (m.meta->'quote'->>'msgId' IN (SELECT msg_id FROM photo_ids))
    )
    SELECT DISTINCT ON (m.msg_id) m.msg_id, m.sender_id, m.sender_name, m.text, m.sent_at,
      m.content_type, m.meta->'quote'->>'msgId' AS quoted_msg_id,
      m.meta->'quote'->>'ownerId' AS quote_owner_id,
      (m.sent_at >= ${start.toISOString()} AND m.sent_at < ${end.toISOString()}) AS in_range
    FROM selected m
    ORDER BY m.msg_id, m.priority, m.id`));
  return result.rows.map(row => ({
    msgId: String(row.msg_id), senderId: String(row.sender_id),
    senderName: String(row.sender_name), text: String(row.text),
    sentAt: new Date(String(row.sent_at)).toISOString(),
    contentType: String(row.content_type ?? ""),
    quotedMsgId: String(row.quoted_msg_id ?? ""),
    quoteOwnerId: String(row.quote_owner_id ?? ""),
    inRange: row.in_range === true,
  })).sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.msgId.localeCompare(b.msgId));
}
