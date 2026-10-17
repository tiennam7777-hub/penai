/**
 * Inbox trực chat dùng chung cho các kênh cá nhân (Zalo cá nhân, WhatsApp cá nhân) — 0031, 0034.
 *
 * - Adapter của kênh báo MỌI tin đến/đi (onMessageLog) → lưu inbox_messages
 *   + inbox_threads → đẩy realtime (SSE) cho người đang trực.
 * - Người trực (operator/người kiểm duyệt: mọi kênh; member: kênh được gán) xem hội thoại,
 *   gửi text/ảnh/tài liệu, bật/tắt AI theo hội thoại. Nhân viên trả lời (web hoặc điện
 *   thoại) → AI tạm im trong hội thoại đó `inbox_pause_minutes` phút (mặc định 30).
 * - Dùng chung cho MCP server (mcp-server.ts): gửi tin/ảnh, tra SĐT, danh bạ.
 *
 * Cấu hình theo kênh (channels.config): `inbox` (mặc định true — lưu nội dung),
 * `inbox_pause_minutes` (mặc định 30, 0 = không tạm dừng).
 */
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join, relative, resolve, sep } from "node:path";
import AdmZip from "adm-zip";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { hasRole, logger, type WorkspaceContext } from "@penai/shared";
import {
  clearInboxPauses,
  getChannelById,
  getInboxThread,
  browseInboxThreadMessages,
  inboxMessageContext,
  listInboxThreadSenders,
  listChannels,
  listUserInboxChannelIds,
  listInboxMessages,
  listInboxThreads,
  listInboxTags,
  listInboxQuickReplies,
  createInboxQuickReply,
  updateInboxQuickReply,
  deleteInboxQuickReply,
  createInboxTag,
  updateInboxTagColor,
  deleteInboxTag,
  setInboxThreadTags,
  setInboxThreadHidden,
  setInboxCustomerNote,
  markInboxThreadRead,
  markAgentMessageRecalled,
  markInboxMessageRemoved,
  recordInboxMessage,
  setInboxThreadAi,
  setInboxThreadName,
  updateChannel,
  upsertInboxReaction,
  setInboxMessageCliId,
  setInboxMessageQuoteSource,
  upsertContact,
  getInboxMessageById,
  getInboxMessageByMsgId,
  latestIncomingInboxMessages,
  upsertInboxContacts,
  recordAudit,
  type Db,
  type InboxMessageRow,
  type InboxThread,
} from "@penai/db";
import {
  isPersonalChannel,
  isPersonalChannelKind,
  isValidThreadId,
  personalPlatformLabel,
  type PersonalChannel,
  isZaloReactionKey,
  parseAutoReaction,
  ZALO_REACTIONS,
  type ZaloReactionKey,
  type ChannelReaction,
  type ChannelContact,
  type ChannelMessageLog,
  type ZaloSendSource,
} from "@penai/channels";
import { channelHandlers, runOrchidStaffDelegation } from "./channels-runtime.js";
import { expectsCurrentColorPhotos, latestDelegableStaffRow, promisedPotStemCount, ORCHID_SALES_AGENT_ID, ORCHID_SALES_CHANNEL_IDS } from "./orchid-staff-delegation.js";
import { readPhotoAcknowledgement } from "./photo-burst.js";
import { inboxZaloQuote, type InboxZaloQuote } from "./inbox-quote.js";
import { stemCountForPhoto } from "./orchid-photo-count.js";

// ===== Cấu hình sống theo kênh =====

interface InboxChannelState {
  workspaceId: string;
  enabled: boolean;
  pauseMinutes: number;
}

const inboxState = new Map<string, InboxChannelState>();
const agentRecallHandlers = new Map<string, (threadId: string, peerKind: "direct" | "group") => Promise<void>>();
let inboxDataDir = "";

export function readInboxConfig(config: Record<string, unknown>): {
  enabled: boolean;
  pauseMinutes: number;
  mcpReadMessages: boolean;
  autoReaction: "heart" | "like" | null;
  agentReply: boolean;
  photoAck: "short" | "off";
} {
  const raw = Number(config["inbox_pause_minutes"]);
  return {
    enabled: config["inbox"] !== false,
    pauseMinutes: Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 24 * 60) : 30,
    // Ứng dụng AI bên ngoài (MCP) đọc hội thoại + nội dung tin: MẶC ĐỊNH TẮT, quản trị bật theo từng kênh.
    mcpReadMessages: config["mcp_read_messages"] === true,
    // Tự thả cảm xúc khi khách nhắn (cá nhân + nhóm): MẶC ĐỊNH TẮT.
    autoReaction: parseAutoReaction(config),
    // Công tắc "Agent tự trả lời" (Channels → Sửa): mặc định bật.
    agentReply: config["agent_reply"] !== false,
    photoAck: readPhotoAcknowledgement(config),
  };
}

// ===== SSE: đẩy tin mới cho người đang trực =====

interface SseClient {
  workspaceId: string;
  /** null = mọi kênh (operator trở lên) */
  channelIds: Set<string> | null;
  write: (chunk: string) => void;
}

const sseClients = new Set<SseClient>();

function broadcast(workspaceId: string, channelId: string, event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    if (c.workspaceId !== workspaceId) continue;
    if (c.channelIds && !c.channelIds.has(channelId)) continue;
    try {
      c.write(payload);
    } catch {
      sseClients.delete(c);
    }
  }
}

function broadcastWorkspace(workspaceId: string, event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    if (c.workspaceId !== workspaceId) continue;
    try { c.write(payload); } catch { sseClients.delete(c); }
  }
}

setInterval(() => {
  for (const c of sseClients) {
    try {
      c.write(": ping\n\n");
    } catch {
      sseClients.delete(c);
    }
  }
}, 25_000).unref();

// ===== Hook cho adapter (channels-runtime gọi khi dựng kênh) =====

function ctxOf(workspaceId: string): WorkspaceContext {
  return { workspaceId, userId: workspaceId, role: "ws_admin" };
}

function inboxRuntime(channelId: string): PersonalChannel | null {
  const ch = channelHandlers.get(channelId)?.channel;
  return isPersonalChannel(ch) ? ch : null;
}

/** Tên nền tảng của kênh (Zalo, WhatsApp) để ghi vào thông báo cho người dùng. */
function platformOf(channelId: string): string {
  return personalPlatformLabel(channelHandlers.get(channelId)?.channel.kind ?? "zalo_personal");
}

const groupNameLookups = new Set<string>();

/** Ghi Contacts tối đa 1 lần/phút cho mỗi người/nhóm (nhóm đông tin không làm DB bận). */
const contactSeen = new Map<string, { at: number; name: string }>();
setInterval(() => {
  const cut = Date.now() - 10 * 60_000;
  for (const [k, v] of contactSeen) if (v.at < cut) contactSeen.delete(k);
}, 10 * 60_000).unref();

function recordInboxContact(
  db: Db,
  ctx: WorkspaceContext,
  channelId: string,
  channelKind: string,
  externalId: string,
  name: string,
  kind: "user" | "group",
): void {
  if (!externalId || externalId === "0") return;
  const key = `${channelId}:${externalId}`;
  const prev = contactSeen.get(key);
  if (prev && Date.now() - prev.at < 60_000 && (!name || prev.name === name)) return;
  contactSeen.set(key, { at: Date.now(), name });
  void upsertContact(db, ctx, {
    channelId,
    channelKind,
    externalId,
    ...(name ? { displayName: name } : {}),
    // peer_kind: loại người/nhóm (mọi nền tảng); zalo_kind giữ cho dữ liệu + bản cũ
    metadata: channelKind === "zalo_personal" ? { peer_kind: kind, zalo_kind: kind } : { peer_kind: kind },
  }).catch((err) => logger.warn(`zalo.contact_store lỗi: ${(err as Error).message}`));
}

