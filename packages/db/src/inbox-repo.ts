import { sql } from "drizzle-orm";
import type { WorkspaceContext } from "@penai/shared";
import type { Db } from "./client.js";
import { withWorkspace } from "./context.js";

// ===== Inbox (0031, 0034): hội thoại + tin nhắn của các kênh cá nhân (Zalo, WhatsApp) =====

/** peer = người ngoài gửi tới (dữ liệu Zalo trước 1.9.0 ghi "zalo") */
export type InboxMessageSource = "zalo" | "peer" | "app" | "agent" | "web" | "mcp" | "api";

export interface InboxMessageInput {
  threadId: string;
  peerKind: "direct" | "group";
  msgId: string;
  direction: "in" | "out";
  source: InboxMessageSource;
  senderId: string;
  senderName: string;
  webUserId?: string | null;
  contentType: string;
  text: string;
  media?: Record<string, unknown> | null;
  meta?: Record<string, unknown> | null;
  sentAt: Date;
  /** Tên hội thoại biết được lúc này (tên người gửi với DM đến, tên nhóm…) — rỗng = giữ nguyên. */
  threadName?: string;
}

export interface InboxThread {
  threadId: string;
  kind: "direct" | "group";
  name: string;
  contactAlias: string;
  profileName: string;
  tags: InboxTag[];
  avatar: string;
  phone: string;
  isContact: boolean;
  hiddenInInbox: boolean;
  customerNote: string;
  customerNoteUpdatedAt: string | null;
  memberCount: number | null;
  lastMessage: string;
  lastMessageAt: string | null;
  lastDirection: string | null;
  unreadCount: number;
  aiMode: "auto" | "off";
  pausedUntil: string | null;
  recallWaitingForCustomer: boolean;
}

export interface InboxTag { id: string; name: string; color: string }

export interface InboxQuickReply { id: string; shortcut: string; title: string; content: string }

function mapQuickReply(row: Raw): InboxQuickReply {
  return { id: String(row.id), shortcut: String(row.shortcut), title: String(row.title), content: String(row.content) };
}

export async function listInboxQuickReplies(db: Db, ctx: WorkspaceContext): Promise<InboxQuickReply[]> {
  const res = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    SELECT id, shortcut, title, content FROM inbox_quick_replies ORDER BY shortcut`));
  return (res.rows as Raw[]).map(mapQuickReply);
}

export async function createInboxQuickReply(
  db: Db, ctx: WorkspaceContext, shortcut: string, title: string, content: string,
): Promise<InboxQuickReply | null> {
  const res = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    INSERT INTO inbox_quick_replies (workspace_id, shortcut, title, content)
    SELECT ${ctx.workspaceId}, ${shortcut}, ${title}, ${content}
    WHERE (SELECT count(*) FROM inbox_quick_replies WHERE workspace_id = ${ctx.workspaceId}) < 200
    ON CONFLICT (workspace_id, shortcut) DO NOTHING
    RETURNING id, shortcut, title, content`));
  const row = res.rows[0] as Raw | undefined;
  return row ? mapQuickReply(row) : null;
}

export async function updateInboxQuickReply(
  db: Db, ctx: WorkspaceContext, id: string, shortcut: string, title: string, content: string,
): Promise<InboxQuickReply | null> {
  const res = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    UPDATE inbox_quick_replies SET shortcut = ${shortcut}, title = ${title}, content = ${content}, updated_at = now()
    WHERE id = ${id} AND workspace_id = ${ctx.workspaceId}
      AND NOT EXISTS (SELECT 1 FROM inbox_quick_replies other
        WHERE other.workspace_id = ${ctx.workspaceId} AND other.shortcut = ${shortcut} AND other.id <> ${id})
    RETURNING id, shortcut, title, content`));
  const row = res.rows[0] as Raw | undefined;
  return row ? mapQuickReply(row) : null;
}

export async function deleteInboxQuickReply(db: Db, ctx: WorkspaceContext, id: string): Promise<boolean> {
  const res = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    DELETE FROM inbox_quick_replies WHERE id = ${id} AND workspace_id = ${ctx.workspaceId} RETURNING id`));
  return res.rows.length > 0;
}

export async function listInboxTags(db: Db, ctx: WorkspaceContext): Promise<InboxTag[]> {
  const res = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    SELECT id, name, color FROM inbox_tags ORDER BY lower(name)`));
  return (res.rows as Raw[]).map((r) => ({ id: String(r.id), name: String(r.name), color: String(r.color) }));
}

export async function createInboxTag(db: Db, ctx: WorkspaceContext, name: string, color = "#2563EB"): Promise<InboxTag> {
  const res = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    INSERT INTO inbox_tags (workspace_id, name, color) VALUES (${ctx.workspaceId}, ${name}, ${color})
    ON CONFLICT (workspace_id, lower(name)) DO UPDATE SET name = inbox_tags.name
    RETURNING id, name, color`));
  const row = res.rows[0] as Raw;
  return { id: String(row.id), name: String(row.name), color: String(row.color) };
}

export async function updateInboxTagColor(db: Db, ctx: WorkspaceContext, tagId: string, color: string): Promise<InboxTag | null> {
  const res = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    UPDATE inbox_tags SET color = ${color} WHERE id = ${tagId} RETURNING id, name, color`));
  const row = res.rows[0] as Raw | undefined;
  return row ? { id: String(row.id), name: String(row.name), color: String(row.color) } : null;
}

export async function deleteInboxTag(db: Db, ctx: WorkspaceContext, tagId: string): Promise<boolean> {
  const res = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    DELETE FROM inbox_tags WHERE id = ${tagId} AND workspace_id = ${ctx.workspaceId} RETURNING id`));
  return res.rows.length > 0;
}

export async function setInboxThreadTags(
  db: Db, ctx: WorkspaceContext, channelId: string, threadId: string, tagIds: string[],
): Promise<InboxTag[] | null> {
  const ids = [...new Set(tagIds)];
  const ok = await withWorkspace(db, ctx, async (tx) => {
    const thread = await tx.execute(sql`SELECT 1 FROM inbox_threads WHERE channel_id = ${channelId} AND thread_id = ${threadId} AND kind = 'direct'`);
    if (!thread.rows.length) return false;
    if (ids.length) {
      const found = await tx.execute(sql`SELECT count(*)::int AS n FROM inbox_tags
        WHERE id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`);
      if (Number((found.rows[0] as Raw).n) !== ids.length) return false;
    }
    await tx.execute(sql`DELETE FROM inbox_thread_tags WHERE channel_id = ${channelId} AND thread_id = ${threadId}`);
    for (const id of ids) await tx.execute(sql`INSERT INTO inbox_thread_tags (workspace_id, channel_id, thread_id, tag_id)
      VALUES (${ctx.workspaceId}, ${channelId}, ${threadId}, ${id})`);
    return true;
  });
  if (!ok) return null;
  const thread = await getInboxThread(db, ctx, channelId, threadId);
  return thread?.tags ?? [];
}