/** Hook onMessageLog / onContactsSynced / onThreadName… cho 1 kênh cá nhân (Zalo, WhatsApp). */
export function inboxHooks(
  db: Db,
  ch: { id: string; kind: string; workspaceId: string; config: Record<string, unknown> },
  dataDir: string,
  onAgentMessageRecalled?: (threadId: string, peerKind: "direct" | "group") => Promise<void>,
) {
  const cfg = readInboxConfig(ch.config);
  inboxState.set(ch.id, { workspaceId: ch.workspaceId, enabled: cfg.enabled, pauseMinutes: cfg.pauseMinutes });
  if (onAgentMessageRecalled) agentRecallHandlers.set(ch.id, onAgentMessageRecalled);
  const ctx = ctxOf(ch.workspaceId);
  const toInput = (entry: ChannelMessageLog) => ({
    threadId: entry.threadId,
    peerKind: entry.peerKind,
    msgId: entry.msgId,
    direction: entry.direction,
    source: entry.source,
    senderId: entry.senderId,
    senderName: entry.senderName,
    webUserId: entry.webUserId ?? null,
    contentType: entry.contentType,
    text: entry.text,
    media: entry.media ? { ...entry.media } : null,
    meta: entry.meta ?? null,
    sentAt: entry.sentAt,
    threadName: entry.threadName ?? "",
  });
  return {
    // Thư mục giữ phiên đăng nhập của kênh (WhatsApp: khóa thiết bị liên kết)
    stateDir: resolve(join(dataDir, ch.workspaceId, "channel-state", ch.id)),
    saveInboxFile: async (buf: Buffer, ext: string) =>
      saveOutboundImage(dataDir, ch.workspaceId, ch.id, { buf, ext: ext.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "bin" }),
    ...(ORCHID_SALES_CHANNEL_IDS.has(ch.id) ? {
      onSelfCommand: async (threadId: string) => {
        try {
          // Tin hứa gửi từ điện thoại được listener lưu chậm hơn bản dội Zalo một chút.
          await new Promise((resolve) => setTimeout(resolve, 1_700));
          await delegateOrchidStaffPromise(db, ctx, dataDir, ch.id, threadId);
        } catch (error) {
          logger.warn(`zalo.staff_delegate_fail: ${ch.id}/${threadId}: ${String(error)}`);
        }
      },
    } : {}),
    // Tin cũ nền tảng gửi về sau khi liên kết: lưu tuần tự theo thời gian, không tính "chưa đọc"
    onHistory: (entries: ChannelMessageLog[]) => {
      const st = inboxState.get(ch.id);
      if (!st?.enabled) return;
      void (async () => {
        let n = 0;
        for (const entry of entries) {
          const saved = await recordInboxMessage(db, ctx, ch.id, toInput(entry), { history: true }).catch(() => null);
          if (saved) n++;
        }
        logger.info(`inbox.history_import: kênh ${ch.id} lưu ${n}/${entries.length} tin cũ`);
        if (n) broadcast(ch.workspaceId, ch.id, "contacts", { channelId: ch.id, count: n });
      })();
    },
    onMessageLog: (entry: ChannelMessageLog) => {
      // Contacts: MỌI người nhắn tới (tin riêng + người gửi trong nhóm) và cả NHÓM — ghi ngay,
      // không phụ thuộc thread demo / công tắc agent / lưu Inbox (chỉ tên + uid).
      if (entry.direction === "in" && (entry.source === "zalo" || entry.source === "peer")) {
        if (entry.peerKind === "group") {
          recordInboxContact(db, ctx, ch.id, ch.kind, entry.threadId, entry.threadName ?? "", "group");
        }
        recordInboxContact(db, ctx, ch.id, ch.kind, entry.senderId, entry.senderName, "user");
      }
      const st = inboxState.get(ch.id);
      if (!st?.enabled) return;
      void (async () => {
        if (entry.direction === "out" && entry.source === "agent" && entry.contentType === "photo"
          && typeof entry.media?.localPath === "string") {
          const count = await stemCountForPhoto(join(dataDir, ch.workspaceId, "shared"), entry.media.localPath);
          if (count) entry.media.stemCount = count;
        }
        const saved = await recordInboxMessage(db, ctx, ch.id, toInput(entry), { pauseMinutes: st.pauseMinutes });
        if (!saved) return;
        broadcast(ch.workspaceId, ch.id, "message", {
          channelId: ch.id,
          thread: saved.thread,
          message: publicMessage(saved.message, ch.workspaceId),
        });
        // Nhóm chưa có tên → tra 1 lần
        const key = `${ch.id}:${entry.threadId}`;
        if (entry.peerKind === "group" && !saved.thread.name && !groupNameLookups.has(key)) {
          groupNameLookups.add(key);
          const name = await inboxRuntime(ch.id)?.lookupGroupName(entry.threadId);
          if (name) {
            await setInboxThreadName(db, ctx, ch.id, entry.threadId, name);
            recordInboxContact(db, ctx, ch.id, ch.kind, entry.threadId, name, "group");
            broadcast(ch.workspaceId, ch.id, "thread", { channelId: ch.id, thread: { ...saved.thread, name } });
          }
        }
      })().catch((err) => logger.warn(`zalo.inbox_store lỗi: ${(err as Error).message}`));
    },
    onMessageUndo: async (event: { threadId: string; peerKind: "direct" | "group"; targetMsgId: string; isSelf: boolean }) => {
      // Tin gửi được Zalo xác nhận trước khi onMessageLog ghi DB xong; chờ ngắn
      // để một thao tác thu hồi rất nhanh vẫn tìm thấy tin gốc.
      let removed: InboxMessageRow | null = null;
      for (let attempt = 0; attempt < 4 && !removed; attempt++) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 150));
        removed = await markInboxMessageRemoved(db, ctx, ch.id, event.threadId,
          { msgId: event.targetMsgId }, "recalled");
      }
      if (removed) {
        const full = await getInboxMessageById(db, ctx, ch.id, event.threadId, removed.id);
        if (full) broadcast(ch.workspaceId, ch.id, "message_update", {
          channelId: ch.id, threadId: event.threadId, message: publicMessage(full, ch.workspaceId),
        });
        const updatedThread = await getInboxThread(db, ctx, ch.id, event.threadId);
        if (updatedThread) broadcast(ch.workspaceId, ch.id, "thread", { channelId: ch.id, thread: updatedThread });
      }
      if (!event.isSelf) return false;
      let marked = false;
      for (let attempt = 0; attempt < 4 && !marked; attempt++) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 150));
        marked = await markAgentMessageRecalled(db, ctx, ch.id, event.threadId, event.targetMsgId);
      }
      if (!marked) return false;
      await onAgentMessageRecalled?.(event.threadId, event.peerKind);
      const thread = await getInboxThread(db, ctx, ch.id, event.threadId);
      if (thread) broadcast(ch.workspaceId, ch.id, "thread", { channelId: ch.id, thread });
      return true;
    },
    onContactsSynced: async (items: ChannelContact[]) => {
      const n = await upsertInboxContacts(
        db,
        ctx,
        ch.id,
        items.map((i) => ({
          threadId: i.id,
          kind: i.type,
          name: i.name,
          ...(i.contactAlias !== undefined ? { contactAlias: i.contactAlias } : {}),
          ...(i.isContact !== undefined ? { isContact: i.isContact } : {}),
          ...(i.avatar ? { avatar: i.avatar } : {}),
          ...(i.phone ? { phone: i.phone } : {}),
          ...(i.memberCount !== undefined ? { memberCount: i.memberCount } : {}),
        })),
      );
      broadcast(ch.workspaceId, ch.id, "contacts", { channelId: ch.id, count: n });
    },
    onThreadName: (threadId: string, name: string) => {
      void setInboxThreadName(db, ctx, ch.id, threadId, name).catch(() => {});
      recordInboxContact(db, ctx, ch.id, ch.kind, threadId, name, "group");
    },
    onMessageCliId: (msgId: string, cliMsgId: string) => {
      // Bản dội lại có thể tới trước khi tin kịp ghi DB → thử lại sau 3 giây nếu chưa thấy.
      const apply = (retry: boolean) =>
        setInboxMessageCliId(db, ctx, ch.id, msgId, cliMsgId)
          .then((m) => {
            if (m) broadcast(ch.workspaceId, ch.id, "message_update", { channelId: ch.id, threadId: m.threadId, message: publicMessage(m, ch.workspaceId) });
            else if (retry) setTimeout(() => void apply(false), 3_000).unref?.();
          })
          .catch((err) => logger.warn(`zalo.cli_id_store lỗi: ${(err as Error).message}`));
      void apply(true);
    },
    onMessageQuoteSource: (msgId: string, source: Record<string, unknown>) => {
      const apply = (retry: boolean) =>
        setInboxMessageQuoteSource(db, ctx, ch.id, msgId, source)
          .then((m) => {
            if (m) broadcast(ch.workspaceId, ch.id, "message_update", { channelId: ch.id, threadId: m.threadId, message: publicMessage(m, ch.workspaceId) });
            else if (retry) setTimeout(() => void apply(false), 3_000).unref?.();
          })
          .catch((err) => logger.warn(`zalo.quote_source_store lỗi: ${(err as Error).message}`));
      void apply(true);
    },
    onReaction: (r: ChannelReaction) => {
      void upsertInboxReaction(db, ctx, ch.id, {
        threadId: r.threadId,
        msgId: r.targetMsgId,
        reactorId: r.reactorId,
        reactorName: r.reactorName,
        icon: r.icon,
        source: r.source,
        webUserId: r.webUserId ?? null,
      })
        .then((reactions) =>
          broadcast(ch.workspaceId, ch.id, "reaction", { channelId: ch.id, threadId: r.threadId, msgId: r.targetMsgId, reactions }),
        )
        .catch((err) => logger.warn(`zalo.reaction_store lỗi: ${(err as Error).message}`));
    },
  };
}

/**
 * Thả/gỡ cảm xúc vào 1 tin đã lưu (Inbox + MCP). Lỗi rõ ràng:
 * NOT_CONNECTED / MESSAGE_NOT_FOUND / CANNOT_REACT.
 */
export async function reactInboxMessage(
  db: Db,
  ctx: WorkspaceContext,
  input: {
    channelId: string;
    threadId: string;
    messageId: string;
    reaction: ZaloReactionKey;
    source: "web" | "mcp";
    webUserId?: string;
  },
): Promise<void> {
  const err = (code: string, message: string) => Object.assign(new Error(message), { code });
  const rt = inboxRuntime(input.channelId);
  if (!rt?.isConnected()) throw err("NOT_CONNECTED", `Kênh ${platformOf(input.channelId)} chưa kết nối — vào Channels → Kết nối QR để quét lại.`);
  const msg = await getInboxMessageById(db, ctx, input.channelId, input.threadId, input.messageId);
  if (!msg) throw err("MESSAGE_NOT_FOUND", "Không có tin nhắn này trong hội thoại.");
  if (msg.removed) throw err("CANNOT_REACT", "Tin đã xóa hoặc thu hồi nên không thả cảm xúc được.");
  const cli = typeof msg.meta?.cliMsgId === "string" ? msg.meta.cliMsgId : "";
  const needCli = rt.kind === "zalo_personal";
  if (!msg.msgId || (needCli ? !cli : !msg.meta?.waKey)) throw err("CANNOT_REACT", "Tin này không thả cảm xúc được (tin lưu trước bản 1.5.0 hoặc tin do hệ thống gửi).");
  const thread = await getInboxThread(db, ctx, input.channelId, input.threadId);
  await rt.react({
    threadId: input.threadId,
    peerKind: thread?.kind ?? "direct",
    msgId: msg.msgId,
    cliMsgId: cli,
    meta: msg.meta ?? null,
    reaction: input.reaction,
    source: input.source,
    ...(input.webUserId ? { webUserId: input.webUserId } : {}),
  });
}

export { latestIncomingInboxMessages, ZALO_REACTIONS, isZaloReactionKey };

export function forgetInboxChannel(channelId: string): void {
  inboxState.delete(channelId);
  agentRecallHandlers.delete(channelId);
}

// ===== Quyền truy cập kênh =====

/** Moderator thấy mọi kênh trong Inbox; quyền MCP vẫn theo kênh được quản trị gán. */
export async function allowedInboxChannelIds(db: Db, ctx: WorkspaceContext, scope: "inbox" | "mcp" = "inbox"): Promise<string[]> {
  if ((ctx.role === "moderator" && scope === "inbox") || hasRole(ctx.role, "operator")) {
    return (await listChannels(db, ctx)).filter((c) => isPersonalChannelKind(c.kind)).map((c) => c.id);
  }
  if (ctx.role === "member" || ctx.role === "moderator") return listUserInboxChannelIds(db, ctx, ctx.userId);
  return [];
}

export async function canUseInboxChannel(db: Db, ctx: WorkspaceContext, channelId: string): Promise<boolean> {
  return (await allowedInboxChannelIds(db, ctx)).includes(channelId);
}

// ===== Ảnh: nạp từ data URL hoặc URL công khai (chống SSRF) =====

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number) as [number, number, number, number];
    return (
      p[0] === 10 ||
      p[0] === 127 ||
      p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      p[0] >= 224
    );
  }
  if (v === 6) {
    const low = ip.toLowerCase();
    if (low.startsWith("::ffff:")) return isBlockedIp(low.slice(7));
    return low === "::1" || low === "::" || low.startsWith("fc") || low.startsWith("fd") || low.startsWith("fe80");
  }
  return true;
}

/** Nhận diện ảnh theo byte đầu (không tin content-type). */
export function sniffImage(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: "png", mime: "image/png" };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (buf.length >= 6 && (buf.subarray(0, 6).toString("ascii") === "GIF87a" || buf.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return { ext: "gif", mime: "image/gif" };
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    return { ext: "webp", mime: "image/webp" };
  }
  return null;
}

export class ImageInputError extends Error {}
export class InboxFileInputError extends Error {}

const INBOX_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
const INBOX_DOCUMENT_EXTENSIONS = new Set(["pdf", "doc", "docx", "xls", "xlsx"]);

/** File văn phòng gửi từ Inbox; chỉ nhận một file tối đa 10 MB. */
export async function prepareOutboundDocument(
  dataDir: string,
  workspaceId: string,
  channelId: string,
  input: { name: string; contentB64: string },
): Promise<string> {
  const name = input.name.trim();
  if (!name || name.length > 120 || name.startsWith(".") || /[\\/\x00-\x1f\x7f]/.test(name)) {
    throw new InboxFileInputError("Tên file không hợp lệ");
  }
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (!INBOX_DOCUMENT_EXTENSIONS.has(ext)) {
    throw new InboxFileInputError("Chỉ hỗ trợ PDF, Word (.doc/.docx) và Excel (.xls/.xlsx)");
  }
  const b64 = input.contentB64;
  if (!b64 || b64.length > Math.ceil(INBOX_DOCUMENT_MAX_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)) {
    throw new InboxFileInputError("Nội dung file không hợp lệ hoặc vượt 10 MB");
  }
  const buf = Buffer.from(b64, "base64");
  if (!buf.length || buf.length > INBOX_DOCUMENT_MAX_BYTES) {
    throw new InboxFileInputError("File rỗng hoặc vượt 10 MB");
  }
  const ole = buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  let valid = ext === "pdf" ? buf.subarray(0, 5).toString("ascii") === "%PDF-" : ole;
  if (ext === "docx" || ext === "xlsx") {
    try {
      const zip = new AdmZip(buf);
      valid = !!zip.getEntry("[Content_Types].xml") && !!zip.getEntry(ext === "docx" ? "word/document.xml" : "xl/workbook.xml");
    } catch {
      valid = false;
    }
  }
  if (!valid) throw new InboxFileInputError("Nội dung file không đúng định dạng đã chọn");
  const dir = resolve(join(dataDir, workspaceId, "zalo-inbox", channelId, new Date().toISOString().slice(0, 7), randomUUID()));
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, buf, { flag: "wx" });
  return path;
}

/**
 * Ảnh đầu vào: `data:image/...;base64,...` hoặc URL http(s) công khai.
 * URL: chặn IP nội bộ (kiểm lại ở mỗi lần chuyển hướng, tối đa 3), ≤ 10 MB,
 * nội dung phải là PNG/JPEG/GIF/WEBP thật.
 */
export async function loadImageInput(src: string): Promise<{ buf: Buffer; ext: string; mime: string }> {
  const value = src.trim();
  let buf: Buffer;
  if (value.startsWith("data:")) {
    const comma = value.indexOf(",");
    const head = value.slice(0, comma);
    if (comma < 0 || !/^data:image\/[a-z0-9.+-]+;base64$/i.test(head)) {
      throw new ImageInputError("Ảnh base64 phải có dạng data:image/<loại>;base64,<dữ liệu>");
    }
    buf = Buffer.from(value.slice(comma + 1), "base64");
  } else {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ImageInputError("image_url không phải URL hợp lệ");
    }
    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new ImageInputError("Chỉ nhận ảnh qua http/https");
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const ips = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
      if (!ips.length || ips.some((i) => isBlockedIp(i.address))) {
        throw new ImageInputError("Từ chối: địa chỉ ảnh trỏ tới mạng nội bộ");
      }
      res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        url = new URL(res.headers.get("location")!, url);
        res = null;
        continue;
      }
      break;
    }
    if (!res) throw new ImageInputError("Ảnh chuyển hướng quá nhiều lần");
    if (!res.ok) throw new ImageInputError(`Không tải được ảnh (HTTP ${res.status})`);
    if (Number(res.headers.get("content-length") ?? 0) > IMAGE_MAX_BYTES) throw new ImageInputError("Ảnh vượt 10 MB");
    buf = Buffer.from(await res.arrayBuffer());
  }
  if (!buf.length) throw new ImageInputError("Ảnh rỗng");
  if (buf.length > IMAGE_MAX_BYTES) throw new ImageInputError("Ảnh vượt 10 MB");
  const kind = sniffImage(buf);
  if (!kind) throw new ImageInputError("Chỉ hỗ trợ ảnh PNG, JPEG, GIF, WEBP");
  return { buf, ...kind };
}