export interface InboxReactionRow {
  icon: string;
  reactorId: string;
  reactorName: string;
  source: string;
  webUserName: string | null;
}

export interface InboxMessageRow {
  id: string;
  threadId: string;
  msgId: string;
  direction: "in" | "out";
  source: InboxMessageSource;
  senderId: string;
  senderName: string;
  webUserId: string | null;
  webUserName: string | null;
  contentType: string;
  text: string;
  media: Record<string, unknown> | null;
  meta: Record<string, unknown> | null;
  sentAt: string;
  /** Cảm xúc trên tin (chỉ có khi truy vấn kèm reactions). */
  reactions?: InboxReactionRow[];
  /** Thả cảm xúc được không (có đủ msgId + cliMsgId — tin lưu từ bản 1.5.0). */
  canReact?: boolean;
  /** Giữ nội dung để người trực xem lại, chỉ làm nhạt khi đã xóa/thu hồi trên Zalo. */
  removed?: "deleted" | "recalled";
  removedAt?: string | null;
}

type Raw = Record<string, unknown>;

/** Resolve display names after merging observed metadata and live listener data. */
export async function inboxPeerNames(db: Db, ctx: WorkspaceContext, channelId: string, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  return withWorkspace(db, ctx, async (tx) => {
    const result = await tx.execute(sql`SELECT t.thread_id,
      COALESCE(NULLIF(pp.display_name, ''), NULLIF(t.contact_alias, ''), NULLIF(t.name, '')) AS display_name
      FROM inbox_threads t
      LEFT JOIN contacts c ON c.channel_id = t.channel_id AND c.external_id = t.thread_id
      LEFT JOIN principal_profiles pp ON pp.principal_id = c.principal_id
      WHERE t.channel_id = ${channelId} AND t.kind = 'direct'
      AND t.thread_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
    return new Map((result.rows as Raw[]).filter((r) => r.display_name).map((r) => [String(r.thread_id), String(r.display_name)]));
  });
}

function iso(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

function mapThread(r: Raw): InboxThread {
  return {
    threadId: String(r.thread_id),
    kind: r.kind === "group" ? "group" : "direct",
    name: String(r.name ?? ""),
    contactAlias: String(r.contact_alias ?? ""),
    profileName: r.kind === "direct" ? String(r.profile_name ?? "") : "",
    tags: Array.isArray(r.inbox_tags) ? (r.inbox_tags as Raw[]).map((tag) => ({ id: String(tag.id), name: String(tag.name), color: String(tag.color) })) : [],
    avatar: String(r.avatar ?? ""),
    phone: String(r.phone ?? ""),
    isContact: r.is_contact === true,
    hiddenInInbox: r.hidden_in_inbox === true,
    customerNote: String(r.customer_note ?? ""),
    customerNoteUpdatedAt: iso(r.customer_note_updated_at),
    memberCount: r.member_count == null ? null : Number(r.member_count),
    lastMessage: String(r.last_message ?? ""),
    lastMessageAt: iso(r.last_message_at),
    lastDirection: (r.last_direction as string | null) ?? null,
    unreadCount: Number(r.unread_count ?? 0),
    aiMode: r.ai_mode === "off" ? "off" : "auto",
    pausedUntil: iso(r.paused_until),
    recallWaitingForCustomer: r.recall_waiting_for_customer === true,
  };
}

function mapReactions(v: unknown): InboxReactionRow[] {
  if (!Array.isArray(v)) return [];
  return (v as Raw[]).map((x) => ({
    icon: String(x.icon ?? ""),
    reactorId: String(x.reactor_id ?? ""),
    reactorName: String(x.reactor_name ?? ""),
    source: String(x.source ?? ""),
    webUserName: (x.web_user_name as string | null) ?? null,
  }));
}

function mapMessage(r: Raw): InboxMessageRow {
  const meta = (r.meta as Record<string, unknown> | null) ?? null;
  return {
    id: String(r.id),
    threadId: String(r.thread_id),
    msgId: String(r.msg_id ?? ""),
    direction: r.direction === "out" ? "out" : "in",
    source: String(r.source) as InboxMessageSource,
    senderId: String(r.sender_id ?? ""),
    senderName: String(r.sender_name ?? ""),
    webUserId: (r.web_user_id as string | null) ?? null,
    webUserName: (r.web_user_name as string | null) ?? null,
    contentType: String(r.content_type ?? "text"),
    text: String(r.text ?? ""),
    media: (r.media as Record<string, unknown> | null) ?? null,
    meta,
    sentAt: iso(r.sent_at) ?? new Date().toISOString(),
    ...(r.reactions !== undefined ? { reactions: mapReactions(r.reactions) } : {}),
    canReact: !meta?.removed && !!r.msg_id && typeof meta?.cliMsgId === "string" && meta.cliMsgId !== "",
    removed: meta?.removed === "recalled" ? "recalled" : meta?.removed === "deleted" ? "deleted" : undefined,
    removedAt: typeof meta?.removedAt === "string" ? meta.removedAt : null,
  };
}

const REACTIONS_SUBQUERY = sql`(SELECT COALESCE(json_agg(json_build_object('icon', zr.icon, 'reactor_id', zr.reactor_id,
    'reactor_name', zr.reactor_name, 'source', zr.source, 'web_user_name', zu.name) ORDER BY zr.updated_at), '[]'::json)
  FROM inbox_reactions zr LEFT JOIN users zu ON zu.id = zr.web_user_id
  WHERE zr.channel_id = m.channel_id AND zr.msg_id = m.msg_id AND m.msg_id <> '')`;

const PREVIEW_LABEL: Record<string, string> = {
  photo: "[Hình ảnh]",
  file: "[File]",
  sticker: "[Sticker]",
  voice: "[Tin nhắn thoại]",
  video: "[Video]",
  link: "[Liên kết]",
  other: "[Nội dung khác]",
};

export function inboxPreview(contentType: string, text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  const label = contentType === "text" ? "" : (PREVIEW_LABEL[contentType] ?? "[Nội dung khác]");
  return (label && t ? `${label} ${t}` : label || t).slice(0, 160);
}

/**
 * Ghi 1 tin nhắn + cập nhật hội thoại. Trùng msg_id → bỏ qua (trả null).
 * `pauseMinutes` > 0 và tin do NGƯỜI gửi đi (web/app) → AI tạm im trong hội thoại đó.
 */
export async function recordInboxMessage(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  input: InboxMessageInput,
  opts: { pauseMinutes?: number; history?: boolean } = {},
): Promise<{ message: InboxMessageRow; thread: InboxThread } | null> {
  // history = tin CŨ nhập về sau khi liên kết: không tăng "chưa đọc", không tạm dừng AI,
  // không đè "tin gần nhất" của hội thoại nếu đã có tin mới hơn.
  const history = opts.history === true;
  return withWorkspace(db, ctx, async (tx) => {
    const ins = await tx.execute(sql`
      INSERT INTO inbox_messages (workspace_id, channel_id, thread_id, msg_id, direction, source,
        sender_id, sender_name, web_user_id, content_type, text, media, meta, sent_at)
      VALUES (${ctx.workspaceId}, ${channelId}, ${input.threadId}, ${input.msgId}, ${input.direction},
        ${input.source}, ${input.senderId}, ${input.senderName}, ${input.webUserId ?? null},
        ${input.contentType}, ${input.text},
        ${input.media ? JSON.stringify(input.media) : null}::jsonb,
        ${input.meta ? JSON.stringify(input.meta) : null}::jsonb, ${input.sentAt.toISOString()})
      ON CONFLICT (channel_id, msg_id) WHERE msg_id <> '' DO NOTHING
      RETURNING *`);
    const row = ins.rows[0] as Raw | undefined;
    if (!row) return null;
    const preview = inboxPreview(input.contentType, input.text);
    const human = !history && input.direction === "out" && (input.source === "web" || input.source === "app");
    const pause =
      human && (opts.pauseMinutes ?? 0) > 0
        ? new Date(Date.now() + (opts.pauseMinutes ?? 0) * 60_000).toISOString()
        : null;
    const unreadInc = input.direction === "in" && !history ? 1 : 0;
    const th = await tx.execute(sql`
      INSERT INTO inbox_threads (workspace_id, channel_id, thread_id, kind, name, last_message,
        last_message_at, last_direction, unread_count, paused_until, updated_at)
      VALUES (${ctx.workspaceId}, ${channelId}, ${input.threadId}, ${input.peerKind},
        ${input.threadName ?? ""}, ${preview}, ${input.sentAt.toISOString()}, ${input.direction},
        ${unreadInc}, ${pause}, now())
      ON CONFLICT (channel_id, thread_id) DO UPDATE SET
        name = CASE WHEN EXCLUDED.name <> '' AND (inbox_threads.name = '' OR
                    (inbox_threads.kind = 'direct' AND (NOT inbox_threads.is_contact OR COALESCE(inbox_threads.contact_alias, '') = '')))
                    THEN EXCLUDED.name ELSE inbox_threads.name END,
        last_message = CASE WHEN inbox_threads.last_message_at IS NOT NULL AND inbox_threads.last_message_at > EXCLUDED.last_message_at
                            THEN inbox_threads.last_message ELSE EXCLUDED.last_message END,
        last_message_at = GREATEST(COALESCE(inbox_threads.last_message_at, EXCLUDED.last_message_at), EXCLUDED.last_message_at),
        last_direction = CASE WHEN inbox_threads.last_message_at IS NOT NULL AND inbox_threads.last_message_at > EXCLUDED.last_message_at
                              THEN inbox_threads.last_direction ELSE EXCLUDED.last_direction END,
        -- Người trả lời (web/app) = đã đọc hết tin trước đó
        unread_count = CASE WHEN ${human} THEN 0 ELSE inbox_threads.unread_count + ${unreadInc} END,
        paused_until = COALESCE(EXCLUDED.paused_until, inbox_threads.paused_until),
        updated_at = now()
      RETURNING *`);
    const msg = mapMessage(row);
    if (msg.webUserId) {
      const u = await tx.execute(sql`SELECT name FROM users WHERE id = ${msg.webUserId}`);
      msg.webUserName = ((u.rows[0] as Raw | undefined)?.name as string | undefined) ?? null;
    }
    return { message: msg, thread: mapThread(th.rows[0] as Raw) };
  });
}

export interface InboxContactInput {
  threadId: string;
  kind: "direct" | "group";
  name: string;
  /** undefined preserves the saved alias; empty string clears it. */
  contactAlias?: string;
  isContact?: boolean;
  avatar?: string;
  phone?: string;
  memberCount?: number;
}

/** Đồng bộ danh bạ (bạn bè + nhóm) vào inbox_threads — không đụng tin nhắn/trạng thái AI. */
export async function upsertInboxContacts(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  items: InboxContactInput[],
): Promise<number> {
  if (!items.length) return 0;
  return withWorkspace(db, ctx, async (tx) => {
    let n = 0;
    for (let i = 0; i < items.length; i += 200) {
      const batch = items.slice(i, i + 200);
      const values = sql.join(
        batch.map(
          (c) =>
            sql`(${ctx.workspaceId}::uuid, ${channelId}::uuid, ${c.threadId}, ${c.kind}, ${c.name}, ${c.contactAlias ?? null}, ${c.avatar ?? ""}, ${c.phone ?? ""}, ${c.isContact ?? true}, ${c.memberCount ?? null}::int, now(), now())`,
        ),
        sql`, `,
      );
      await tx.execute(sql`
        INSERT INTO inbox_threads (workspace_id, channel_id, thread_id, kind, name, contact_alias, avatar, phone,
          is_contact, member_count, synced_at, updated_at)
        VALUES ${values}
        ON CONFLICT (channel_id, thread_id) DO UPDATE SET
          kind = EXCLUDED.kind,
          contact_alias = COALESCE(EXCLUDED.contact_alias, inbox_threads.contact_alias),
          name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE inbox_threads.name END,
          avatar = CASE WHEN EXCLUDED.avatar <> '' THEN EXCLUDED.avatar ELSE inbox_threads.avatar END,
          phone = CASE WHEN EXCLUDED.phone <> '' THEN EXCLUDED.phone ELSE inbox_threads.phone END,
          is_contact = inbox_threads.is_contact OR EXCLUDED.is_contact,
          member_count = COALESCE(EXCLUDED.member_count, inbox_threads.member_count),
          synced_at = now()`);
      n += batch.length;
    }
    await tx.execute(sql`
      UPDATE contacts c
      SET display_name = t.contact_alias
      FROM inbox_threads t
      WHERE c.channel_id = ${channelId}::uuid
        AND c.channel_kind = 'zalo_personal'
        AND t.channel_id = c.channel_id
        AND t.thread_id = c.external_id
        AND t.contact_alias <> ''
        AND c.display_name IS DISTINCT FROM t.contact_alias`);
    return n;
  });
}

/** Cập nhật tên hội thoại (vd tên nhóm tra được sau). */
export async function setInboxThreadName(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  threadId: string,
  name: string,
): Promise<void> {
  if (!name) return;
  await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`UPDATE inbox_threads SET name = ${name}, updated_at = now()
      WHERE channel_id = ${channelId} AND thread_id = ${threadId}`),
  );
}

export async function setInboxThreadHidden(
  db: Db, ctx: WorkspaceContext, channelId: string, threadId: string, hidden: boolean,
): Promise<InboxThread | null> {
  const res = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    UPDATE inbox_threads SET hidden_in_inbox = ${hidden}
    WHERE channel_id = ${channelId} AND thread_id = ${threadId} RETURNING 1`));
  return res.rows.length ? getInboxThread(db, ctx, channelId, threadId) : null;
}

/** Ghi chú riêng cho khách trong đúng kênh; không tạo hội thoại mới và không gửi tin. */
export async function setInboxCustomerNote(
  db: Db, ctx: WorkspaceContext, channelId: string, threadId: string, note: string,
): Promise<InboxThread | null> {
  const res = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    UPDATE inbox_threads SET customer_note = ${note}, customer_note_updated_at = now()
    WHERE workspace_id = ${ctx.workspaceId} AND channel_id = ${channelId}
      AND thread_id = ${threadId} AND kind = 'direct' RETURNING 1`));
  return res.rows.length ? getInboxThread(db, ctx, channelId, threadId) : null;
}

export interface InboxThreadQuery {
  q?: string;
  tagId?: string;
  kind?: "direct" | "group";
  unreadOnly?: boolean;
  /** true = chỉ hội thoại đã có tin nhắn; false = cả danh bạ chưa chat */
  withMessagesOnly?: boolean;
  /** true = chỉ danh bạ (bạn bè / nhóm đang tham gia) */
  contactsOnly?: boolean;
  /** Chỉ dùng khi lọc danh sách Inbox; caller khác bỏ qua để vẫn thấy đủ hội thoại. */
  inboxHidden?: boolean;
  limit?: number;
  offset?: number;
  /** Sắp theo thread_id cố định (phân trang ổn định cho MCP) thay vì tin mới nhất. */
  stableOrder?: boolean;
}

export async function listInboxThreads(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  query: InboxThreadQuery = {},
): Promise<{ threads: InboxThread[]; total: number }> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
  const offset = Math.max(query.offset ?? 0, 0);
  const conds = [sql`t.channel_id = ${channelId}`];
  if (query.kind) conds.push(sql`t.kind = ${query.kind}`);
  if (query.unreadOnly) conds.push(sql`t.unread_count > 0`);
  if (query.withMessagesOnly) conds.push(sql`t.last_message_at IS NOT NULL`);
  if (query.contactsOnly) conds.push(sql`t.is_contact = true`);
  if (query.inboxHidden !== undefined) conds.push(sql`t.hidden_in_inbox = ${query.inboxHidden}`);
  if (query.tagId) conds.push(sql`EXISTS (SELECT 1 FROM inbox_thread_tags itt
    WHERE itt.channel_id = t.channel_id AND itt.thread_id = t.thread_id AND itt.tag_id = ${query.tagId}::uuid)`);
  const q = query.q?.trim();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conds.push(sql`(t.name ILIKE ${like} OR t.contact_alias ILIKE ${like} OR pp.display_name ILIKE ${like} OR t.thread_id LIKE ${like} OR t.phone LIKE ${like})`);
  }
  const where = sql.join(conds, sql` AND `);
  const order = query.stableOrder
    ? sql`t.thread_id ASC`
    : sql`t.last_message_at DESC NULLS LAST, t.name ASC`;
  const from = sql`FROM inbox_threads t
    LEFT JOIN contacts c ON c.channel_id = t.channel_id AND c.external_id = t.thread_id
    LEFT JOIN principal_profiles pp ON pp.principal_id = c.principal_id`;
  const tags = sql`LEFT JOIN LATERAL (SELECT COALESCE(json_agg(json_build_object('id', it.id, 'name', it.name, 'color', it.color)
    ORDER BY lower(it.name)), '[]'::json) AS inbox_tags FROM inbox_thread_tags itt
    JOIN inbox_tags it ON it.id = itt.tag_id WHERE itt.channel_id = t.channel_id AND itt.thread_id = t.thread_id) td ON true`;
  return withWorkspace(db, ctx, async (tx) => {
    const rows = await tx.execute(
      sql`SELECT t.*, pp.display_name AS profile_name, td.inbox_tags ${from} ${tags}
        WHERE ${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
    );
    const cnt = await tx.execute(sql`SELECT count(*)::int AS n ${from} WHERE ${where}`);
    return {
      threads: (rows.rows as Raw[]).map(mapThread),
      total: Number((cnt.rows[0] as Raw | undefined)?.n ?? 0),
    };
  });
}

/** Toàn bộ danh bạ + hội thoại Zalo của 1 kênh (xuất Excel), tối đa 100.000 dòng. */
export async function listAllInboxThreads(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
): Promise<InboxThread[]> {
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`SELECT t.*, pp.display_name AS profile_name, td.inbox_tags FROM inbox_threads t
      LEFT JOIN contacts c ON c.channel_id = t.channel_id AND c.external_id = t.thread_id
      LEFT JOIN principal_profiles pp ON pp.principal_id = c.principal_id
      LEFT JOIN LATERAL (SELECT COALESCE(json_agg(json_build_object('id', it.id, 'name', it.name, 'color', it.color)
        ORDER BY lower(it.name)), '[]'::json) AS inbox_tags FROM inbox_thread_tags itt
        JOIN inbox_tags it ON it.id = itt.tag_id WHERE itt.channel_id = t.channel_id AND itt.thread_id = t.thread_id) td ON true
      WHERE t.channel_id = ${channelId}
      ORDER BY t.kind, t.last_message_at DESC NULLS LAST, t.name LIMIT 100000`),
  );
  return (res.rows as Raw[]).map(mapThread);
}

export async function getInboxThread(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  threadId: string,
): Promise<InboxThread | null> {
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`SELECT t.*, pp.display_name AS profile_name, td.inbox_tags FROM inbox_threads t
      LEFT JOIN contacts c ON c.channel_id = t.channel_id AND c.external_id = t.thread_id
      LEFT JOIN principal_profiles pp ON pp.principal_id = c.principal_id
      LEFT JOIN LATERAL (SELECT COALESCE(json_agg(json_build_object('id', it.id, 'name', it.name, 'color', it.color)
        ORDER BY lower(it.name)), '[]'::json) AS inbox_tags FROM inbox_thread_tags itt
        JOIN inbox_tags it ON it.id = itt.tag_id WHERE itt.channel_id = t.channel_id AND itt.thread_id = t.thread_id) td ON true
      WHERE t.channel_id = ${channelId} AND t.thread_id = ${threadId}`),
  );
  const r = res.rows[0] as Raw | undefined;
  return r ? mapThread(r) : null;
}