/** Lưu ảnh gửi đi vào thư mục inbox của kênh (để gửi Zalo + hiển thị lại). */
export async function saveOutboundImage(
  dataDir: string,
  workspaceId: string,
  channelId: string,
  img: { buf: Buffer; ext: string },
): Promise<string> {
  const month = new Date().toISOString().slice(0, 7);
  const dir = resolve(join(dataDir, workspaceId, "zalo-inbox", channelId, month));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${randomUUID()}.${img.ext}`);
  await writeFile(path, img.buf);
  return path;
}

/** Media cho trình duyệt: bỏ đường dẫn tuyệt đối, thay bằng đường dẫn tương đối trong workspace. */
function publicMessage(m: InboxMessageRow, workspaceId: string): InboxMessageRow {
  if (!m.media || typeof m.media.localPath !== "string") return m;
  const { localPath, ...rest } = m.media as { localPath: string } & Record<string, unknown>;
  const ws = resolve(join(inboxDataDir, workspaceId));
  const rel = relative(ws, resolve(localPath));
  const file = rel && !rel.startsWith("..") && !rel.includes(`..${sep}`) ? rel.split(sep).join("/") : undefined;
  return { ...m, media: { ...rest, ...(file ? { file } : {}) } };
}

// ===== Gửi (dùng chung Inbox web + MCP) =====

export interface InboxSendRequest {
  channelId: string;
  workspaceId: string;
  threadId: string;
  peerKind: "direct" | "group";
  text?: string;
  image?: string;
  images?: string[];
  file?: { name: string; contentB64: string };
  /** Ảnh đã nạp + lưu sẵn (prepareOutboundImage) — MCP kiểm tra ảnh trước khi chiếm lượt gửi. */
  filePaths?: string[];
  source: ZaloSendSource;
  webUserId?: string;
  threadName?: string;
  quote?: InboxZaloQuote;
}

/** Nạp + kiểm tra + lưu ảnh gửi đi. Lỗi → ImageInputError (chưa gửi gì). */
export async function prepareOutboundImage(
  dataDir: string,
  workspaceId: string,
  channelId: string,
  src: string,
): Promise<string> {
  const img = await loadImageInput(src);
  return saveOutboundImage(dataDir, workspaceId, channelId, img);
}

/** Kiểm tra đủ bộ trước khi gửi; ảnh lỗi thì dọn các file vừa chuẩn bị. */
export async function prepareOutboundImages(dataDir: string, workspaceId: string, channelId: string, sources: string[]): Promise<string[]> {
  const paths: string[] = [];
  try {
    for (const src of sources) paths.push(await prepareOutboundImage(dataDir, workspaceId, channelId, src));
    return paths;
  } catch (error) {
    await Promise.allSettled(paths.map((path) => rm(path, { force: true })));
    if (error instanceof ImageInputError) throw new ImageInputError(`Ảnh ${paths.length + 1}/${sources.length}: ${error.message}`);
    throw error;
  }
}

/** Lỗi do Zalo trả về (tham số sai, bị chặn…) → chắc chắn tin CHƯA gửi. */
export function isPlatformRejected(err: unknown): boolean {
  const e = err as { name?: string; zaloRejected?: boolean } | null;
  return !!e && (e.name === "ZcaApiError" || e.zaloRejected === true);
}

export async function sendInbox(dataDir: string, req: InboxSendRequest): Promise<{ msgIds: string[] }> {
  const runtime = inboxRuntime(req.channelId);
  if (!runtime || !runtime.isConnected()) {
    const err = new Error(`Kênh ${platformOf(req.channelId)} chưa kết nối — vào Channels → Kết nối QR để quét lại.`) as Error & { code?: string };
    err.code = "NOT_CONNECTED";
    throw err;
  }
  const filePaths: string[] = [...(req.filePaths ?? [])];
  if (req.images?.length) {
    if (req.images.length > 6 || req.image || req.file) throw new ImageInputError("Chỉ chọn tối đa 6 ảnh, không kèm file khác");
    filePaths.push(...(await prepareOutboundImages(dataDir, req.workspaceId, req.channelId, req.images)));
  }
  if (req.image) {
    filePaths.push(await prepareOutboundImage(dataDir, req.workspaceId, req.channelId, req.image));
  }
  if (req.file) {
    filePaths.push(await prepareOutboundDocument(dataDir, req.workspaceId, req.channelId, req.file));
  }
  const msgIds = await runtime.sendManual({
    threadId: req.threadId,
    peerKind: req.peerKind,
    ...(req.text ? { text: req.text } : {}),
    ...(filePaths.length ? { filePaths } : {}),
    source: req.source,
    ...(req.webUserId ? { webUserId: req.webUserId } : {}),
    ...(req.threadName ? { threadName: req.threadName } : {}),
    ...(req.quote ? { quote: req.quote } : {}),
  });
  return { msgIds };
}

const activeStaffDelegations = new Set<string>();
const completedStaffDelegations = new Map<string, string>();

function delegationError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

/** Dùng chung cho lệnh nội bộ Inbox và lệnh điện thoại đã thu hồi thành công. */
export async function delegateOrchidStaffPromise(
  db: Db, ctx: WorkspaceContext, dataDir: string, channelId: string, threadId: string,
  expectedText?: string,
): Promise<void> {
  if (!ORCHID_SALES_CHANNEL_IDS.has(channelId) || !isValidThreadId("zalo_personal", threadId)) {
    throw delegationError(400, "-ld chỉ dùng trong DM Hot 1, Hot 4, Hot 6");
  }
  const channel = await getChannelById(db, ctx, channelId);
  const thread = await getInboxThread(db, ctx, channelId, threadId);
  if (!channel || channel.agentId !== ORCHID_SALES_AGENT_ID || !thread || thread.kind !== "direct" ||
      (channel.config as Record<string, unknown>)["agent_reply"] === false) {
    throw delegationError(409, "Hội thoại này chưa bật Agent kinh doanh");
  }
  if (!inboxRuntime(channelId)?.isConnected()) {
    throw delegationError(409, "Kênh Zalo chưa kết nối; chưa giao việc cho AI");
  }
  const key = `${channelId}:${threadId}`;
  if (activeStaffDelegations.has(key)) throw delegationError(409, "AI đang thực hiện -ld cho hội thoại này");
  activeStaffDelegations.add(key);
  try {
    let staffMessage: string | null = null;
    let staffMessageId = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      const messages = await listInboxMessages(db, ctx, channelId, threadId, { limit: 10 });
      const staffRow = latestDelegableStaffRow(messages);
      staffMessage = staffRow?.text.trim() ?? null;
      staffMessageId = staffRow?.id ?? "";
      if (!expectedText || staffMessage === expectedText) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (expectedText && staffMessage !== expectedText) {
      throw delegationError(409, "Chưa thấy lời nhắn vừa gửi trong Inbox; thử lại sau một chút.");
    }
    if (!staffMessage) {
      throw delegationError(422, "Tin mới nhất phải là lời nhân viên vừa nhắn cho khách. Chưa giao việc cho AI.");
    }
    if (completedStaffDelegations.get(key) === staffMessageId) {
      throw delegationError(409, "AI đã thực hiện -ld cho lời nhắn này. Hãy nhắn việc mới trước khi giao tiếp.");
    }

    const potStems = promisedPotStemCount(staffMessage);
    if (potStems) {
      const sampleDir = join(dataDir, ctx.workspaceId, "shared", "so-canh", `chau-lan-${potStems}-canh`);
      const files = (await readdir(sampleDir, { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isFile() && /\.(?:jpe?g|png|webp)$/i.test(entry.name))
        .map((entry) => join(sampleDir, entry.name)).sort().slice(0, 4);
      if (!files.length) throw delegationError(422, `Chưa có ảnh mẫu chậu ${potStems} cành để gửi cho khách.`);
      await sendInbox(dataDir, { channelId, workspaceId: ctx.workspaceId, threadId,
        peerKind: "direct", filePaths: files, source: "agent" });
    } else {
      const result = await runOrchidStaffDelegation(channelId, threadId, staffMessage, thread.name);
      if (result.kind !== "reply" || result.text.trim() === "KHONG_LAM" ||
          (!result.text.trim() && !result.media?.length)) {
        throw delegationError(422, "AI chưa xác định được việc cần làm từ lời nhắn vừa rồi; chưa gửi gì cho khách.");
      }
      if (expectsCurrentColorPhotos(staffMessage) && !result.media?.length) {
        throw delegationError(422, "AI chưa lấy được ảnh màu đang có; chưa gửi lời hứa suông cho khách.");
      }
      await sendInbox(dataDir, { channelId, workspaceId: ctx.workspaceId, threadId, peerKind: "direct",
        ...(result.text.trim() ? { text: result.text } : {}),
        ...(result.media?.length ? { filePaths: result.media } : {}), source: "agent" });
    }
    completedStaffDelegations.set(key, staffMessageId);
  } finally {
    activeStaffDelegations.delete(key);
  }
}

export function inboxRuntimeFor(channelId: string): PersonalChannel | null {
  return inboxRuntime(channelId);
}

// ===== Routes =====

export const SendBody = z
  .object({
    text: z.string().max(10_000).optional(),
    image: z.string().max(15_000_000).optional(),
    images: z.array(z.string().max(15_000_000)).min(1).max(6).optional(),
    file: z.object({ name: z.string().max(120), contentB64: z.string().max(14_000_000) }).optional(),
    peerKind: z.enum(["direct", "group"]).optional(),
    threadName: z.string().trim().min(1).max(120).optional(),
    replyToId: z.string().regex(/^\d{1,19}$/).optional(),
  })
  .refine((v) => (v.text && v.text.trim()) || v.image || v.images?.length || v.file, { message: "Cần nội dung hoặc file" })
  .refine((v) => !(v.image && v.images?.length) && !((v.image || v.images?.length) && v.file), { message: "Chỉ chọn ảnh hoặc một file mỗi lần" });

export const NewMessageBody = z
  .object({
    to: z.string().regex(/^[0-9A-Za-z@.-]{1,64}$/).optional(),
    phone: z.string().regex(/^\+?\d{8,15}$/).optional(),
    peerKind: z.enum(["direct", "group"]).default("direct"),
    text: z.string().max(10_000).optional(),
    image: z.string().max(15_000_000).optional(),
    images: z.array(z.string().max(15_000_000)).min(1).max(6).optional(),
    file: z.object({ name: z.string().max(120), contentB64: z.string().max(14_000_000) }).optional(),
  })
  .refine((v) => v.to || v.phone, { message: "Cần uid (to) hoặc số điện thoại" })
  .refine((v) => (v.text && v.text.trim()) || v.image || v.images?.length || v.file, { message: "Cần nội dung hoặc file" })
  .refine((v) => !(v.image && v.images?.length) && !((v.image || v.images?.length) && v.file), { message: "Chỉ chọn ảnh hoặc một file mỗi lần" });

const AiBody = z.object({ mode: z.enum(["auto", "off"]).optional(), resume: z.boolean().optional() });
const InboxSettingsBody = z.object({
  enabled: z.boolean().optional(),
  pauseMinutes: z.number().int().min(0).max(1440).optional(),
  mcpReadMessages: z.boolean().optional(),
  autoReaction: z.enum(["off", "heart", "like"]).optional(),
  photoAck: z.enum(["short", "off"]).optional(),
});

const ReactBody = z.object({ reaction: z.enum(["heart", "like", "haha", "wow", "cry", "angry", "none"]) });
const MessageStateBody = z.object({ action: z.enum(["recalled", "deleted"]) });
const QuickReplyBody = z.object({
  shortcut: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, "Mã chỉ gồm chữ thường, số, _ hoặc - (tối đa 32 ký tự)"),
  title: z.string().trim().min(1).max(80),
  content: z.string().trim().min(1).max(2000),
});

function sendError(reply: FastifyReply, err: unknown, channelId: string) {
  const e = err as Error & { code?: string };
  const label = platformOf(channelId);
  if (e instanceof ImageInputError || e instanceof InboxFileInputError) return reply.code(400).send({ error: e.message });
  if (e.code === "NOT_CONNECTED") return reply.code(409).send({ error: e.message, code: "NOT_CONNECTED" });
  if (isPlatformRejected(e)) return reply.code(422).send({ error: `${label} từ chối: ${e.message}`, code: `${label.toUpperCase()}_REJECTED` });
  logger.warn(`zalo.inbox_send lỗi: ${e.message}`);
  return reply.code(502).send({ error: `Gửi ${label} lỗi: ${e.message}` });
}

export function registerInboxRoutes(app: FastifyInstance, deps: { db: Db; dataDir: string }): void {
  const { db, dataDir } = deps;
  inboxDataDir = dataDir;

  async function guard(req: FastifyRequest, reply: FastifyReply, channelId: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(channelId) || !(await canUseInboxChannel(db, req.authCtx, channelId))) {
      void reply.code(403).send({ error: "Bạn không được trực kênh này" });
      return false;
    }
    return true;
  }

  const kindOf = (channelId: string): string => channelHandlers.get(channelId)?.channel.kind ?? "zalo_personal";

  // /v1/inbox/… là địa chỉ chung; /v1/zalo-inbox/… giữ nguyên cho tích hợp đã có (cùng một bộ xử lý)
  for (const base of ["/v1/inbox", "/v1/zalo-inbox"]) {
  // Kênh được trực + trạng thái kết nối
  app.get(`${base}/channels`, async (req) => {
    const ids = await allowedInboxChannelIds(db, req.authCtx);
    const all = (await listChannels(db, req.authCtx)).filter((c) => ids.includes(c.id));
    return {
      channels: all.map((c) => {
        const rt = inboxRuntime(c.id);
        const cfg = readInboxConfig((c.config as Record<string, unknown>) ?? {});
        return {
          id: c.id,
          kind: c.kind,
          platform: personalPlatformLabel(c.kind),
          name: c.name,
          enabled: c.enabled,
          connected: rt?.isConnected() ?? false,
          account: rt?.accountInfo() ?? null,
          inbox: cfg.enabled,
          pauseMinutes: cfg.pauseMinutes,
          mcpReadMessages: cfg.mcpReadMessages,
          autoReaction: cfg.autoReaction,
          agentReply: cfg.agentReply,
          photoAck: cfg.photoAck,
        };
      }),
      canManage: hasRole(req.authCtx.role, "operator") || req.authCtx.role === "moderator",
    };
  });

  // Realtime
  app.get(`${base}/events`, async (req, reply) => {
    const ids = await allowedInboxChannelIds(db, req.authCtx);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    raw.write("event: ready\ndata: {}\n\n");
    const client: SseClient = {
      workspaceId: req.authCtx.workspaceId,
      channelIds: req.authCtx.role === "moderator" || hasRole(req.authCtx.role, "operator") ? null : new Set(ids),
      write: (chunk) => raw.write(chunk),
    };
    sseClients.add(client);
    req.raw.on("close", () => sseClients.delete(client));
  });

  app.get(`${base}/:channelId/threads`, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    if (!(await guard(req, reply, channelId))) return;
    const q = req.query as { q?: string; kind?: string; unread?: string; tagId?: string; hidden?: string; limit?: string; offset?: string; all?: string };
    if (q.tagId && !z.string().uuid().safeParse(q.tagId).success) return reply.code(400).send({ error: "Nhãn không hợp lệ" });
    const res = await listInboxThreads(db, req.authCtx, channelId, {
      ...(q.q ? { q: q.q.slice(0, 100) } : {}),
      ...(q.tagId ? { tagId: q.tagId } : {}),
      ...(q.kind === "direct" || q.kind === "group" ? { kind: q.kind } : {}),
      unreadOnly: q.unread === "1",
      inboxHidden: q.hidden === "1",
      // Không tìm kiếm → chỉ hội thoại đã có tin; tìm kiếm → cả danh bạ chưa chat
      withMessagesOnly: !q.q && q.all !== "1",
      limit: Number(q.limit) || 100,
      offset: Number(q.offset) || 0,
    });
    return res;
  });

  app.put(`${base}/:channelId/threads/:threadId/visibility`, async (req, reply) => {
    const { channelId, threadId } = req.params as { channelId: string; threadId: string };
    if (!(await guard(req, reply, channelId))) return;
    const parsed = z.object({ hidden: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Trạng thái ẩn không hợp lệ" });
    const thread = await setInboxThreadHidden(db, req.authCtx, channelId, threadId, parsed.data.hidden);
    if (!thread) return reply.code(404).send({ error: "Không tìm thấy hội thoại" });
    broadcast(req.authCtx.workspaceId, channelId, "thread_visibility", { channelId, thread });
    return { thread };
  });

  app.put(`${base}/:channelId/threads/:threadId/note`, async (req, reply) => {
    const { channelId, threadId } = req.params as { channelId: string; threadId: string };
    if (!(await guard(req, reply, channelId))) return;
    const parsed = z.object({ note: z.string().max(10000) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Ghi chú phải là văn bản tối đa 10.000 ký tự" });
    const thread = await setInboxCustomerNote(db, req.authCtx, channelId, threadId, parsed.data.note);
    if (!thread) return reply.code(404).send({ error: "Không tìm thấy khách trong kênh này" });
    broadcast(req.authCtx.workspaceId, channelId, "customer_note", { channelId, threadId, note: thread.customerNote, updatedAt: thread.customerNoteUpdatedAt });
    return { thread };
  });

  app.get(`${base}/:channelId/tags`, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    if (!(await guard(req, reply, channelId))) return;
    return { tags: await listInboxTags(db, req.authCtx) };
  });

  app.get(`${base}/:channelId/quick-replies`, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    if (!(await guard(req, reply, channelId))) return;
    return { replies: await listInboxQuickReplies(db, req.authCtx) };
  });

  app.post(`${base}/:channelId/quick-replies`, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    if (!(await guard(req, reply, channelId))) return;
    const parsed = QuickReplyBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Tin nhắn nhanh không hợp lệ" });
    const quickReply = await createInboxQuickReply(db, req.authCtx, parsed.data.shortcut, parsed.data.title, parsed.data.content);
    if (!quickReply) return reply.code(409).send({ error: "Mã đã tồn tại hoặc đã đạt giới hạn 200 tin nhắn nhanh" });
    broadcastWorkspace(req.authCtx.workspaceId, "inbox_quick_replies", {});
    return { reply: quickReply };
  });

  app.put(`${base}/:channelId/quick-replies/:id`, async (req, reply) => {
    const { channelId, id } = req.params as { channelId: string; id: string };
    if (!(await guard(req, reply, channelId))) return;
    if (!z.string().uuid().safeParse(id).success) return reply.code(400).send({ error: "Mã tin nhắn nhanh không hợp lệ" });
    const parsed = QuickReplyBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Tin nhắn nhanh không hợp lệ" });
    const quickReply = await updateInboxQuickReply(db, req.authCtx, id, parsed.data.shortcut, parsed.data.title, parsed.data.content);
    if (!quickReply) return reply.code(409).send({ error: "Không tìm thấy tin nhắn nhanh hoặc mã đã tồn tại" });
    broadcastWorkspace(req.authCtx.workspaceId, "inbox_quick_replies", {});
    return { reply: quickReply };
  });

  app.delete(`${base}/:channelId/quick-replies/:id`, async (req, reply) => {
    const { channelId, id } = req.params as { channelId: string; id: string };
    if (!(await guard(req, reply, channelId))) return;
    if (!z.string().uuid().safeParse(id).success) return reply.code(400).send({ error: "Mã tin nhắn nhanh không hợp lệ" });
    if (!(await deleteInboxQuickReply(db, req.authCtx, id))) return reply.code(404).send({ error: "Không tìm thấy tin nhắn nhanh" });
    broadcastWorkspace(req.authCtx.workspaceId, "inbox_quick_replies", {});
    return { deleted: true };
  });

  app.post(`${base}/:channelId/tags`, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    if (!(await guard(req, reply, channelId))) return;
    const parsed = z.object({ name: z.string().trim().min(1).max(40), color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Tên hoặc màu nhãn không hợp lệ" });
    const tag = await createInboxTag(db, req.authCtx, parsed.data.name, parsed.data.color);
    broadcast(req.authCtx.workspaceId, channelId, "inbox_tags", { channelId });
    return { tag };
  });

  app.put(`${base}/:channelId/tags/:tagId/color`, async (req, reply) => {
    const { channelId, tagId } = req.params as { channelId: string; tagId: string };
    if (!(await guard(req, reply, channelId))) return;
    if (!z.string().uuid().safeParse(tagId).success) return reply.code(400).send({ error: "Nhãn không hợp lệ" });
    const parsed = z.object({ color: z.string().regex(/^#[0-9A-Fa-f]{6}$/) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Màu nhãn phải có dạng #RRGGBB" });
    const tag = await updateInboxTagColor(db, req.authCtx, tagId, parsed.data.color);
    if (!tag) return reply.code(404).send({ error: "Không tìm thấy nhãn" });
    broadcast(req.authCtx.workspaceId, channelId, "inbox_tags", { channelId });
    return { tag };
  });

  app.delete(`${base}/:channelId/tags/:tagId`, async (req, reply) => {
    const { channelId, tagId } = req.params as { channelId: string; tagId: string };
    if (!(await guard(req, reply, channelId))) return;
    if (!z.string().uuid().safeParse(tagId).success) return reply.code(400).send({ error: "Nhãn không hợp lệ" });
    if (!(await deleteInboxTag(db, req.authCtx, tagId))) return reply.code(404).send({ error: "Không tìm thấy nhãn" });
    broadcastWorkspace(req.authCtx.workspaceId, "inbox_tags", { allChannels: true });
    return { deleted: true };
  });

  app.put(`${base}/:channelId/threads/:threadId/tags`, async (req, reply) => {
    const { channelId, threadId } = req.params as { channelId: string; threadId: string };
    if (!(await guard(req, reply, channelId))) return;
    const parsed = z.object({ tagIds: z.array(z.string().uuid()).max(20) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Danh sách nhãn không hợp lệ (tối đa 20)" });
    const tags = await setInboxThreadTags(db, req.authCtx, channelId, threadId, parsed.data.tagIds);
    if (!tags) return reply.code(404).send({ error: "Không tìm thấy hội thoại hoặc nhãn" });
    const thread = await getInboxThread(db, req.authCtx, channelId, threadId);
    if (thread) broadcast(req.authCtx.workspaceId, channelId, "inbox_thread_tags", { channelId, threadId, tags });
    return { tags, thread };
  });

  app.get(`${base}/:channelId/threads/:threadId/messages`, async (req, reply) => {
    const { channelId, threadId } = req.params as { channelId: string; threadId: string };
    if (!(await guard(req, reply, channelId))) return;
    const q = req.query as { before?: string; limit?: string };
    const [thread, messages] = await Promise.all([
      getInboxThread(db, req.authCtx, channelId, threadId),
      listInboxMessages(db, req.authCtx, channelId, threadId, {
        ...(q.before ? { beforeId: q.before } : {}),
        limit: Number(q.limit) || 50,
      }),
    ]);
    return { thread, messages: messages.map((m) => publicMessage(m, req.authCtx.workspaceId)) };
  });

  app.get(`${base}/:channelId/threads/:threadId/explore`, async (req, reply) => {
    const { channelId, threadId } = req.params as { channelId: string; threadId: string };
    if (!(await guard(req, reply, channelId))) return;
    const parsed = z.object({
      category: z.enum(["all", "media", "photo", "video", "file", "link"]).optional(),
      q: z.string().max(150).optional(), sender: z.string().max(100).optional(),
      direction: z.enum(["in", "out"]).optional(),
      before: z.string().regex(/^\d{1,19}$/).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "Bộ lọc lịch sử không hợp lệ" });
    if (!(await getInboxThread(db, req.authCtx, channelId, threadId))) return reply.code(404).send({ error: "Không tìm thấy hội thoại" });
    const result = await browseInboxThreadMessages(db, req.authCtx, channelId, threadId, {
      category: parsed.data.category, query: parsed.data.q, sender: parsed.data.sender,
      direction: parsed.data.direction, beforeId: parsed.data.before, limit: parsed.data.limit,
    });
    return { messages: result.messages.map((m) => publicMessage(m, req.authCtx.workspaceId)), nextBefore: result.nextBefore };
  });

  app.get(`${base}/:channelId/threads/:threadId/senders`, async (req, reply) => {
    const { channelId, threadId } = req.params as { channelId: string; threadId: string };
    if (!(await guard(req, reply, channelId))) return;
    if (!(await getInboxThread(db, req.authCtx, channelId, threadId))) return reply.code(404).send({ error: "Không tìm thấy hội thoại" });
    return { senders: await listInboxThreadSenders(db, req.authCtx, channelId, threadId) };
  });

  app.get(`${base}/:channelId/threads/:threadId/messages/:messageId/context`, async (req, reply) => {
    const { channelId, threadId, messageId } = req.params as { channelId: string; threadId: string; messageId: string };
    if (!(await guard(req, reply, channelId))) return;
    if (!/^\d{1,19}$/.test(messageId)) return reply.code(400).send({ error: "Mã tin nhắn không hợp lệ" });
    const messages = await inboxMessageContext(db, req.authCtx, channelId, threadId, messageId);
    if (!messages.some((m) => m.id === messageId)) return reply.code(404).send({ error: "Không tìm thấy tin nhắn" });
    return { messages: messages.map((m) => publicMessage(m, req.authCtx.workspaceId)) };
  });

  app.get(`${base}/:channelId/threads/:threadId/messages/by-msg-id/:msgId`, async (req, reply) => {
    const { channelId, threadId, msgId } = req.params as { channelId: string; threadId: string; msgId: string };
    if (!(await guard(req, reply, channelId))) return;
    if (!msgId || msgId.length > 100) return reply.code(400).send({ error: "Mã tin nhắn không hợp lệ" });
    const message = await getInboxMessageByMsgId(db, req.authCtx, channelId, threadId, msgId);
    if (!message) return reply.code(404).send({ error: "Tin được trích dẫn không có trong lịch sử Inbox của hội thoại này" });
    return { message: publicMessage(message, req.authCtx.workspaceId) };
  });

  app.post(`${base}/:channelId/threads/:threadId/read`, async (req, reply) => {
    const { channelId, threadId } = req.params as { channelId: string; threadId: string };
    if (!(await guard(req, reply, channelId))) return;
    await markInboxThreadRead(db, req.authCtx, channelId, threadId);
    return { ok: true };
  });

  app.post(`${base}/:channelId/threads/:threadId/send`, async (req, reply) => {
    const { channelId, threadId } = req.params as { channelId: string; threadId: string };
    if (!(await guard(req, reply, channelId))) return;
    if (!isValidThreadId(kindOf(channelId), threadId)) return reply.code(400).send({ error: "Mã hội thoại không hợp lệ" });
    const parsed = SendBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" });
    const thread = await getInboxThread(db, req.authCtx, channelId, threadId);
    const peerKind = thread?.kind ?? parsed.data.peerKind ?? "direct";
    let quote: InboxZaloQuote | null = null;
    if (parsed.data.replyToId) {
      if (kindOf(channelId) !== "zalo_personal") return reply.code(422).send({ error: "Trích dẫn hiện chỉ hỗ trợ Zalo cá nhân" });
      if (!parsed.data.text?.trim() || parsed.data.image || parsed.data.images?.length || parsed.data.file) {
        return reply.code(400).send({ error: "Khi trả lời trích dẫn, hãy nhập lời nhắn; gửi ảnh/file ở lượt riêng" });
      }
      const target = await getInboxMessageById(db, req.authCtx, channelId, threadId, parsed.data.replyToId);
      quote = target ? inboxZaloQuote(target) : null;
      if (!quote) return reply.code(422).send({ error: "Tin này thiếu thông tin Zalo để trích dẫn; vui lòng chọn tin khác" });
    }
    try {
      const out = await sendInbox(dataDir, {
        channelId,
        workspaceId: req.authCtx.workspaceId,
        threadId,
        peerKind,
        ...(parsed.data.text?.trim() ? { text: parsed.data.text } : {}),
        ...(parsed.data.image ? { image: parsed.data.image } : {}),
        ...(parsed.data.images ? { images: parsed.data.images } : {}),
        ...(parsed.data.file ? { file: parsed.data.file } : {}),
        source: "web",
        webUserId: req.authCtx.userId,
        ...(!thread && peerKind === "direct" && parsed.data.threadName ? { threadName: parsed.data.threadName } : {}),
        ...(quote ? { quote } : {}),
      });
      return { sent: true, msgIds: out.msgIds };
    } catch (err) {
      return sendError(reply, err, channelId);
    }
  });

  // -ld là lệnh nội bộ của người trực, không gửi nguyên mã lệnh sang Zalo.
  app.post(`${base}/:channelId/threads/:threadId/delegate`, async (req, reply) => {
    const { channelId, threadId } = req.params as { channelId: string; threadId: string };
    if (!(await guard(req, reply, channelId))) return;
    try {
      const parsed = z.object({ expectedText: z.string().trim().max(10_000).optional() }).safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "Nội dung giao việc không hợp lệ" });
      await delegateOrchidStaffPromise(db, req.authCtx, dataDir, channelId, threadId, parsed.data.expectedText);
      return { delegated: true };
    } catch (err) {
      if (err instanceof Error && "statusCode" in err) {
        return reply.code(Number(err.statusCode)).send({ error: err.message });
      }
      return sendError(reply, err, channelId);
    }
  });

  // Nhắn tin mới cho uid/SĐT chưa có trong danh sách
  app.post(`${base}/:channelId/new`, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    if (!(await guard(req, reply, channelId))) return;
    const parsed = NewMessageBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" });
    const rt = inboxRuntime(channelId);
    if (!rt?.isConnected()) return reply.code(409).send({ error: `Kênh ${platformOf(channelId)} chưa kết nối`, code: "NOT_CONNECTED" });
    let threadId = parsed.data.to ?? "";
    let peerKind = parsed.data.peerKind;
    let threadName = "";
    if (!threadId && parsed.data.phone) {
      const user = await rt.findUserByPhone(parsed.data.phone).catch(() => null);
      if (!user) return reply.code(404).send({ error: `Không tìm thấy tài khoản ${platformOf(channelId)} với số này (hoặc người đó chặn tìm kiếm)` });
      threadId = user.uid;
      threadName = user.name;
      peerKind = "direct";
    } else {
      if (!isValidThreadId(kindOf(channelId), threadId)) return reply.code(400).send({ error: "Mã người nhận không hợp lệ" });
      const known = await getInboxThread(db, req.authCtx, channelId, threadId);
      if (known) peerKind = known.kind;
      else if (threadId.endsWith("@g.us")) peerKind = "group";
    }
    try {
      await sendInbox(dataDir, {
        channelId,
        workspaceId: req.authCtx.workspaceId,
        threadId,
        peerKind,
        ...(parsed.data.text?.trim() ? { text: parsed.data.text } : {}),
        ...(parsed.data.image ? { image: parsed.data.image } : {}),
        ...(parsed.data.images ? { images: parsed.data.images } : {}),
        ...(parsed.data.file ? { file: parsed.data.file } : {}),
        source: "web",
        webUserId: req.authCtx.userId,
        ...(threadName ? { threadName } : {}),
      });
      return { sent: true, threadId, peerKind };
    } catch (err) {
      return sendError(reply, err, channelId);
    }
  });

  app.get(`${base}/:channelId/find-phone`, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    if (!(await guard(req, reply, channelId))) return;
    const phone = String((req.query as { phone?: string }).phone ?? "").trim();
    if (!/^\+?\d{8,15}$/.test(phone)) return reply.code(400).send({ error: "Số điện thoại không hợp lệ" });
    const rt = inboxRuntime(channelId);
    if (!rt?.isConnected()) return reply.code(409).send({ error: `Kênh ${platformOf(channelId)} chưa kết nối`, code: "NOT_CONNECTED" });
    const user = await rt.findUserByPhone(phone).catch(() => null);
    return { found: !!user, user };
  });

  app.get(`${base}/:channelId/friend-search`, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    if (!(await guard(req, reply, channelId))) return;
    if (kindOf(channelId) !== "zalo_personal") return reply.code(422).send({ error: "Kết bạn chỉ hỗ trợ kênh Zalo cá nhân" });
    const parsed = z.object({
      by: z.enum(["phone", "username"]),
      value: z.string().trim().min(3).max(50),
    }).safeParse(req.query);
    if (!parsed.success || (parsed.data.by === "phone" ? !/^\+?\d{8,15}$/.test(parsed.data.value)
      : !/^[A-Za-z0-9._-]{3,50}$/.test(parsed.data.value))) {
      return reply.code(400).send({ error: "Nhập số điện thoại hoặc username Zalo hợp lệ" });
    }
    const rt = inboxRuntime(channelId);
    if (!rt?.isConnected() || !rt.findFriendCandidate) return reply.code(409).send({ error: "Kênh Zalo chưa kết nối", code: "NOT_CONNECTED" });
    try {
      const user = await rt.findFriendCandidate(parsed.data.value, parsed.data.by);
      return { found: !!user, user };
    } catch (err) {
      return reply.code(502).send({ error: `Không tìm được người trên Zalo: ${(err as Error).message}` });
    }
  });

  app.post(`${base}/:channelId/friend-request`, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    if (!(await guard(req, reply, channelId))) return;
    if (kindOf(channelId) !== "zalo_personal") return reply.code(422).send({ error: "Kết bạn chỉ hỗ trợ kênh Zalo cá nhân" });
    const parsed = z.object({
      uid: z.string().regex(/^[0-9A-Za-z_-]{1,64}$/),
      message: z.string().trim().min(1).max(150),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Người nhận hoặc lời nhắn kết bạn không hợp lệ" });
    const rt = inboxRuntime(channelId);
    if (!rt?.isConnected() || !rt.sendFriendRequest) return reply.code(409).send({ error: "Kênh Zalo chưa kết nối", code: "NOT_CONNECTED" });
    if (rt.accountInfo()?.id === parsed.data.uid) return reply.code(400).send({ error: "Không thể kết bạn với chính tài khoản này" });
    try {
      await rt.sendFriendRequest(parsed.data.uid, parsed.data.message);
      await recordAudit(db, req.authCtx, "zalo_inbox.friend_request", { channelId, uid: parsed.data.uid })
        .catch((err: unknown) => logger.warn(`zalo.friend_request_audit_fail: ${(err as Error).message}`));
      return { sent: true };
    } catch (err) {
      const message = (err as Error).message;
      if (/đã là bạn bè|đã có lời mời/i.test(message)) return reply.code(409).send({ error: message });
      if (isPlatformRejected(err)) return reply.code(422).send({ error: `Zalo từ chối lời mời: ${message}` });
      return reply.code(502).send({ error: `Không gửi được lời mời kết bạn: ${message}` });
    }
  });

  app.put(`${base}/:channelId/threads/:threadId/ai`, async (req, reply) => {
    const { channelId, threadId } = req.params as { channelId: string; threadId: string };
    if (!(await guard(req, reply, channelId))) return;
    const parsed = AiBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Dữ liệu không hợp lệ" });
    const existing = await getInboxThread(db, req.authCtx, channelId, threadId);
    const thread = await setInboxThreadAi(db, req.authCtx, channelId, threadId, {
      ...(parsed.data.mode ? { mode: parsed.data.mode } : {}),
      ...(parsed.data.resume ? { resume: true } : {}),
      kind: existing?.kind ?? "direct",
    });
    if (thread) broadcast(req.authCtx.workspaceId, channelId, "thread", { channelId, thread });
    return { thread };
  });

  // Đồng bộ danh bạ ngay (operator trở lên hoặc moderator)
  app.post(`${base}/:channelId/sync-contacts`, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    if (req.authCtx.role !== "moderator" && !hasRole(req.authCtx.role, "operator")) return reply.code(403).send({ error: "Cần quyền trực Inbox" });
    if (!(await guard(req, reply, channelId))) return;
    const rt = inboxRuntime(channelId);
    if (!rt?.isConnected()) return reply.code(409).send({ error: `Kênh ${platformOf(channelId)} chưa kết nối`, code: "NOT_CONNECTED" });
    try {
      return await rt.syncContacts();
    } catch (err) {
      return reply.code(502).send({ error: `Đồng bộ danh bạ lỗi: ${(err as Error).message}` });
    }
  });

  // Thu hồi cho mọi người hoặc xóa chỉ trên tài khoản Zalo; vẫn giữ bản ghi Inbox.
  app.post(`${base}/:channelId/threads/:threadId/messages/:messageId/state`, async (req, reply) => {
    const { channelId, threadId, messageId } = req.params as { channelId: string; threadId: string; messageId: string };
    if (!(await guard(req, reply, channelId))) return;
    if (kindOf(channelId) !== "zalo_personal") return reply.code(422).send({ error: "Kênh này chưa hỗ trợ thu hồi/xóa tin" });
    const parsed = MessageStateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Thao tác không hợp lệ" });
    const [message, thread] = await Promise.all([
      getInboxMessageById(db, req.authCtx, channelId, threadId, messageId),
      getInboxThread(db, req.authCtx, channelId, threadId),
    ]);
    if (!message || !thread) return reply.code(404).send({ error: "Không tìm thấy tin nhắn" });
    if (message.direction !== "out") return reply.code(422).send({ error: "Chỉ xử lý tin đã gửi từ tài khoản này" });
    if (message.removed) return reply.code(409).send({ error: "Tin này đã xóa hoặc thu hồi" });
    const cliMsgId = message.meta?.cliMsgId;
    if (!message.msgId || typeof cliMsgId !== "string" || !cliMsgId) {
      return reply.code(422).send({ error: "Chưa có đủ mã xác nhận từ Zalo để thu hồi tin này" });
    }
    const runtime = inboxRuntime(channelId);
    if (!runtime?.isConnected() || !runtime.changeMessageState) {
      return reply.code(409).send({ error: "Kênh Zalo chưa kết nối", code: "NOT_CONNECTED" });
    }
    try {
      await runtime.changeMessageState({
        threadId, peerKind: thread.kind, msgId: message.msgId, cliMsgId,
        action: parsed.data.action,
      });
      await markInboxMessageRemoved(db, req.authCtx, channelId, threadId,
        { id: messageId }, parsed.data.action);
      const current = await getInboxMessageById(db, req.authCtx, channelId, threadId, messageId);
      if (current) broadcast(req.authCtx.workspaceId, channelId, "message_update", {
        channelId, threadId, message: publicMessage(current, req.authCtx.workspaceId),
      });
      if (parsed.data.action === "recalled" && message.source === "agent") {
        await markAgentMessageRecalled(db, req.authCtx, channelId, threadId, message.msgId);
        await agentRecallHandlers.get(channelId)?.(threadId, thread.kind);
      }
      const latestThread = await getInboxThread(db, req.authCtx, channelId, threadId);
      if (latestThread) broadcast(req.authCtx.workspaceId, channelId, "thread", { channelId, thread: latestThread });
      return { ok: true, message: current ? publicMessage(current, req.authCtx.workspaceId) : null };
    } catch (error) {
      const e = error as Error & { code?: string };
      if (e.code === "NOT_CONNECTED") return reply.code(409).send({ error: e.message });
      if (isPlatformRejected(e)) return reply.code(422).send({ error: `Zalo từ chối: ${e.message}` });
      logger.warn(`zalo.inbox_message_state lỗi: ${e.message}`);
      return reply.code(502).send({ error: `Không đổi được trạng thái tin: ${e.message}` });
    }
  });

  // Nhân viên thả / gỡ cảm xúc vào tin trong Inbox
  app.post(`${base}/:channelId/threads/:threadId/messages/:messageId/react`, async (req, reply) => {
    const { channelId, threadId, messageId } = req.params as { channelId: string; threadId: string; messageId: string };
    if (!(await guard(req, reply, channelId))) return;
    const parsed = ReactBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Cảm xúc không hợp lệ" });
    try {
      await reactInboxMessage(db, req.authCtx, {
        channelId,
        threadId,
        messageId,
        reaction: parsed.data.reaction,
        source: "web",
        webUserId: req.authCtx.userId,
      });
      return { ok: true };
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === "NOT_CONNECTED") return reply.code(409).send({ error: e.message, code: e.code });
      if (e.code === "MESSAGE_NOT_FOUND") return reply.code(404).send({ error: e.message, code: e.code });
      if (e.code === "CANNOT_REACT") return reply.code(422).send({ error: e.message, code: e.code });
      logger.warn(`zalo.inbox_react lỗi: ${e.message}`);
      return reply.code(502).send({ error: `${platformOf(channelId)} lỗi khi thả cảm xúc: ${e.message}` });
    }
  });

  // Cài đặt Inbox cho quản trị hoặc người kiểm duyệt.
  app.put(`${base}/:channelId/settings`, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    if (req.authCtx.role !== "moderator" && !hasRole(req.authCtx.role, "ws_admin")) return reply.code(403).send({ error: "Cần quyền quản trị Inbox" });
    if (!(await guard(req, reply, channelId))) return;
    const parsed = InboxSettingsBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Dữ liệu không hợp lệ" });
    const row = await getChannelById(db, req.authCtx, channelId);
    if (!row || !isPersonalChannelKind(row.kind)) return reply.code(404).send({ error: "Không có kênh cá nhân này" });
    const config = { ...((row.config as Record<string, unknown>) ?? {}) };
    if (parsed.data.enabled !== undefined) config["inbox"] = parsed.data.enabled;
    if (parsed.data.pauseMinutes !== undefined) config["inbox_pause_minutes"] = parsed.data.pauseMinutes;
    if (parsed.data.mcpReadMessages !== undefined) config["mcp_read_messages"] = parsed.data.mcpReadMessages;
    if (parsed.data.autoReaction !== undefined) config["auto_reaction"] = parsed.data.autoReaction;
    if (parsed.data.photoAck !== undefined) config["photo_ack"] = "off";
    await updateChannel(db, req.authCtx, channelId, { config });
    const cfg = readInboxConfig(config);
    // Đặt "số phút AI tạm im" về 0 = không tạm dừng nữa → gỡ luôn các lượt tạm dừng đang treo,
    // nếu không hội thoại vừa có người trả lời vẫn im tới hết giờ cũ.
    if (parsed.data.pauseMinutes === 0) {
      const cleared = await clearInboxPauses(db, req.authCtx, channelId);
      if (cleared) broadcast(req.authCtx.workspaceId, channelId, "contacts", { channelId, count: cleared });
    }
    const st = inboxState.get(channelId);
    if (st) Object.assign(st, { enabled: cfg.enabled, pauseMinutes: cfg.pauseMinutes });
    inboxRuntime(channelId)?.setAutoReaction(cfg.autoReaction);
    await recordAudit(db, req.authCtx, "zalo_inbox.settings", { channelId, ...cfg });
    return cfg;
  });

  // File/ảnh đã gửi (lưu trong workspace) — chỉ người trực kênh
  app.get(`${base}/:channelId/file`, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    if (!(await guard(req, reply, channelId))) return;
    const query = req.query as { p?: string; download?: string; name?: string };
    const p = String(query.p ?? "");
    const ws = resolve(join(dataDir, req.authCtx.workspaceId));
    const abs = resolve(ws, p);
    if (!p || !abs.startsWith(ws + sep)) return reply.code(400).send({ error: "Đường dẫn không hợp lệ" });
    const st = await stat(abs).catch(() => null);
    if (!st?.isFile() || st.size > 50 * 1024 * 1024) return reply.code(404).send({ error: "Không tìm thấy file" });
    const buf = await readFile(abs);
    const img = sniffImage(buf);
    const name = String(query.name || abs.split(sep).pop() || "file").split(/[\\/]/).pop()!.replace(/[\r\n\x00-\x1f]/g, "").slice(0, 180) || "file";
    return reply
      .header("cache-control", "private, max-age=3600")
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", `${query.download === "1" || !img ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`)
      .type(img ? img.mime : "application/octet-stream")
      .send(buf);
  });
  }
}

export type { InboxThread };