export async function listInboxMessages(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  threadId: string,
  opts: { beforeId?: string; limit?: number; maxLimit?: number } = {},
): Promise<InboxMessageRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), opts.maxLimit ?? 200);
  const before = opts.beforeId && /^\d+$/.test(opts.beforeId) ? sql`AND m.id < ${opts.beforeId}::bigint` : sql``;
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`
      SELECT m.*, u.name AS web_user_name, ${REACTIONS_SUBQUERY} AS reactions FROM inbox_messages m
      LEFT JOIN users u ON u.id = m.web_user_id
      WHERE m.channel_id = ${channelId} AND m.thread_id = ${threadId} ${before}
      ORDER BY m.id DESC LIMIT ${limit}`),
  );
  return (res.rows as Raw[]).map(mapMessage).reverse();
}

/** Duyệt toàn bộ lịch sử của một hội thoại để tìm tin hoặc xem lại media cũ. */
export async function browseInboxThreadMessages(
  db: Db, ctx: WorkspaceContext, channelId: string, threadId: string,
  opts: { category?: "all" | "media" | "photo" | "video" | "file" | "link"; query?: string; sender?: string; direction?: "in" | "out"; beforeId?: string; limit?: number } = {},
): Promise<{ messages: InboxMessageRow[]; nextBefore: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 100);
  const conds = [sql`m.channel_id = ${channelId}`, sql`m.thread_id = ${threadId}`];
  if (opts.beforeId && /^\d{1,19}$/.test(opts.beforeId)) conds.push(sql`m.id < ${opts.beforeId}::bigint`);
  if (opts.direction) conds.push(sql`m.direction = ${opts.direction}`);
  if (opts.category === "photo" || opts.category === "video" || opts.category === "file") conds.push(sql`m.content_type = ${opts.category}`);
  if (opts.category === "media") conds.push(sql`m.content_type IN ('photo', 'video')`);
  if (opts.category === "link") conds.push(sql`(m.content_type = 'link' OR (m.content_type = 'text' AND m.text ~* 'https?://'))`);
  const query = opts.query?.trim();
  if (query) {
    const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conds.push(sql`(m.text ILIKE ${like} OR m.sender_name ILIKE ${like}
      OR COALESCE(u.name, '') ILIKE ${like} OR COALESCE(m.media->>'name', '') ILIKE ${like})`);
  }
  const sender = opts.sender?.trim();
  if (sender) {
    const like = `%${sender.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conds.push(sql`(m.sender_name ILIKE ${like} OR COALESCE(u.name, '') ILIKE ${like})`);
  }
  const where = sql.join(conds, sql` AND `);
  const res = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    SELECT m.*, u.name AS web_user_name FROM inbox_messages m
    LEFT JOIN users u ON u.id = m.web_user_id
    WHERE ${where} ORDER BY m.id DESC LIMIT ${limit + 1}`));
  const rows = (res.rows as Raw[]).map(mapMessage);
  const hasMore = rows.length > limit;
  const messages = rows.slice(0, limit);
  return { messages, nextBefore: hasMore ? messages[messages.length - 1]!.id : null };
}

export async function listInboxThreadSenders(
  db: Db, ctx: WorkspaceContext, channelId: string, threadId: string,
): Promise<string[]> {
  const res = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    SELECT DISTINCT COALESCE(NULLIF(u.name, ''), NULLIF(m.sender_name, '')) AS name
    FROM inbox_messages m LEFT JOIN users u ON u.id = m.web_user_id
    WHERE m.channel_id = ${channelId} AND m.thread_id = ${threadId}
    ORDER BY name LIMIT 100`));
  return (res.rows as Raw[]).map((r) => String(r.name ?? "")).filter(Boolean);
}

/** Tin xung quanh một kết quả tìm kiếm để mở đúng đoạn hội thoại. */
export async function inboxMessageContext(
  db: Db, ctx: WorkspaceContext, channelId: string, threadId: string, messageId: string,
): Promise<InboxMessageRow[]> {
  if (!/^\d{1,19}$/.test(messageId)) return [];
  const res = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    SELECT m.*, u.name AS web_user_name, ${REACTIONS_SUBQUERY} AS reactions
    FROM inbox_messages m LEFT JOIN users u ON u.id = m.web_user_id
    WHERE m.channel_id = ${channelId} AND m.thread_id = ${threadId}
      AND m.id IN (
        SELECT id FROM inbox_messages WHERE channel_id = ${channelId} AND thread_id = ${threadId}
          AND id <= ${messageId}::bigint ORDER BY id DESC LIMIT 25)
       OR (m.channel_id = ${channelId} AND m.thread_id = ${threadId}
         AND m.id IN (SELECT id FROM inbox_messages WHERE channel_id = ${channelId} AND thread_id = ${threadId}
           AND id > ${messageId}::bigint ORDER BY id ASC LIMIT 25))
    ORDER BY m.id ASC`));
  return (res.rows as Raw[]).map(mapMessage);
}

export async function countInboxMessages(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  threadId: string,
): Promise<number> {
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`SELECT count(*)::int AS n FROM inbox_messages WHERE channel_id = ${channelId} AND thread_id = ${threadId}`),
  );
  return Number((res.rows[0] as Raw | undefined)?.n ?? 0);
}

/** Tìm tin nhắn theo nội dung (không phân biệt hoa thường), mới nhất trước. */
export async function searchInboxMessages(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  query: string,
  opts: { threadId?: string; limit?: number; since?: Date } = {},
): Promise<Array<InboxMessageRow & { threadName: string; threadKind: "direct" | "group" }>> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const like = `%${query.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const byThread = opts.threadId ? sql`AND m.thread_id = ${opts.threadId}` : sql``;
  const since = opts.since ? sql`AND m.sent_at >= ${opts.since.toISOString()}` : sql``;
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`
      SELECT m.*, u.name AS web_user_name, t.name AS thread_name, t.kind AS thread_kind
      FROM inbox_messages m
      LEFT JOIN users u ON u.id = m.web_user_id
      LEFT JOIN inbox_threads t ON t.channel_id = m.channel_id AND t.thread_id = m.thread_id
      WHERE m.channel_id = ${channelId} AND m.text ILIKE ${like} ${byThread} ${since}
      ORDER BY m.id DESC LIMIT ${limit}`),
  );
  return (res.rows as Raw[]).map((r) => ({
    ...mapMessage(r),
    threadName: String(r.thread_name ?? ""),
    threadKind: r.thread_kind === "group" ? "group" : "direct",
  }));
}

/** 1 tin theo id nội bộ (kèm cảm xúc). */
export async function getInboxMessageById(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  threadId: string,
  id: string,
): Promise<InboxMessageRow | null> {
  if (!/^\d{1,19}$/.test(id)) return null;
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`SELECT m.*, u.name AS web_user_name, ${REACTIONS_SUBQUERY} AS reactions FROM inbox_messages m
      LEFT JOIN users u ON u.id = m.web_user_id
      WHERE m.channel_id = ${channelId} AND m.thread_id = ${threadId} AND m.id = ${id}::bigint`),
  );
  const r = res.rows[0] as Raw | undefined;
  return r ? mapMessage(r) : null;
}

/** Tìm tin nền tảng đã gửi trong đúng kênh và hội thoại để giải tham chiếu Zalo. */
export async function getInboxMessageByMsgId(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  threadId: string,
  msgId: string,
): Promise<InboxMessageRow | null> {
  if (!msgId || msgId.length > 100) return null;
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`SELECT m.*, u.name AS web_user_name FROM inbox_messages m
      LEFT JOIN users u ON u.id = m.web_user_id
      WHERE m.channel_id = ${channelId} AND m.thread_id = ${threadId} AND m.msg_id = ${msgId}`),
  );
  const r = res.rows[0] as Raw | undefined;
  return r ? mapMessage(r) : null;
}

/** Resolve a Zalo quote when the platform reports globalMsgId=0 for a photo. */
export async function getInboxMessageByCliMsgId(
  db: Db, ctx: WorkspaceContext, channelId: string, threadId: string, cliMsgId: string,
): Promise<InboxMessageRow | null> {
  if (!/^\d{1,30}$/.test(cliMsgId) || cliMsgId === "0") return null;
  const res = await withWorkspace(db, ctx, tx => tx.execute(sql`
    SELECT m.*, u.name AS web_user_name FROM inbox_messages m
    LEFT JOIN users u ON u.id = m.web_user_id
    WHERE m.channel_id = ${channelId} AND m.thread_id = ${threadId}
      AND m.meta->>'cliMsgId' = ${cliMsgId} AND m.content_type = 'photo'
    ORDER BY m.id DESC LIMIT 1`));
  const row = res.rows[0] as Raw | undefined;
  return row ? mapMessage(row) : null;
}

/** Giữ tin trong Inbox nhưng đánh dấu trạng thái sau khi Zalo xác nhận xóa/thu hồi. */
export async function markInboxMessageRemoved(
  db: Db, ctx: WorkspaceContext, channelId: string, threadId: string,
  lookup: { id?: string; msgId?: string }, removed: "deleted" | "recalled",
): Promise<InboxMessageRow | null> {
  if (lookup.id && !/^\d{1,19}$/.test(lookup.id)) return null;
  if (!lookup.id && (!lookup.msgId || lookup.msgId.length > 100)) return null;
  const locator = lookup.id ? sql`m.id = ${lookup.id}::bigint` : sql`m.msg_id = ${lookup.msgId}`;
  return withWorkspace(db, ctx, async (tx) => {
    const res = await tx.execute(sql`UPDATE inbox_messages AS m
      SET meta = COALESCE(m.meta, '{}'::jsonb) || jsonb_build_object(
        'removed', ${removed}::text, 'removedAt', now()::text)
      WHERE m.channel_id = ${channelId} AND m.thread_id = ${threadId}
        AND ${locator} AND COALESCE(m.meta->>'removed', '') = ''
      RETURNING m.*`);
    const row = res.rows[0] as Raw | undefined;
    if (!row) return null;
    await tx.execute(sql`UPDATE inbox_threads SET last_message = ${removed === "recalled" ? "[Đã thu hồi]" : "[Đã xóa]"}, updated_at = now()
      WHERE channel_id = ${channelId} AND thread_id = ${threadId}
        AND last_message_at = ${iso(row.sent_at)}::timestamptz
        AND last_message = ${inboxPreview(String(row.content_type ?? "text"), String(row.text ?? ""))}`);
    return mapMessage(row);
  });
}

/** Bổ sung cliMsgId vào meta của tin đã lưu (bản dội lại của tin PenAI gửi). Trả tin sau cập nhật. */
export async function setInboxMessageCliId(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  msgId: string,
  cliMsgId: string,
): Promise<InboxMessageRow | null> {
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`UPDATE inbox_messages SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('cliMsgId', ${cliMsgId}::text)
      WHERE channel_id = ${channelId} AND msg_id = ${msgId} AND msg_id <> '' RETURNING *`),
  );
  const r = res.rows[0] as Raw | undefined;
  return r ? mapMessage(r) : null;
}

/** Bản dội lại Zalo bổ sung nội dung ảnh gốc để Inbox có thể trả lời trích dẫn ảnh đã gửi. */
export async function setInboxMessageQuoteSource(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  msgId: string,
  source: Record<string, unknown>,
): Promise<InboxMessageRow | null> {
  if (!msgId) return null;
  const res = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    UPDATE inbox_messages SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('zaloQuoteSource', ${JSON.stringify(source)}::jsonb)
    WHERE channel_id = ${channelId} AND msg_id = ${msgId} AND msg_id <> '' RETURNING *`));
  const r = res.rows[0] as Raw | undefined;
  return r ? mapMessage(r) : null;
}

/** N tin mới nhất KHÁCH gửi (direction in) còn thả cảm xúc được, mới nhất trước. */
export async function latestIncomingInboxMessages(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  threadId: string,
  count: number,
): Promise<InboxMessageRow[]> {
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`SELECT m.* FROM inbox_messages m
      WHERE m.channel_id = ${channelId} AND m.thread_id = ${threadId} AND m.direction = 'in'
        AND m.msg_id <> '' AND COALESCE(m.meta->>'cliMsgId', '') <> ''
      ORDER BY m.id DESC LIMIT ${Math.min(Math.max(count, 1), 20)}`),
  );
  return (res.rows as Raw[]).map(mapMessage);
}

/**
 * Ghi cảm xúc: icon rỗng = gỡ. Nguồn PenAI (web/auto/mcp) giữ nguyên khi bản dội lại
 * từ listener (app) tới sau với cùng icon. Trả danh sách cảm xúc hiện tại của tin.
 */
export async function upsertInboxReaction(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  input: {
    threadId: string;
    msgId: string;
    reactorId: string;
    reactorName: string;
    icon: string;
    source: string;
    webUserId?: string | null;
  },
): Promise<InboxReactionRow[]> {
  return withWorkspace(db, ctx, async (tx) => {
    if (!input.icon) {
      await tx.execute(sql`DELETE FROM inbox_reactions WHERE channel_id = ${channelId}
        AND msg_id = ${input.msgId} AND reactor_id = ${input.reactorId}`);
    } else {
      await tx.execute(sql`INSERT INTO inbox_reactions (workspace_id, channel_id, thread_id, msg_id, reactor_id,
          reactor_name, icon, source, web_user_id, updated_at)
        VALUES (${ctx.workspaceId}, ${channelId}, ${input.threadId}, ${input.msgId}, ${input.reactorId},
          ${input.reactorName}, ${input.icon}, ${input.source}, ${input.webUserId ?? null}, now())
        ON CONFLICT (channel_id, msg_id, reactor_id) DO UPDATE SET
          reactor_name = CASE WHEN EXCLUDED.reactor_name <> '' THEN EXCLUDED.reactor_name ELSE inbox_reactions.reactor_name END,
          source = CASE WHEN EXCLUDED.source = 'app' AND inbox_reactions.icon = EXCLUDED.icon
                        THEN inbox_reactions.source ELSE EXCLUDED.source END,
          web_user_id = CASE WHEN EXCLUDED.source = 'app' AND inbox_reactions.icon = EXCLUDED.icon
                        THEN inbox_reactions.web_user_id ELSE EXCLUDED.web_user_id END,
          icon = EXCLUDED.icon,
          updated_at = now()`);
    }
    const res = await tx.execute(sql`SELECT zr.icon, zr.reactor_id, zr.reactor_name, zr.source, zu.name AS web_user_name
      FROM inbox_reactions zr LEFT JOIN users zu ON zu.id = zr.web_user_id
      WHERE zr.channel_id = ${channelId} AND zr.msg_id = ${input.msgId} ORDER BY zr.updated_at`);
    return mapReactions(res.rows);
  });
}

export async function markInboxThreadRead(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  threadId: string,
): Promise<void> {
  await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`UPDATE inbox_threads SET unread_count = 0
      WHERE channel_id = ${channelId} AND thread_id = ${threadId} AND unread_count <> 0`),
  );
}

/** Bật/tắt AI theo hội thoại; resume=true xóa tạm dừng do nhân viên vừa trả lời. */
export async function setInboxThreadAi(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  threadId: string,
  input: { mode?: "auto" | "off"; resume?: boolean; kind?: "direct" | "group" },
): Promise<InboxThread | null> {
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`
      INSERT INTO inbox_threads (workspace_id, channel_id, thread_id, kind, ai_mode, updated_at)
      VALUES (${ctx.workspaceId}, ${channelId}, ${threadId}, ${input.kind ?? "direct"}, ${input.mode ?? "auto"}, now())
      ON CONFLICT (channel_id, thread_id) DO UPDATE SET
        ai_mode = COALESCE(${input.mode ?? null}, inbox_threads.ai_mode),
        paused_until = CASE WHEN ${input.resume === true} THEN NULL ELSE inbox_threads.paused_until END,
        recall_waiting_for_customer = CASE WHEN ${input.resume === true} THEN false ELSE inbox_threads.recall_waiting_for_customer END,
        agent_recalled_at = CASE WHEN ${input.resume === true} THEN NULL ELSE inbox_threads.agent_recalled_at END,
        updated_at = now()
      RETURNING *`),
  );
  const r = res.rows[0] as Raw | undefined;
  return r ? mapThread(r) : null;
}

/** AI có được trả lời trong hội thoại này lúc này không (tắt tay / đang tạm dừng). */
/** Bỏ mọi lượt "AI tạm dừng" đang treo của một kênh (khi quản trị đặt số phút tạm dừng về 0). */
export async function clearInboxPauses(db: Db, ctx: WorkspaceContext, channelId: string): Promise<number> {
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`UPDATE inbox_threads SET paused_until = NULL, updated_at = now()
      WHERE channel_id = ${channelId} AND paused_until IS NOT NULL`),
  );
  return res.rowCount ?? 0;
}

export async function getInboxThreadAgentBlock(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  threadId: string,
): Promise<"off" | "paused" | "recalled" | null> {
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`SELECT ai_mode, paused_until, recall_waiting_for_customer FROM inbox_threads
      WHERE channel_id = ${channelId} AND thread_id = ${threadId}`),
  );
  const r = res.rows[0] as Raw | undefined;
  if (!r) return null;
  if (r.ai_mode === "off") return "off";
  if (r.paused_until && new Date(String(r.paused_until)).getTime() > Date.now()) return "paused";
  if (r.recall_waiting_for_customer === true) return "recalled";
  return null;
}

/** Thu hồi chỉ kích hoạt chế độ chờ khi đúng tin Agent đã gửi trong hội thoại này. */
export async function markAgentMessageRecalled(
  db: Db, ctx: WorkspaceContext, channelId: string, threadId: string, msgId: string,
): Promise<boolean> {
  if (!msgId || msgId.length > 100) return false;
  const result = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    UPDATE inbox_threads t SET recall_waiting_for_customer = true,
      agent_recalled_at = now(), updated_at = now()
    WHERE t.channel_id = ${channelId} AND t.thread_id = ${threadId}
      AND EXISTS (SELECT 1 FROM inbox_messages m
        WHERE m.channel_id = t.channel_id AND m.thread_id = t.thread_id
          AND m.msg_id = ${msgId} AND m.direction = 'out' AND m.source = 'agent')
    RETURNING t.thread_id`));
  return result.rows.length > 0;
}

/** Chỉ tin khách gửi SAU thu hồi mới kết thúc chế độ chờ. */
export async function resumeAgentAfterCustomerRequest(
  db: Db, ctx: WorkspaceContext, channelId: string, threadId: string, sentAt: Date,
): Promise<boolean> {
  const result = await withWorkspace(db, ctx, (tx) => tx.execute(sql`
    UPDATE inbox_threads SET recall_waiting_for_customer = false,
      agent_recalled_at = NULL, updated_at = now()
    WHERE channel_id = ${channelId} AND thread_id = ${threadId}
      AND recall_waiting_for_customer = true AND agent_recalled_at <= ${sentAt.toISOString()}
      AND ai_mode = 'auto' AND (paused_until IS NULL OR paused_until <= now())
    RETURNING thread_id`));
  return result.rows.length > 0;
}

/** Dọn tin nhắn cũ hơn N ngày (0 = giữ mãi). */
export async function pruneInboxMessages(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  days: number,
): Promise<number> {
  if (!(days > 0)) return 0;
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`DELETE FROM inbox_messages WHERE channel_id = ${channelId}
      AND sent_at < now() - make_interval(days => ${Math.floor(days)})`),
  );
  return res.rowCount ?? 0;
}

// ===== Member được trực kênh Zalo nào =====

/** Quyền xem Inbox, độc lập với quyền sử dụng kênh qua MCP. */
export async function listInboxUserAccess(db: Db, ctx: WorkspaceContext): Promise<Array<{ channelId: string; userId: string }>> {
  const res = await withWorkspace(db, ctx, (tx) => tx.execute(sql`SELECT channel_id, user_id FROM inbox_user_access`));
  return (res.rows as Raw[]).map((r) => ({ channelId: String(r.channel_id), userId: String(r.user_id) }));
}

export async function listUserInboxAccessIds(db: Db, ctx: WorkspaceContext, userId: string): Promise<string[]> {
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`SELECT channel_id FROM inbox_user_access WHERE user_id = ${userId}`),
  );
  return (res.rows as Raw[]).map((r) => String(r.channel_id));
}

export async function setUserInboxAccess(db: Db, ctx: WorkspaceContext, userId: string, channelIds: string[]): Promise<string[]> {
  return withWorkspace(db, ctx, async (tx) => {
    const ids = [...new Set(channelIds.filter((x) => /^[0-9a-f-]{36}$/i.test(x)))];
    const valid = ids.length
      ? ((await tx.execute(sql`SELECT id FROM channels WHERE kind IN ('zalo_personal', 'whatsapp_personal')
          AND id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`)).rows as Raw[]).map((r) => String(r.id))
      : [];
    await tx.execute(sql`DELETE FROM inbox_user_access WHERE user_id = ${userId}`);
    for (const channelId of valid) {
      await tx.execute(sql`INSERT INTO inbox_user_access (workspace_id, channel_id, user_id, granted_by)
        VALUES (${ctx.workspaceId}, ${channelId}, ${userId}, ${ctx.userId}) ON CONFLICT DO NOTHING`);
    }
    return valid;
  });
}

export async function listInboxChannelMembers(
  db: Db,
  ctx: WorkspaceContext,
): Promise<Array<{ channelId: string; userId: string }>> {
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`SELECT channel_id, user_id FROM inbox_channel_members`),
  );
  return (res.rows as Raw[]).map((r) => ({ channelId: String(r.channel_id), userId: String(r.user_id) }));
}

export async function listUserInboxChannelIds(
  db: Db,
  ctx: WorkspaceContext,
  userId: string,
): Promise<string[]> {
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`SELECT channel_id FROM inbox_channel_members WHERE user_id = ${userId}`),
  );
  return (res.rows as Raw[]).map((r) => String(r.channel_id));
}

/** Đặt LẠI danh sách kênh member được trực. Chỉ nhận kênh cá nhân có Inbox (Zalo, WhatsApp). */
export async function setUserInboxChannels(
  db: Db,
  ctx: WorkspaceContext,
  userId: string,
  channelIds: string[],
): Promise<string[]> {
  return withWorkspace(db, ctx, async (tx) => {
    const ids = [...new Set(channelIds.filter((x) => /^[0-9a-f-]{36}$/i.test(x)))];
    const valid = ids.length
      ? (
          (
            await tx.execute(sql`SELECT id FROM channels WHERE kind IN ('zalo_personal', 'whatsapp_personal')
              AND id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`)
          ).rows as Raw[]
        ).map((r) => String(r.id))
      : [];
    await tx.execute(sql`DELETE FROM inbox_channel_members WHERE user_id = ${userId}`);
    for (const channelId of valid) {
      await tx.execute(sql`INSERT INTO inbox_channel_members (workspace_id, channel_id, user_id, granted_by)
        VALUES (${ctx.workspaceId}, ${channelId}, ${userId}, ${ctx.userId}) ON CONFLICT DO NOTHING`);
    }
    return valid;
  });
}

// ===== Chống gửi trùng qua MCP (request_id) =====

export interface McpSendRecord {
  requestId: string;
  payloadHash: string;
  tool: string;
  status: "pending" | "sent" | "failed" | "unknown";
  result: Record<string, unknown> | null;
  updatedAt: string;
}

export async function getMcpServerSend(
  db: Db,
  ctx: WorkspaceContext,
  principal: string,
  requestId: string,
): Promise<McpSendRecord | null> {
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`SELECT * FROM mcp_server_sends WHERE principal = ${principal} AND request_id = ${requestId}`),
  );
  const r = res.rows[0] as Raw | undefined;
  if (!r) return null;
  return {
    requestId: String(r.request_id),
    payloadHash: String(r.payload_hash),
    tool: String(r.tool),
    status: r.status as McpSendRecord["status"],
    result: (r.result as Record<string, unknown> | null) ?? null,
    updatedAt: iso(r.updated_at) ?? "",
  };
}

/** Ghi lượt gửi 'pending'. Trả false nếu request_id đã tồn tại (cạnh tranh). */
export async function insertMcpServerSend(
  db: Db,
  ctx: WorkspaceContext,
  input: { principal: string; requestId: string; payloadHash: string; tool: string; channelId: string; recipient: string },
): Promise<boolean> {
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`INSERT INTO mcp_server_sends (workspace_id, principal, request_id, payload_hash, tool,
        channel_id, recipient, status)
      VALUES (${ctx.workspaceId}, ${input.principal}, ${input.requestId}, ${input.payloadHash}, ${input.tool},
        ${input.channelId}, ${input.recipient}, 'pending')
      ON CONFLICT (workspace_id, principal, request_id) DO NOTHING RETURNING id`),
  );
  return res.rows.length > 0;
}

export async function finishMcpServerSend(
  db: Db,
  ctx: WorkspaceContext,
  principal: string,
  requestId: string,
  status: "sent" | "failed" | "unknown",
  result: Record<string, unknown>,
  recipient?: string,
): Promise<void> {
  await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`UPDATE mcp_server_sends SET status = ${status}, result = ${JSON.stringify(result)}::jsonb,
        recipient = COALESCE(${recipient ?? null}, recipient), updated_at = now()
      WHERE principal = ${principal} AND request_id = ${requestId}`),
  );
}

export async function listRecentMcpServerSends(
  db: Db,
  ctx: WorkspaceContext,
  opts: { userId?: string; limit?: number } = {},
): Promise<Array<{ requestId: string; tool: string; recipient: string; status: string; clientName: string; createdAt: string }>> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const byUser = opts.userId ? sql`AND s.principal LIKE ${`${opts.userId}:%`}` : sql``;
  const res = await withWorkspace(db, ctx, (tx) =>
    tx.execute(sql`SELECT s.request_id, s.tool, s.recipient, s.status, s.created_at,
        c.metadata->>'client_name' AS client_name
      FROM mcp_server_sends s
      LEFT JOIN mcp_oauth_clients c ON c.id = split_part(s.principal, ':', 2)
      WHERE true ${byUser} ORDER BY s.created_at DESC LIMIT ${limit}`),
  );
  return (res.rows as Raw[]).map((r) => ({
    requestId: String(r.request_id),
    tool: String(r.tool),
    recipient: String(r.recipient ?? ""),
    status: String(r.status),
    clientName: String(r.client_name ?? ""),
    createdAt: iso(r.created_at) ?? "",
  }));
}
