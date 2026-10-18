import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { decryptSecret, encryptSecret, logger } from "@penai/shared";
import { confineMediaPath } from "@penai/tools";
import {
  appendMessage,
  createSession,
  getAgentById,
  getChannelSession,
  isPaired,
  createPairing,
  mapChannelSession,
  upsertContact,
  upsertConversation,
  listEnabledChannels,
  updateChannel,
  upsertInboxObservedPeer,
  getInboxThreadAgentBlock,
  resumeAgentAfterCustomerRequest,
  getInboxMessageByMsgId,
  listInboxMessages,
  getInboxThread,
  claimOrchidOrderDispatch,
  claimOrchidOrderReport,
  finishOrchidOrderDispatch,
  claimKiotVietOrderDraft,
  hasKiotVietOrderSince,
  claimLatestKiotVietOrderForStaffUpdate,
  finishKiotVietOrderDraft,
  finishKiotVietOrderUpdate,
  finishKiotVietBillImage,
  getKiotVietCredentials,
  getMisaCredentials,
  claimMisaInvoiceDraft,
  finishMisaInvoiceDraft,
  claimMisaAccountingNotice,
  finishMisaAccountingNotice,
  latestMisaAccountingBuyer,
  getPersonContextData,
  loadMessages,
  type EnabledChannel,
  recordTraceSafe,
} from "@penai/db";
import { Scheduler, gatedProvider, runAgent } from "@penai/core";
import { CodexProvider } from "@penai/providers";
import {
  ChannelManager,
  isChannelKindSupported,
  TeamsChannel,
  TelegramChannel,
  type AgentStatus,
  type CallbackResult,
  type Channel,
  type ChannelCallback,
  type InboundHandler,
  type InboundMedia,
  type InboundMessage,
  type InboundResult,
  type OutboundButton,
  type RunHooks,
  trustedZaloMediaUrl,
} from "@penai/channels";
import { forgetInboxChannel, inboxHooks } from "./inbox.js";
import { isPersonalChannel, isPersonalChannelKind } from "@penai/channels";
import { classifyOrchidSalesScope } from "./orchid-sales-scope.js";
import { hasPersonalAddressMismatch, requiresPersonalAddressGuard } from "./persona-reply-guard.js";
import { isFreshCustomerRequest } from "./recall-policy.js";
import { orchidHandoffContext } from "./orchid-handoff-context.js";
import { editOrchidPhotoWithOpenAI } from "./orchid-photo-openai.js";
import { directPhotoPendingDir, isAuthorizedDirectPhotoSender, withDirectPhotoLock } from "./orchid-photo-direct-batch.js";
import { addDirectPhotos, directPhotoCommand } from "./orchid-photo-direct-commands.js";
import { prepareZaloPhotoPaths } from "./outbound-photo-path.js";
import {
  classifyConfirmedOrchidOrder, classifyOrchidOrderCancellation, formatOrchidOrderCancellation,
  formatOrchidOrderDispatch, mayCancelOrchidOrder, mayConfirmOrchidOrder,
  orchidCancellationFingerprint, orchidOrderSessionFingerprint, orchidOrderPayloadFingerprint,
} from "./orchid-order-dispatch.js";
import { stemCountForPhoto } from "./orchid-photo-count.js";
import { knownOrchidShippingHint, orchidShippingHintContext, completeOrchidShippingReply, orchidDeliveryPriorityContext } from "./orchid-shipping-reply.js";
import { orchidCompanyPaymentContext } from "./orchid-payment-context.js";
import { classifyOrchidFlowerComplaint, formatOrchidFlowerComplaintDispatch, orchidFlowerComplaintFingerprint } from "./orchid-flower-complaint.js";
import { createKiotVietOrchidDraft, readKiotVietOrderSlip } from "./kiotviet-api.js";
import { withKiotVietSlipImage } from "./kiotviet-slip-image.js";
import { kiotVietBillNotice } from "./kiotviet-bill-notice.js";
import { createMisaUnpublishedInvoice, lookupMisaBuyerCompany,
  previewMisaUnpublishedInvoice } from "./misa-api.js";
import { extractInvoiceEvidence, hasConfirmedBuyerCompany, hasExplicitVatApproval,
  customerInvoiceTaxCode, hasRecentCustomerInvoiceRequest, isInvoiceConfirmation,
  invoiceRequestFingerprint, staffInvoiceFingerprint } from "./misa-invoice-extract.js";
import { calculateOrchidInvoiceLine } from "./misa-invoice-policy.js";
import { missingOldInvoiceDetailsRequest, misaAccountingNotice } from "./misa-accounting-policy.js";
import { requestedOrchidYellowSamples, orchidYellowSamplePath } from "./orchid-yellow-samples.js";

/** Handler + channel theo channelId — cho webhook route (WhatsApp, Teams) dùng. */
export const channelHandlers = new Map<
  string,
  { handler: InboundHandler; channel: Channel; workspaceId: string }
>();
const orchidKiotStaffCommands = new Map<string, (threadId: string, command: "-lb" | "-cn") => Promise<string>>();
interface MisaCommandResult { notice: string; previewSent: boolean }
const orchidMisaStaffCommands = new Map<string,
  (threadId: string, command: "-xhd" | "-xuat") => Promise<MisaCommandResult>>();

export async function runOrchidKiotStaffCommand(channelId: string, threadId: string, command: "-lb" | "-cn"): Promise<string> {
  const handler = orchidKiotStaffCommands.get(channelId);
  if (!handler) throw new Error("Kênh kinh doanh chưa sẵn sàng");
  return handler(threadId, command);
}

export async function runOrchidMisaStaffCommand(channelId: string, threadId: string,
  command: "-xhd" | "-xuat" = "-xhd"): Promise<MisaCommandResult> {
  const handler = orchidMisaStaffCommands.get(channelId);
  if (!handler) throw new Error("Kênh kinh doanh chưa sẵn sàng");
  return handler(threadId, command);
}

// Lệnh từ người trực Inbox chỉ được tạo tại route đã xác thực, không đi qua Zalo.
const orchidStaffDelegations = new WeakMap<InboundMessage, string>();

export async function runOrchidStaffDelegation(
  channelId: string, threadId: string, staffMessage: string, customerName?: string,
): Promise<InboundResult> {
  const entry = channelHandlers.get(channelId);
  if (!entry || entry.channel.kind !== "zalo_personal") throw new Error("Kênh Zalo chưa sẵn sàng");
  const msg: InboundMessage = {
    channelId, channelKind: "zalo_personal", chatKey: `direct:${threadId}`,
    senderId: threadId, ...(customerName ? { senderName: customerName } : {}),
    peerKind: "direct", text: "-ld",
  };
  orchidStaffDelegations.set(msg, staffMessage);
  return entry.handler(msg);
}

/**
 * Interceptor inbound: module ngoài (bộ điều phối quy trình...) đăng ký để "nghe"
 * tin nhắn kênh TRƯỚC khi agent xử lý. Trả InboundResult = đã tiêu thụ tin
 * (không chạy agent); trả null = bỏ qua, luồng thường tiếp tục.
 */
export type InboundInterceptor = (msg: InboundMessage) => Promise<InboundResult | null>;
export const inboundInterceptors: InboundInterceptor[] = [];

/** Handler bấm nút inline (Telegram callback) — orchestrator đăng ký. */
export type ChannelCallbackHandler = (
  cb: ChannelCallback,
) => Promise<CallbackResult | undefined | void>;
export const channelCallbackHandlers: ChannelCallbackHandler[] = [];

/** Chạy chuỗi callback handler (webhook route Teams gọi; Telegram gọi qua deps.onCallback). */
export async function dispatchChannelCallback(
  cb: ChannelCallback,
): Promise<CallbackResult | undefined> {
  for (const cbHandler of channelCallbackHandlers) {
    try {
      const res = await cbHandler(cb);
      if (res) return res;
    } catch (err) {
      logger.warn(`Callback handler lỗi: ${(err as Error).message}`);
    }
  }
  return undefined;
}
import {
  buildLoopDeps,
  agentOpts,
  reasoningEffortOf,
  sanitizeUserKey,
  systemContext,
  type RuntimeDeps,
} from "./agent-runtime.js";

const PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // bỏ ký tự dễ nhầm

function genPairingCode(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => PAIR_ALPHABET[b % PAIR_ALPHABET.length]).join("");
}

/** Run đang chạy theo sessionId — cho lệnh /stop hủy giữa chừng. */
const activeRuns = new Map<string, AbortController>();

// ===== Thẻ duyệt có nút bấm (tool send_approval_card) =====
// Agent gửi thẻ (Telegram inline keyboard / Teams Adaptive Card); người dùng
// bấm → sửa thẻ khóa nút (chống bấm trùng) + bơm kết quả vào hội thoại như tin
// nhắn hệ thống để agent xử lý tiếp. State in-memory: restart làm thẻ đang chờ
// hết hiệu lực (bấm sau restart được báo lịch sự, agent gửi lại được).
interface PendingApprovalCard {
  channelId: string;
  chatKey: string;
  peerKind: "direct" | "group";
  messageId: string | null;
  text: string;
  /** value → label để hiển thị trạng thái sau khi bấm. */
  labels: Record<string, string>;
  resolved: boolean;
}
const pendingApprovalCards = new Map<string, PendingApprovalCard>();

/** Tạo + gửi thẻ duyệt trên kênh hỗ trợ nút. Trả id thẻ. */
async function sendApprovalCard(
  channel: Channel,
  channelId: string,
  chatKey: string,
  peerKind: "direct" | "group",
  input: { text: string; buttons: Array<{ label: string; value: string }> },
): Promise<string> {
  const cardId = randomBytes(4).toString("hex");
  const rows: OutboundButton[][] = [
    input.buttons.map((b) => ({
      text: b.label,
      // Telegram giới hạn callback_data 64 byte → payload gọn {pac, v}
      data: JSON.stringify({ pac: cardId, v: b.value }),
    })),
  ];
  let messageId: string | null = null;
  if (channel instanceof TeamsChannel) {
    messageId = await channel.sendCard(chatKey, input.text, rows);
  } else if (channel instanceof TelegramChannel) {
    messageId = await channel.sendWithButtons(chatKey, input.text, rows);
  } else {
    throw new Error(`Kênh ${channel.kind} chưa hỗ trợ thẻ nút bấm`);
  }
  pendingApprovalCards.set(cardId, {
    channelId,
    chatKey,
    peerKind,
    messageId,
    text: input.text,
    labels: Object.fromEntries(input.buttons.map((b) => [b.value, b.label])),
    resolved: false,
  });
  return cardId;
}

/** Handler bấm nút thẻ duyệt — đăng ký vào chuỗi callback chung (chạy mọi kênh). */
channelCallbackHandlers.push(async (cb) => {
  let payload: { pac?: string; v?: string };
  try {
    payload = JSON.parse(cb.data) as { pac?: string; v?: string };
  } catch {
    return undefined; // không phải data của thẻ duyệt — nhường handler khác
  }
  if (!payload?.pac) return undefined;
  const card = pendingApprovalCards.get(payload.pac);
  if (!card) {
    return { text: "Thẻ này đã hết hiệu lực (hệ thống vừa khởi động lại) — nhờ trợ lý gửi lại thẻ mới." };
  }
  if (card.resolved) return { text: "Thẻ đã được xử lý trước đó." };
  card.resolved = true;
  const value = String(payload.v ?? "");
  const label = card.labels[value] ?? value;
  const who = cb.senderName ?? cb.senderId;
  const at = new Date().toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit" });
  // 1. Khóa thẻ: sửa lại bỏ nút + ghi trạng thái
  const entry = channelHandlers.get(card.channelId);
  const statusLine = `\n\n— ${value === "approve" ? "✅" : value === "reject" ? "⛔" : "🔘"} **${who}** đã chọn "${label}" lúc ${at}`;
  const mid = card.messageId ?? (cb.messageId || null);
  if (entry && mid) {
    try {
      if (entry.channel instanceof TeamsChannel) {
        await entry.channel.updateCard(card.chatKey, mid, card.text + statusLine);
      } else if (entry.channel instanceof TelegramChannel) {
        await entry.channel.editMessage(card.chatKey, mid, card.text + statusLine);
      }
    } catch (err) {
      logger.warn(`Khóa thẻ duyệt ${payload.pac} lỗi: ${(err as Error).message}`);
    }
  }
  // 2. Bơm kết quả vào hội thoại như tin hệ thống → agent xử lý tiếp
  if (entry) {
    void (async () => {
      try {
        const res = await entry.handler({
          channelId: card.channelId,
          channelKind: cb.channelKind,
          chatKey: card.chatKey,
          senderId: cb.senderId,
          ...(cb.senderName ? { senderName: cb.senderName } : {}),
          peerKind: card.peerKind,
          mentioned: true,
          text:
            `[Thẻ duyệt #${payload.pac}] ${who} đã bấm "${label}" (giá trị: ${value}). ` +
            `Nội dung thẻ: """${card.text}""". Hãy tiếp tục xử lý theo quyết định này và báo kết quả.`,
        });
        if (res.kind === "reply" || res.kind === "pairing") {
          await entry.channel.send({
            chatKey: card.chatKey,
            text: res.text,
            ...(res.kind === "reply" && res.media?.length ? { media: res.media } : {}),
          });
        }
      } catch (err) {
        logger.warn(`Xử lý sau bấm thẻ duyệt lỗi: ${(err as Error).message}`);
      }
    })();
  }
  return { text: `Đã ghi nhận: ${label}` };
});

/** Marker file nội bộ — không được lọt ra cho người dùng thấy. */
const MEDIA_MARKER_RE = /\[\[media:[^\]]+\]\]/g;

// ===== Ảnh người dùng gửi qua kênh =====
// Lưu thành file trong thư mục riêng người gửi để: (1) tham chiếu lại ở các
// lượt sau (refImages của image_generation), (2) nạp lại vào vision.
// Theo dõi tối đa RECENT_IMAGES_MAX ảnh gần nhất mỗi session (in-memory —
// restart mất vision nạp lại nhưng file + tên trong lịch sử vẫn còn).
const RECENT_IMAGES_MAX = 5;
const recentImages = new Map<string, Array<{ name: string; path: string }>>();
/** Số lần liên tiếp chỉ-gửi-ảnh trong 1 session — để ack lần 2+ ngắn gọn. */
const imageOnlyStreak = new Map<string, number>();

export function extOfDataUrl(dataUrl: string): string {
  const m = /^data:image\/(\w+)/.exec(dataUrl);
  const t = m?.[1]?.toLowerCase();
  return t === "jpeg" ? "jpg" : (t ?? "jpg");
}

/**
 * Slug ASCII từ caption/tin nhắn để đặt tên file dễ tham chiếu, đỡ lỗi đường
 * dẫn (bỏ dấu tiếng Việt, kebab-case, tối đa ~6 từ). "Logo công ty mình
 * lưu lại nhé" → "logo-cong-ty-minh-luu-lai".
 */
export function slugFromCaption(text: string | undefined, maxWords = 6): string {
  if (!text) return "";
  const ascii = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replaceAll("đ", "d")
    .replaceAll("Đ", "D")
    .toLowerCase();
  const words = ascii
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords);
  return words.join("-").slice(0, 48).replace(/-+$/, "");
}

/** Ghi file với tên mong muốn, trùng thì thêm hậu tố -2, -3... (không ghi đè). */
async function writeUnique(
  userDir: string,
  stem: string,
  ext: string,
  data: Buffer,
): Promise<{ name: string; path: string } | null> {
  for (let i = 1; i < 50; i++) {
    const name = i === 1 ? `${stem}${ext}` : `${stem}-${i}${ext}`;
    const abs = join(userDir, name);
    try {
      await writeFile(abs, data, { flag: "wx" });
      return { name, path: abs };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        logger.warn(`Không lưu được file inbound "${name}": ${(err as Error).message}`);
        return null;
      }
    }
  }
  return null;
}

/**
 * Ghi các ảnh inbound thành file trong thư mục người gửi. Có caption → tên
 * slug theo caption (vd "logo-cong-ty.jpg"); không có → `anh-nhan-<stamp>`.
 */
export async function saveInboundImages(
  userDir: string,
  photos: InboundMedia[],
  caption?: string,
): Promise<Array<{ name: string; path: string }>> {
  const out: Array<{ name: string; path: string }> = [];
  if (!photos.length) return out;
  await mkdir(userDir, { recursive: true });
  const ts = new Date();
  const stamp =
    String(ts.getDate()).padStart(2, "0") +
    String(ts.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(ts.getHours()).padStart(2, "0") +
    String(ts.getMinutes()).padStart(2, "0") +
    String(ts.getSeconds()).padStart(2, "0");
  const slug = slugFromCaption(caption);
  let i = 0;
  for (const p of photos) {
    if (!p.dataUrl) continue;
    i++;
    const b64 = p.dataUrl.slice(p.dataUrl.indexOf(",") + 1);
    const ext = `.${extOfDataUrl(p.dataUrl)}`;
    const stem = slug
      ? photos.length > 1
        ? `${slug}-${i}`
        : slug
      : `anh-nhan-${stamp}-${i}`;
    const saved = await writeUnique(userDir, stem, ext, Buffer.from(b64, "base64"));
    if (saved) out.push(saved);
  }
  return out;
}

/** Tên file an toàn từ tên gốc người dùng gửi (giữ đuôi, bỏ ký tự lạ). */
export function safeDocName(name: string): string {
  const base = name.replaceAll("\\", "/").split("/").pop() ?? "file";
  const safe = base.replace(/[^a-zA-Z0-9à-ỹÀ-Ỹ._ -]/g, "_").trim().slice(0, 100);
  return safe && safe !== "." && safe !== ".." ? safe : "file";
}

/**
 * Lưu document inbound (PDF/Word/Excel...). Tên file = slug chuẩn ASCII:
 * 1 file + có caption → slug theo caption; còn lại slug hóa tên gốc
 * ("Bảng Giá (v2).XLSX" → "bang-gia-v2.xlsx"). Trùng tên → hậu tố -2.
 */
export async function saveInboundDocs(
  userDir: string,
  docs: InboundMedia[],
  caption?: string,
): Promise<Array<{ name: string; path: string }>> {
  const out: Array<{ name: string; path: string }> = [];
  if (!docs.length) return out;
  await mkdir(userDir, { recursive: true });
  const captionSlug = docs.length === 1 ? slugFromCaption(caption) : "";
  for (const d of docs) {
    if (!d.dataB64) continue;
    const base = safeDocName(d.name ?? "file");
    const dot = base.lastIndexOf(".");
    const origStem = dot > 0 ? base.slice(0, dot) : base;
    const ext = (dot > 0 ? base.slice(dot) : "").toLowerCase();
    const stem = captionSlug || slugFromCaption(origStem, 8) || "file";
    const saved = await writeUnique(userDir, stem, ext, Buffer.from(d.dataB64, "base64"));
    if (saved) out.push(saved);
  }
  return out;
}

/** Đọc lại các ảnh gần nhất của session thành data URL cho vision. */
async function recentImagesAsDataUrls(sessionId: string): Promise<string[]> {
  const list = recentImages.get(sessionId) ?? [];
  const out: string[] = [];
  for (const img of list.slice(-RECENT_IMAGES_MAX)) {
    try {
      const buf = await readFile(img.path);
      const ext = img.name.split(".").pop() ?? "jpg";
      const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      out.push(`data:${mime};base64,${buf.toString("base64")}`);
    } catch {
      // file đã bị xóa → bỏ qua
    }
  }
  return out;
}

/**
 * Đuôi file được TỰ ĐỘNG gửi cho người dùng khi agent tạo ra trong lượt chat.
 * Người dùng bảo "tạo file X" là muốn nhận file, không muốn phải xin thêm lần
 * nữa. Script trung gian (.py/.js/.sh...) cố ý KHÔNG nằm trong danh sách.
 */
const AUTO_SEND_EXT = new Set([
  "docx", "doc", "xlsx", "xls", "pptx", "ppt", "pdf", "rtf", "odt", "ods", "odp",
  "csv", "txt", "md", "json", "xml", "html", "htm",
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg",
  "mp3", "wav", "ogg", "m4a", "mp4", "mov", "webm",
  "zip", "rar", "7z", "tar", "gz",
]);

/** File hệ thống của agent — không bao giờ tự gửi. */
const NEVER_AUTO_SEND = new Set(["user.md", "agent.md"]);

const AUTO_SEND_MAX_FILES = 5;
const AUTO_SEND_MAX_BYTES = 45 * 1024 * 1024;

/** Ảnh chụp trạng thái file trong thư mục làm việc: path → "mtime:size". */
export async function snapshotWorkDir(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 4 || out.size > 2000) return;
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "__pycache__" || e.name === "node_modules") {
        continue;
      }
      const full = resolve(d, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else {
        const info = await stat(full).catch(() => null);
        if (info) out.set(full, `${info.mtimeMs}:${info.size}`);
      }
    }
  };
  await walk(dir, 0);
  return out;
}

/** File mới tạo hoặc vừa sửa trong lượt chat, đáng gửi cho người dùng. */
export async function newDeliverables(
  dir: string,
  before: Map<string, string>,
): Promise<string[]> {
  const after = await snapshotWorkDir(dir);
  const changed: Array<{ path: string; mtime: number }> = [];
  for (const [path, sig] of after) {
    if (before.get(path) === sig) continue;
    const name = path.split(/[\\/]/).pop() ?? "";
    if (NEVER_AUTO_SEND.has(name.toLowerCase())) continue;
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    if (!AUTO_SEND_EXT.has(ext)) continue;
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size === 0 || info.size > AUTO_SEND_MAX_BYTES) continue;
    changed.push({ path, mtime: info.mtimeMs });
  }
  // file mới nhất trước, giới hạn số lượng để không spam
  return changed
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, AUTO_SEND_MAX_FILES)
    .map((c) => c.path);
}

/**
 * Nhóm Zalo demo: người dùng hay nhắn vài tin liên tiếp rồi mới tag bot.
 * Các tin chưa tag bị gate mention bỏ qua sẽ được đệm lại ở đây; khi có tin
 * tag bot, các tin liền trước của CÙNG người gửi trong cửa sổ thời gian được
 * nối vào làm ngữ cảnh để agent hiểu trọn ý.
 */
const groupChatter = new Map<
  string,
  Array<{ senderId: string; text: string; at: number }>
>();
const CHATTER_MAX = 10;
const CHATTER_WINDOW_MS = 60_000;

/** Ghép các tin liền trước (cùng người gửi, còn trong cửa sổ) vào tin được tag. */
export function joinGroupChatter(
  chatterKey: string,
  senderId: string,
  senderName: string | undefined,
  text: string,
  now = Date.now(),
): string {
  const list = groupChatter.get(chatterKey) ?? [];
  const prior = list.filter(
    (e) => e.senderId === senderId && now - e.at <= CHATTER_WINDOW_MS,
  );
  // dọn: bỏ tin đã dùng + tin quá hạn của mọi người
  const rest = list.filter(
    (e) => !prior.includes(e) && now - e.at <= CHATTER_WINDOW_MS,
  );
  if (rest.length) groupChatter.set(chatterKey, rest);
  else groupChatter.delete(chatterKey);
  if (!prior.length) return text;
  return (
    `[Ngữ cảnh — các tin nhắn liền trước của ${senderName ?? "người gửi"} trong nhóm, chưa được trả lời]\n` +
    prior.map((e) => `• ${e.text}`).join("\n") +
    `\n\n[Tin nhắn hiện tại — người gửi tag bạn, hãy trả lời trọn ý các tin trên]\n` +
    text
  );
}

/** Đệm 1 tin nhóm chưa tag (gọi cả khi orchestrator tiêu thụ tin đó). */
export function bufferGroupChatter(
  chatterKey: string,
  senderId: string,
  text: string,
  now = Date.now(),
): void {
  if (!text.trim()) return;
  const list = (groupChatter.get(chatterKey) ?? []).filter(
    (e) => now - e.at <= CHATTER_WINDOW_MS,
  );
  list.push({ senderId, text: text.slice(0, 1000), at: now });
  groupChatter.set(chatterKey, list.slice(-CHATTER_MAX));
}

/** Map tên tool → trạng thái reaction (đang chạy code / truy cập web / dùng tool). */
function toolReactionStatus(toolName: string): AgentStatus {
  if (toolName.startsWith("web") || toolName === "browser") return "web";
  if (toolName === "exec") return "coding";
  return "tool";
}

/** Ghép nội dung media vào user message cho LLM (ảnh ghi rõ tên file đã lưu). */
export function mergeMediaText(
  text: string,
  media: InboundMedia[] | undefined,
  savedImageNames: string[] = [],
  savedDocNames: string[] = [],
): string {
  if (!media?.length) return text;
  const parts: string[] = [];
  let photoIdx = 0;
  let docIdx = 0;
  for (const m of media) {
    if (m.text !== undefined) {
      const saved = m.dataB64 ? savedDocNames[docIdx++] : undefined;
      parts.push(
        `[Nội dung file "${m.name ?? "đính kèm"}"${saved ? ` — đã lưu tại: ${saved}` : ""}]:\n${m.text}`,
      );
    } else if (m.kind === "document" && m.dataB64) {
      const saved = savedDocNames[docIdx++];
      parts.push(
        saved
          ? `[Người dùng gửi file, đã lưu tại: ${saved} — đọc nội dung bằng tool read_document]`
          : `[Người dùng gửi file "${m.name ?? "?"}" nhưng lưu thất bại]`,
      );
    } else if (m.note) {
      parts.push(m.note);
    } else if (m.kind === "photo" && m.dataUrl) {
      const name = savedImageNames[photoIdx++];
      parts.push(
        name
          ? `[Người dùng gửi kèm ảnh, đã lưu tại: ${name}]`
          : "[Người dùng gửi kèm 1 ảnh]",
      );
    }
  }
  return [text, ...parts].filter(Boolean).join("\n\n");
}

/** Xây handler xử lý inbound cho 1 channel cụ thể. */
export function makeInboundHandler(
  rt: RuntimeDeps,
  queue: Scheduler,
  channel: EnabledChannel,
): InboundHandler {
  const { db } = rt.db;
  if (channel.kind === "zalo_personal" &&
      ["cdf2a276-fa3d-4fe3-a46b-3ce1162a7678", "657116ed-7570-4f2e-8550-a3d323618724", "6bc2dc02-3d10-4737-931d-a37532bcabb2"].includes(channel.id)) {
    orchidMisaStaffCommands.set(channel.id, async (threadId, command) => {
      if (command === "-xuat") {
        throw new Error("Chưa bật phát hành tự động: cần kiểm tra hóa đơn nháp và cấu hình ký số MISA. Không phát hành hóa đơn.");
      }
      const ctx = systemContext(channel.workspaceId);
      const thread = await getInboxThread(db, ctx, channel.id, threadId);
      if (!thread || thread.kind !== "direct") throw new Error("-xhd chỉ dùng trong hội thoại khách hàng đã có");
      const agent = channel.agentId ? await getAgentById(db, ctx, channel.agentId) : null;
      if (agent?.key !== "nhan-vien-kinh-doanh-orchids-world") throw new Error("Kênh chưa gắn Agent kinh doanh");
      const credentials = await getMisaCredentials(db, ctx);
      if (!credentials) throw new Error("MISA chưa kết nối trong trang quản trị PenAI");
      if (!credentials.draftEnabled) throw new Error("Kết nối MISA đang chờ kiểm tra lưu nháp; chưa bật lệnh -xhd");
      const history = await listInboxMessages(db, ctx, channel.id, threadId, { limit: 200 });
      const provider = rt.providers.get(agent.provider, ctx.workspaceId);
      const limited = rt.gate ? gatedProvider(rt.gate, provider, { providerKey: agent.provider, priority: 0 }) : provider;
      const accountingInfo = await latestMisaAccountingBuyer(db, ctx, channel.id, threadId);
      const evidence = await extractInvoiceEvidence(limited, agent.model, history, accountingInfo);
      if (!evidence) throw new Error("Thiếu MST, loại chậu, số cành thực tế hoặc giá đã chốt; chưa tạo hóa đơn");
      if (evidence.buyerTaxCode === credentials.taxCode) {
        throw new Error("MST bên mua trùng MST bên bán; cần xác minh lại giao dịch trước khi lập nháp");
      }
      const humanText = history.filter((m) => m.direction === "in" || ["web", "app", "mcp"].includes(m.source))
        .map((m) => m.text).join("\n") + (accountingInfo ? `\n${accountingInfo.taxCode}\n${accountingInfo.email}` : "");
      if (!humanText.includes(evidence.buyerTaxCode) || (evidence.buyerEmail &&
          !humanText.toLocaleLowerCase("vi-VN").includes(evidence.buyerEmail.toLocaleLowerCase("vi-VN")))) {
        throw new Error("MST hoặc email xuất hóa đơn không có bằng chứng trong tin khách/nhân viên; chưa tạo hóa đơn");
      }
      if (credentials.priceIncludesVat || credentials.vatRate !== 5) {
        throw new Error("Cấu hình MISA phải là giá chưa VAT và mức chuẩn 5% trước khi lập nháp");
      }
      const line = calculateOrchidInvoiceLine(evidence);
      if (!hasExplicitVatApproval(history, evidence, line.vatRate)) {
        throw new Error(`Chưa thấy báo VAT ${line.vatRate}% và khách đồng ý trong hội thoại; chưa tạo hóa đơn`);
      }
      const login = { taxCode: credentials.taxCode, username: credentials.username,
        password: decryptSecret(credentials.passwordEncrypted) };
      const buyer = await lookupMisaBuyerCompany(login, evidence.buyerTaxCode);
      const accountantOverride = accountingInfo?.taxCode === evidence.buyerTaxCode &&
        accountingInfo.companyName === buyer.name && !!missingOldInvoiceDetailsRequest(history);
      if (!accountantOverride && !hasConfirmedBuyerCompany(history, evidence, buyer.name)) {
        throw new Error(`Cần hỏi khách xác nhận đúng công ty ${buyer.name} và chờ khách đồng ý trước khi lập nháp`);
      }
      const fingerprint = invoiceRequestFingerprint(history) ?? staffInvoiceFingerprint(evidence);
      const claimId = await claimMisaInvoiceDraft(db, ctx, {
        channelId: channel.id, threadId, fingerprint,
        buyerName: buyer.name, totalAmount: line.totalAfterVat,
      });
      if (!claimId) throw new Error("Yêu cầu này đã có hóa đơn nháp hoặc đang cần kiểm tra trên MISA; không tạo trùng");
      try {
        const saved = await createMisaUnpublishedInvoice(login, {
          buyerName: buyer.name, buyerTaxCode: evidence.buyerTaxCode,
          buyerAddress: buyer.address, buyerEmail: evidence.buyerEmail,
          buyerContact: evidence.buyerContact, itemName: line.itemName,
          itemCode: line.itemCode, unitName: line.unitName,
          quantity: line.quantity, unitPrice: line.unitPrice, vatRate: line.vatRate,
          series: credentials.invoiceSeries,
        });
        await finishMisaInvoiceDraft(db, ctx, claimId, { refId: saved.refId });
        const accountingGroupId = channel.config["orchid_invoice_accounting_group"];
        let accountingNotice = "";
        if (typeof accountingGroupId === "string" && /^\d{1,30}$/.test(accountingGroupId)) {
          try {
          const customer = thread.contactAlias || thread.profileName || thread.name || buyer.name;
          const noticeText = misaAccountingNotice("draft_saved", customer, channel.name);
          const noticeId = await claimMisaAccountingNotice(db, ctx, {
            channelId: channel.id, threadId, eventKey: `draft:${saved.refId}`,
            kind: "draft_saved", groupId: accountingGroupId, message: noticeText, refId: saved.refId,
          });
          if (noticeId) {
            try {
              const runtime = channelHandlers.get(channel.id)?.channel;
              if (!isPersonalChannel(runtime) || !runtime.isConnected()) throw new Error("Zalo chưa kết nối");
              const ids = await runtime.sendManual({ threadId: accountingGroupId, peerKind: "group",
                text: noticeText, source: "agent", threadName: "Kế Toán Orchids World" });
              if (!ids[0]) throw new Error("Zalo không trả mã tin nhóm");
              await finishMisaAccountingNotice(db, ctx, noticeId, { messageId: ids[0] });
              accountingNotice = " Đã báo nhóm Kế Toán Orchids World.";
            } catch (error) {
              await finishMisaAccountingNotice(db, ctx, noticeId, { error: String(error) }).catch(() => {});
              accountingNotice = " Chưa báo được nhóm Kế Toán Orchids World; cần nhân viên kiểm tra.";
            }
          }
          } catch (error) {
            logger.warn(`misa.accounting_draft_notice_fail: ${String(error)}`);
            accountingNotice = " Chưa báo được nhóm Kế Toán Orchids World; cần nhân viên kiểm tra.";
          }
        }
        let previewSent = false;
        try {
          const bytes = await previewMisaUnpublishedInvoice(login, saved.refId);
          const dir = join(rt.config.dataDir, channel.workspaceId, "misa-previews");
          await mkdir(dir, { recursive: true, mode: 0o700 });
          const previewPath = join(dir, `${saved.refId}.pdf`);
          await writeFile(previewPath, bytes, { mode: 0o600 });
          try {
            const runtime = channelHandlers.get(channel.id)?.channel;
            if (!isPersonalChannel(runtime) || !runtime.isConnected()) throw new Error("Zalo chưa kết nối");
            const ids = await runtime.sendManual({ threadId, peerKind: "direct", source: "agent",
              filePaths: [previewPath], threadName: thread.name });
            if (!ids.length) throw new Error("Zalo không xác nhận gửi PDF nháp");
            previewSent = true;
            await runtime.sendManual({ threadId, peerKind: "direct", source: "agent",
              text: `Em gửi anh/chị bản xem trước hóa đơn nháp cho ${buyer.name}. Hóa đơn chưa phát hành; anh/chị vui lòng kiểm tra thông tin giúp em.`,
              threadName: thread.name });
          } finally {
            await rm(previewPath, { force: true }).catch(() => {});
          }
        } catch (error) {
          logger.warn(`misa.preview_send_fail: ${String(error)}`);
        }
        return { notice: `Đã lưu hóa đơn nháp MISA cho ${buyer.name}; chưa phát hành.${accountingNotice} ` +
          (previewSent ? "Đã gửi bản xem trước cho khách." : "Chưa gửi được bản xem trước; nhân viên cần kiểm tra và gửi cho khách."), previewSent };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await finishMisaInvoiceDraft(db, ctx, claimId, { error: reason, uncertain: true });
        throw new Error(`${reason} Không tự gửi lại vì MISA có thể đã nhận; kiểm tra trên MISA trước.`);
      }
    });
    orchidKiotStaffCommands.set(channel.id, async (threadId, command) => {
      const ctx = systemContext(channel.workspaceId);
      const thread = await getInboxThread(db, ctx, channel.id, threadId);
      if (!thread || thread.kind !== "direct") throw new Error("Chỉ dùng lệnh trong hội thoại khách hàng đã có");
      const agent = channel.agentId ? await getAgentById(db, ctx, channel.agentId) : null;
      if (agent?.key !== "nhan-vien-kinh-doanh-orchids-world") throw new Error("Kênh chưa gắn Agent kinh doanh");
      const credentials = await getKiotVietCredentials(db, ctx);
      if (!credentials?.branchId) throw new Error("KiotViet chưa kết nối chi nhánh nhận đơn");
      const billGroupId = channel.config["kiotviet_bill_group"];
      if (typeof billGroupId !== "string" || !/^\d{1,30}$/.test(billGroupId)) throw new Error("Chưa cấu hình nhóm Đã lên bill");
      const runtime = channelHandlers.get(channel.id)?.channel;
      if (!isPersonalChannel(runtime) || !runtime.isConnected()) throw new Error("Zalo của kênh chưa kết nối");
      const history = await listInboxMessages(db, ctx, channel.id, threadId, { limit: 200 });
      const provider = rt.providers.get(agent.provider, ctx.workspaceId);
      const limited = rt.gate ? gatedProvider(rt.gate, provider, { providerKey: agent.provider, priority: 0 }) : provider;
      const now = new Date();
      const order = await classifyConfirmedOrchidOrder(limited, agent.model, history,
        { text: command, senderName: "Nhân viên" }, now, "staff");
      if (!order) throw new Error("Chưa xác định đủ số cành và màu của đơn hiện tại; chưa gọi KiotViet");
      const customer = thread.contactAlias || thread.profileName || thread.name;
      const common = {
        retailer: credentials.retailer, clientId: decryptSecret(credentials.clientIdEncrypted),
        clientSecret: decryptSecret(credentials.clientSecretEncrypted), branchId: credentials.branchId,
        ...(credentials.cashierUserId ? { cashierUserId: credentials.cashierUserId } : {}),
        customer, customerPhone: thread.phone, channelName: channel.name,
        stems: order.stems, color: order.color, pot: order.pot, price: order.price,
        delivery: order.delivery, address: order.address, recipientPhone: order.recipientPhone,
        cardText: order.cardText, instructions: order.instructions, shippingFee: order.shippingFee,
        vatFee: order.vatFee, companyInvoice: order.companyInvoice,
      };
      const fingerprint = orchidOrderSessionFingerprint(history, order, now);
      const payloadFingerprint = orchidOrderPayloadFingerprint(order);
      const claim = command === "-lb"
        ? await claimKiotVietOrderDraft(db, ctx, { channelId: channel.id, threadId, fingerprint, payloadFingerprint })
        : await claimLatestKiotVietOrderForStaffUpdate(db, ctx, channel.id, threadId);
      if (!claim) throw new Error(command === "-lb" ? "Đơn này đã có phiếu hoặc đang xử lý; dùng -cn để bổ sung"
        : "Chưa có phiếu đặt hàng để cập nhật");
      const id = typeof claim === "string" ? claim : claim.id;
      let saved: { orderId: number; code: string };
      try {
        saved = await createKiotVietOrchidDraft({ ...common,
          ...(command === "-cn" && typeof claim !== "string" ? { existing: {
            orderId: claim.orderId, code: claim.code, fillMissing: true as const,
          } } : {}),
        });
        if (command === "-lb") await finishKiotVietOrderDraft(db, ctx, id, saved);
        else await finishKiotVietOrderUpdate(db, ctx, id, { payloadFingerprint });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (command === "-lb") await finishKiotVietOrderDraft(db, ctx, id, { error: reason });
        else await finishKiotVietOrderUpdate(db, ctx, id, { error: reason });
        throw error;
      }
      try {
        const slip = await readKiotVietOrderSlip({ retailer: credentials.retailer,
          clientId: common.clientId, clientSecret: common.clientSecret,
          orderId: saved.orderId, code: saved.code });
        const notice = kiotVietBillNotice(command === "-lb" ? "create" : "update", saved.code, customer);
        const ids = await withKiotVietSlipImage({ ...slip, delivery: order.delivery },
          { dataDir: rt.config.dataDir, workspaceId: ctx.workspaceId, channelId: channel.id }, (path) => runtime.sendManual({
          threadId: billGroupId, peerKind: "group", text: notice, filePaths: [path],
          source: "agent", threadName: "Đã Lên Bill",
        }));
        if (!ids.length) throw new Error("Zalo không trả mã xác nhận gửi nhóm");
        await finishKiotVietBillImage(db, ctx, id, { groupId: billGroupId, msgId: ids.at(-1)! });
        return `${notice} Đã gửi ảnh phiếu vào nhóm Đã lên bill.`;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await finishKiotVietBillImage(db, ctx, id, { error: reason }).catch(() => {});
        throw new Error(`Phiếu ${saved.code} đã lưu trên KiotViet nhưng chưa gửi được ảnh nhóm: ${reason}`);
      }
    });
  }
  return async (msg, hooks?: RunHooks): Promise<InboundResult> => {
    const ctx = systemContext(channel.workspaceId);
    const staffDelegation = orchidStaffDelegations.get(msg);
    const hasPhoto = (msg.media ?? []).some((m) => m.kind === "photo");
    const silentPhoto = hasPhoto && !msg.text.trim();
    const photoEditOnlyGroup = msg.channelKind === "zalo_personal" &&
      msg.peerKind === "group" && channel.config["auto_edit_photo_group"] === msg.chatKey;
    const photoEditDirect = isAuthorizedDirectPhotoSender({
      channelKind: msg.channelKind, peerKind: msg.peerKind, senderId: msg.senderId,
      chatKey: msg.chatKey, configuredSender: channel.config["auto_edit_photo_sender"],
    });
    if (photoEditOnlyGroup && !hasPhoto) return { kind: "ignore" };
    const autoEditPhoto = photoEditOnlyGroup && hasPhoto;

    // Nhóm Zalo: đệm tin chưa tag làm ngữ cảnh (kể cả tin orchestrator sẽ
    // tiêu thụ) — người dùng hay nhắn vài tin liên tiếp rồi mới tag bot.
    const isZaloGroup =
      msg.peerKind === "group" && isPersonalChannelKind(msg.channelKind);
    const chatterKey = `${channel.id}:${msg.chatKey}`;
    if (isZaloGroup && msg.mentioned === false) {
      bufferGroupChatter(chatterKey, msg.senderId, msg.text);
    }

    // Interceptor (bộ điều phối quy trình...): chạy TRƯỚC pairing/agent — phản hồi
    // của đại lý trong nhóm demo phải tới orchestrator dù người gửi chưa pair.
    for (const interceptor of silentPhoto || autoEditPhoto || staffDelegation ? [] : inboundInterceptors) {
      try {
        const res = await interceptor(msg);
        if (res) return res;
      } catch (err) {
        logger.warn(`Interceptor inbound lỗi: ${(err as Error).message}`);
      }
    }

    // Công tắc "Agent tự trả lời" của kênh (Channels → Sửa). Bỏ tick = kênh vẫn
    // kết nối + Inbox vẫn lưu tin, chỉ agent không trả lời. Lịch hẹn vẫn gửi (đi đường khác).
    if (channel.config["agent_reply"] === false) return { kind: "ignore" };

    // Inbox Zalo: nhân viên đã tắt AI cho hội thoại này, hoặc vừa trả lời tay
    // (web/điện thoại) → AI im trong lúc tạm dừng.
    if (isPersonalChannelKind(msg.channelKind) && !staffDelegation) {
      const threadId = msg.chatKey.slice(msg.chatKey.indexOf(":") + 1);
      const block = await getInboxThreadAgentBlock(db, ctx, channel.id, threadId).catch((error) => {
        logger.warn(`Không đọc được trạng thái AI của hội thoại ${channel.id}/${threadId}: ${String(error)}`);
        return "unavailable" as const;
      });
      if (block === "recalled") {
        if (!isFreshCustomerRequest(msg.text)) return { kind: "ignore" };
        const resumed = await resumeAgentAfterCustomerRequest(
          db, ctx, channel.id, threadId, msg.sentAt ?? new Date(),
        ).catch(() => false);
        if (!resumed) return { kind: "ignore" };
      } else if (block) return { kind: "ignore" };
    }

    // Nhóm Zalo chỉ kích hoạt khi được tag/reply/gọi lệnh, kể cả khi cấu hình cũ
    // từng tắt require_mention. Kênh cá nhân khác giữ cấu hình hiện có.
    if (
      msg.peerKind === "group" &&
      isPersonalChannelKind(msg.channelKind) &&
      (msg.channelKind === "zalo_personal" || channel.config["require_mention"] !== false) &&
      msg.mentioned === false && !autoEditPhoto
    ) {
      return { kind: "ignore" };
    }

    // Ghi contact TRƯỚC cổng pairing để danh sách chờ duyệt có tên hiển thị
    // (chỉ metadata tên + id — người lạ chưa duyệt cũng cần nhận diện được).
    const channelIdentity = await upsertContact(db, ctx, {
      channelId: channel.id,
      channelKind: channel.kind,
      externalId: msg.senderId,
      ...(msg.senderName ? { displayName: msg.senderName } : {}),
    }).catch((err) =>
      (logger.warn(`upsertContact (pre-pairing) lỗi: ${(err as Error).message}`), undefined),
    );

    // Duyệt nhóm theo thread; không bắt từng thành viên ghép nối lần nữa.
    // DM vẫn phải có pairing đã duyệt.
    if (channel.requirePairing && !staffDelegation && !silentPhoto && !(msg.channelKind === "zalo_personal" && msg.peerKind === "group")) {
      const paired = await isPaired(db, ctx, channel.id, msg.senderId);
      if (!paired) {
        const pairing = await createPairing(db, ctx, channel.id, genPairingCode(), msg.senderId);
        if (!pairing.created) return { kind: "ignore" };
        return {
          kind: "pairing",
          text:
            `👋 Xin chào! Bạn cần được duyệt trước khi dùng trợ lý này.\n` +
            `Mã ghép nối của bạn: *${pairing.code}*\n` +
            `Vui lòng gửi mã này cho quản trị viên để được duyệt.`,
        };
      }
    }

    const conversationId = await upsertConversation(db, ctx, {
      channelId: channel.id,
      externalChatId: msg.chatKey,
      peerKind: msg.peerKind === "group" ? "group" : "direct",
      title: msg.senderName ?? msg.chatKey,
    }).catch((err) =>
      (logger.warn(`upsertConversation lỗi: ${(err as Error).message}`), undefined),
    );

    // Resolve/tạo session cho hội thoại này
    let sessionId = await getChannelSession(db, ctx, channel.id, msg.chatKey);
    if (!sessionId) {
      const s = await createSession(db, ctx, {
        agentId: channel.agentId,
        title: `${channel.kind}:${msg.senderName ?? msg.chatKey}`,
      });
      await mapChannelSession(db, ctx, channel.id, msg.chatKey, s.id);
      sessionId = s.id;
    }

    // Hot 4 gửi ảnh riêng, rồi -sa thay bộ hoặc -bs bổ sung. -het đã ngừng dùng.
    const photoCommand = directPhotoCommand(msg.text);
    const retiredPhotoCommand = msg.text.trim().toLowerCase() === "-het";
    if (photoEditDirect && (hasPhoto || photoCommand || retiredPhotoCommand)) {
      const userKey = `${channel.kind}-${msg.senderId}`;
      const userDir = resolve(join(rt.config.dataDir, ctx.workspaceId, "users", sanitizeUserKey(userKey)));
      const pendingDir = directPhotoPendingDir(userDir);
      return withDirectPhotoLock(`${channel.id}:${msg.senderId}`, async () => {
        try {
          if (retiredPhotoCommand) {
            // Discard photos queued for this retired command, so a later -sa/-bs
            // cannot accidentally add a color the staff intended to remove.
            await rm(pendingDir, { recursive: true, force: true });
            return { kind: "reply", text: "Lệnh -het đã tắt. Anh xóa ảnh hết màu thủ công trong shared/hinh-hoa-dang-co-42dbp nhé." };
          }
          const photos = (msg.media ?? []).filter((m) => m.kind === "photo" && m.dataUrl);
          if (photos.length) {
            const saved = await saveInboundImages(pendingDir, photos, msg.text);
            if (saved.length !== photos.length) throw new Error("Chưa lưu đủ ảnh gốc; chưa cập nhật thư mục");
            if (!photoCommand) return { kind: "ignore" };
          }
          if (!photoCommand) return { kind: "ignore" };
          const workspaceDir = join(rt.config.dataDir, ctx.workspaceId);
          const agent = await getAgentById(db, ctx, channel.agentId);
          const provider = agent ? rt.providers.get(agent.provider, ctx.workspaceId) : null;
          const editor = provider instanceof CodexProvider ? provider : {
            generateImage: async (): Promise<never> => { throw new Error("Agent sửa ảnh chưa kết nối ChatGPT (codex)"); },
          };
          const published = await addDirectPhotos({
            command: photoCommand,
            pendingDir, workspaceDir,
            agentPrompt: agent?.systemPrompt ?? "",
            editor, carrierModel: agent?.model ?? "gpt-6-sol",
            onPublished: async (count) => {
              await hooks?.onBlockReply?.(`Đã cập nhật ngay ${count} ảnh gốc trong bộ màu. Đang sửa ảnh nét, ánh sáng tự nhiên và mờ nền.`);
            },
          });
          await appendMessage(db, ctx, sessionId!, {
            role: "user", content: { kind: "text", text: `[${photoCommand}: cập nhật ${published.count} ảnh trong shared/hinh-hoa-dang-co-42dbp; sửa xong ${published.edited}]` },
          }).catch(() => {});
          const unfinished = published.count - published.edited;
          return { kind: "reply", text: unfinished
            ? `Đã cập nhật ${published.count} ảnh; sửa xong ${published.edited} ảnh, ${unfinished} ảnh vẫn là bản gốc vì sửa ảnh lỗi.`
            : `Đã cập nhật và sửa xong ${published.count} ảnh trong shared/hinh-hoa-dang-co-42dbp.`, media: published.files };
        } catch (error) {
          logger.warn(`Không xử lý được ảnh ${photoCommand} ${channel.id}/${msg.senderId}: ${String(error)}`);
          if (!photoCommand) return { kind: "ignore" };
          return { kind: "reply", text: `Chưa thực hiện lệnh ${photoCommand}: ${error instanceof Error ? error.message : "lỗi không xác định"}.` };
        }
      });
    }

    // Ảnh không kèm lời nhắn chỉ được lưu làm ngữ cảnh cho lượt sau.
    // Ảnh kèm chữ đi tiếp qua luồng agent để trả lời câu hỏi của khách.
    if (autoEditPhoto) {
      const userKey = `${channel.kind}-${msg.senderId}`;
      const userDir = resolve(join(rt.config.dataDir, ctx.workspaceId, "users", sanitizeUserKey(userKey)));
      try {
        const agent = await getAgentById(db, ctx, channel.agentId);
        if (!agent) throw new Error("OC2 chưa có Agent chỉnh ảnh");
        const imageProvider = rt.providers.get(agent.provider, ctx.workspaceId);
        if (!(imageProvider instanceof CodexProvider)) {
          throw new Error("OC2 cần Agent dùng provider ChatGPT (codex)");
        }
        const photos = (msg.media ?? []).filter((m) => m.kind === "photo" && m.dataUrl).slice(0, 6);
        const saved = await saveInboundImages(userDir, photos);
        if (!saved.length) {
          logger.warn(`Không đọc được ảnh nhóm ${channel.id}/${msg.chatKey}; không gửi tin nhắn lỗi`);
          return { kind: "ignore" };
        }
        const edited: string[] = [];
        for (const original of saved) {
          const output = join(userDir, `anh-da-chinh-${randomBytes(8).toString("hex")}.jpg`);
          const image = await editOrchidPhotoWithOpenAI(
            await readFile(original.path), agent.systemPrompt, imageProvider, agent.model,
          );
          await writeFile(output, image.data);
          edited.push(output);
        }
        const list = [...(recentImages.get(sessionId) ?? []), ...saved,
          ...edited.map((path) => ({ path, name: path.split(/[\\/]/).pop() ?? "anh-da-chinh.jpg" }))];
        recentImages.set(sessionId, list.slice(-RECENT_IMAGES_MAX));
        await appendMessage(db, ctx, sessionId, {
          role: "user",
          content: { kind: "text", text: `[${msg.senderName ?? "Thành viên"} gửi ${saved.length} ảnh trong nhóm để chỉnh ảnh]` },
        });
        return { kind: "reply", text: "", media: edited };
      } catch (error) {
        logger.warn(`Không chỉnh được ảnh nhóm ${channel.id}/${msg.chatKey}: ${String(error)}`);
        return { kind: "ignore" };
      }
    }
    if (silentPhoto) {
      try {
        const userKey = `${channel.kind}-${msg.senderId}`;
        const userDir = resolve(join(rt.config.dataDir, ctx.workspaceId, "users", sanitizeUserKey(userKey)));
        const photos = (msg.media ?? []).filter((m) => m.kind === "photo" && m.dataUrl);
        const savedImages = await saveInboundImages(userDir, photos, msg.text);
        if (savedImages.length) {
          const list = [...(recentImages.get(sessionId) ?? []), ...savedImages];
          recentImages.set(sessionId, list.slice(-RECENT_IMAGES_MAX));
        }
        const docs = (msg.media ?? []).filter((m) => m.kind === "document" && m.dataB64);
        const savedDocs = await saveInboundDocs(userDir, docs, msg.text);
        const content = mergeMediaText(msg.text, msg.media, savedImages.map((s) => s.name), savedDocs.map((s) => s.name));
        await appendMessage(db, ctx, sessionId, {
          role: "user",
          content: { kind: "text", text: content || "[Người dùng gửi ảnh]" },
        });
      } catch (err) {
        logger.warn(`Lưu ảnh inbound lỗi, giữ im lặng: ${(err as Error).message}`);
      }
      return { kind: "ignore" };
    }

    // Bot commands (/stop /reset /new /status /help)
    const cmd = msg.text.trim().toLowerCase().split("@")[0];
    if (cmd === "/help" || cmd === "/start") {
      // Không hardcode lời giới thiệu (mỗi bot một vai khác nhau) — biến thành
      // câu hỏi để chính agent tự giới thiệu theo system prompt của nó.
      // Không return: pairing gate phía dưới vẫn áp dụng cho người lạ.
      msg.text =
        "Xin chào! Bạn tên gì, vai trò của bạn là gì? Hãy giới thiệu ngắn gọn " +
        "bạn có thể giúp tôi những việc gì (kèm 2-3 ví dụ cụ thể), và nhắc tôi " +
        "các lệnh: /new (cuộc mới), /reset (xóa lịch sử), /stop (dừng trả lời), /status, /help.";
    }
    if (cmd === "/status") {
      return { kind: "reply", text: "✅ Đang hoạt động. Agent: " + channel.name };
    }
    if (cmd === "/stop") {
      const ac = activeRuns.get(sessionId);
      if (ac) {
        ac.abort();
        return { kind: "reply", text: "⏹ Đã dừng câu trả lời đang chạy." };
      }
      return { kind: "reply", text: "Không có câu trả lời nào đang chạy." };
    }
    if (cmd === "/new" || cmd === "/reset") {
      const s = await createSession(db, ctx, { agentId: channel.agentId, title: `${channel.kind}:${msg.senderName ?? msg.chatKey}` });
      await mapChannelSession(db, ctx, channel.id, msg.chatKey, s.id);
      return { kind: "reply", text: "🆕 Đã bắt đầu cuộc trò chuyện mới." };
    }

    const agent = await getAgentById(db, ctx, channel.agentId);
    if (!agent) return { kind: "reply", text: "⚠️ Agent chưa được cấu hình." };

    // Kênh bán lan: lọc trước mọi text/tool của Agent. Adapter đã lưu tin vào
    // Inbox trước khi gọi handler; ignore chỉ ngăn AI nhắn lại cho khách.
    if (channel.config["orchid_sales_scope"] === true && !staffDelegation) {
      const scopeText = [msg.text, ...(msg.media ?? []).flatMap((m) => [m.text ?? "", m.note ?? ""])]
        .filter(Boolean).join("\n").trim();
      const scopeImages = (msg.media ?? []).filter((m) => m.kind === "photo" && m.dataUrl)
        .map((m) => m.dataUrl!).slice(0, 5);
      if (scopeText || scopeImages.length) {
        try {
          const provider = rt.providers.get(agent.provider, ctx.workspaceId);
          const limited = rt.gate
            ? gatedProvider(rt.gate, provider, { providerKey: agent.provider, priority: 0 })
            : provider;
          const history = await loadMessages(db, ctx, sessionId!);
          const recentCustomerTexts = history.filter((m) => m.role === "user" && m.content.kind === "text")
            .map((m) => m.content.kind === "text" ? m.content.text : "");
          const yellowSamples = agent.key === "nhan-vien-kinh-doanh-orchids-world"
            ? requestedOrchidYellowSamples(scopeText, recentCustomerTexts) : [];
          const decision = yellowSamples.length ? "allow" : await classifyOrchidSalesScope(limited, agent.model, {
            text: scopeText,
            images: scopeImages,
            recentMessages: history,
            quotedProductPhoto: msg.quoted?.kind === "photo",
          });
          if (decision === "ignore") return { kind: "ignore" };
        } catch (err) {
          logger.warn(`orchid_sales_scope: không phân loại được, chuyển nhân viên xử lý (${(err as Error).message})`);
          return { kind: "ignore" };
        }
      } else {
        // Voice/video/file không đọc được: để nhân viên xem, không tự xác nhận.
        return { kind: "ignore" };
      }
    }

    const userKey = `${channel.kind}-${msg.senderId}`;
    const wsDirEarly = resolve(join(rt.config.dataDir, ctx.workspaceId));
    const userDirEarly = resolve(join(wsDirEarly, "users", sanitizeUserKey(userKey)));
    let quotedPhotoDataUrl: string | null = null;
    let quotedPhotoStemCount: number | null = null;
    const numberedPhotoDir = join(wsDirEarly, "shared");
    if (msg.quoted?.kind === "photo") {
      const threadId = msg.chatKey.slice(msg.chatKey.indexOf(":") + 1);
      const quotedRow = await getInboxMessageByMsgId(db, ctx, channel.id, threadId, msg.quoted.msgId)
        .catch(() => null);
      const rawPath = quotedRow?.contentType === "photo" ? quotedRow.media?.localPath : undefined;
      const safePath = typeof rawPath === "string"
        ? await confineMediaPath(rawPath, [wsDirEarly])
        : null;
      let quotedBytes: Buffer | null = null;
      if (safePath) {
        try {
          const fileStat = await stat(safePath);
          if (fileStat.size <= 10 * 1024 * 1024) quotedBytes = await readFile(safePath);
        } catch {
          // Bản lưu đã mất: thử CDN Zalo của chính tin được trích dẫn.
        }
      }
      if (!quotedBytes && quotedRow?.contentType === "photo") {
        const url = typeof quotedRow.media?.url === "string"
          ? trustedZaloMediaUrl(quotedRow.media.url) : null;
        if (url) {
          try {
            const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
            if (response.ok && Number(response.headers.get("content-length") ?? 0) <= 10 * 1024 * 1024) {
              const bytes = Buffer.from(await response.arrayBuffer());
              if (bytes.length && bytes.length <= 10 * 1024 * 1024) quotedBytes = bytes;
            }
          } catch { /* CDN hết hạn hoặc không tải được */ }
        }
      }
      if (quotedBytes?.length) {
        const ext = extname(safePath ?? "").toLowerCase();
        const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp"
          : ext === ".gif" ? "image/gif" : "image/jpeg";
        quotedPhotoDataUrl = `data:${mime};base64,${quotedBytes.toString("base64")}`;
        if (agent.key === "nhan-vien-kinh-doanh-orchids-world") {
          const storedCount = quotedRow?.media?.stemCount;
          quotedPhotoStemCount = typeof storedCount === "number" && storedCount >= 1 && storedCount <= 99
            ? storedCount
            : await stemCountForPhoto(numberedPhotoDir, safePath ?? quotedBytes);
        }
      }
      if (!quotedPhotoDataUrl) {
        return { kind: "reply", text: "Em chưa xác định được chính xác ảnh anh/chị đã chọn trong album. Anh/chị gửi lại riêng ảnh đó hoặc cho em biết ảnh số mấy nhé ạ." };
      }
    }

    // Lưu ảnh + document inbound thành file (tham chiếu lại được ở các lượt
    // sau). Caption/tin nhắn kèm theo → đặt tên file slug dễ hiểu.
    const photos = (msg.media ?? []).filter((m) => m.kind === "photo" && m.dataUrl);
    const savedImages = await saveInboundImages(userDirEarly, photos, msg.text);
    const inboundStemCounts = agent.key === "nhan-vien-kinh-doanh-orchids-world"
      ? await Promise.all(savedImages.map((image) => stemCountForPhoto(numberedPhotoDir, image.path)))
      : [];
    if (savedImages.length) {
      const list = [...(recentImages.get(sessionId) ?? []), ...savedImages];
      recentImages.set(sessionId, list.slice(-RECENT_IMAGES_MAX));
    }
    const inboundDocs = (msg.media ?? []).filter(
      (m) => m.kind === "document" && m.dataB64,
    );
    const savedDocs = await saveInboundDocs(userDirEarly, inboundDocs, msg.text);

    // Chỉ gửi file, chưa có yêu cầu → lưu + xác nhận ngắn, KHÔNG chạy LLM.
    const hasSubstance =
      msg.text.trim().length > 0 ||
      (msg.media ?? []).some((m) => m.text !== undefined || m.note);
    const savedAll = [...savedImages, ...savedDocs];
    if (!hasSubstance && savedAll.length && !(agent.key === "nhan-vien-kinh-doanh-orchids-world" && savedImages.length)) {
      await appendMessage(db, ctx, sessionId, {
        role: "user",
        content: {
          kind: "text",
          text: `[Đã gửi ${savedAll.length} file: ${savedAll.map((s) => s.name).join(", ")}]`,
        },
      }).catch(() => {});
      const streak = (imageOnlyStreak.get(sessionId) ?? 0) + 1;
      imageOnlyStreak.set(sessionId, streak);
      // Báo rõ TÊN FILE đã lưu để người dùng (và agent ở các lượt sau) tham chiếu
      const what = savedAll.map((s) => s.name).join(", ");
      if (streak === 1) {
        const hint = savedDocs.length
          ? `Ví dụ: "tóm tắt file này", "phân tích số liệu", "dựa vào file lên plan"...`
          : `Ví dụ: "làm hình sản phẩm từ ảnh này", "tạo banner", "đọc chữ trên nhãn"...\nMẹo: gửi ảnh kèm caption (vd "logo công ty") để file được đặt tên theo caption.`;
        return {
          kind: "reply",
          text: `📎 Đã lưu: ${what}. Bạn muốn làm gì với chúng?\n${hint}`,
        };
      }
      return {
        kind: "reply",
        text: `📎 Đã lưu thêm: ${what}. Nhắn yêu cầu khi bạn sẵn sàng nhé.`,
      };
    }
    imageOnlyStreak.delete(sessionId);

    // File agent muốn gửi: từ tool send_file (đã kiểm tra) và từ marker
    // [[media:...]] trong kết quả tool (chưa kiểm tra — xác minh sau vòng lặp).
    const mediaOut: string[] = [];
    const pendingMedia: string[] = [];
    let emittedBlockReply = false;
    // Agent đã CHỦ ĐỘNG chọn file gửi (send_file) → các nguồn auto (marker,
    // file mới sinh) chỉ là sản phẩm trung gian (ảnh nền chưa ghép chữ, .json
    // sinh ra giữa pipeline...) — không gửi kèm nữa.
    let explicitAttach = false;
    // Agent đã gửi thẻ duyệt trong lượt này → final rỗng là hợp lệ, đừng thay
    // bằng placeholder "(không có nội dung)".
    let cardSent = false;
    const personData = channelIdentity
      ? await getPersonContextData(db, ctx, {
          principalId: channelIdentity.principalId,
          contactId: channelIdentity.contactId,
        }).catch((err) => {
          logger.warn(`Nạp hồ sơ xưng hô lỗi: ${(err as Error).message}`);
          return null;
        })
      : null;
    const selfAddress = personData?.profile?.selfAddress;
    const addressAs = personData?.profile?.addressAs;
    const protectPersonalAddress = requiresPersonalAddressGuard(selfAddress, addressAs);
    const roleMismatch = (text: string) => hasPersonalAddressMismatch(text, selfAddress, addressAs);
    const loopDeps = await buildLoopDeps(rt, ctx, agent.provider, {
      ...agentOpts(agent),
      autoApproveExec: false,
      // Thư mục làm việc riêng theo người gửi trên kênh (không đọc file của nhau)
      userKey,
      ...(channelIdentity ? {
        principalId: channelIdentity.principalId,
        channelIdentityId: channelIdentity.contactId,
      } : {}),
      ...(conversationId ? { conversationId } : {}),
      // Hồ sơ contact + chỉ dẫn của quản trị viên cho người đang chat
      person: { channelKind: channel.kind, peerKind: msg.peerKind === "group" ? "group" : "direct" },
      sourceKind: "channel",
      accessRole: null,
      // Tool đặt lịch (cron_*): tới giờ chạy bằng quyền người này, gửi kết quả về chat này
      cronOrigin: {
        kind: "channel",
        deliver: true,
        channelId: channel.id,
        channelKind: channel.kind,
        channelName: channel.name,
        chatKey: msg.chatKey,
        peerKind: msg.peerKind === "group" ? "group" : "direct",
        senderId: msg.senderId,
        ...(msg.senderName ? { senderName: msg.senderName } : {}),
        ...(channelIdentity
          ? { principalId: channelIdentity.principalId, channelIdentityId: channelIdentity.contactId }
          : {}),
        ...(conversationId ? { conversationId } : {}),
      },
      attachFile: (p) => {
        explicitAttach = true;
        if (!mediaOut.includes(p)) mediaOut.push(p);
      },
      // Thẻ duyệt có nút bấm (tool send_approval_card) — chỉ kênh hỗ trợ nút
      ...(channel.kind === "msteams" || channel.kind === "telegram"
        ? {
            approvalCard: async (input: {
              text: string;
              buttons: Array<{ label: string; value: string }>;
            }) => {
              const adapter = channelHandlers.get(channel.id)?.channel;
              if (!(adapter instanceof TeamsChannel) && !(adapter instanceof TelegramChannel)) {
                throw new Error("Kênh chưa sẵn sàng gửi thẻ nút bấm");
              }
              const cardId = await sendApprovalCard(
                adapter,
                channel.id,
                msg.chatKey,
                msg.peerKind,
                input,
              );
              cardSent = true;
              return cardId;
            },
          }
        : {}),
    });

    // Chụp trạng thái thư mục trước khi chạy để biết file nào MỚI sinh ra
    const wsDir = wsDirEarly;
    const userDir = userDirEarly;
    const filesBefore = await snapshotWorkDir(userDir);

    hooks?.onStatus?.("queued");
    // Tin được tag trong nhóm Zalo: nối các tin liền trước của cùng người gửi
    // (trong 60 giây) để agent trả lời trọn ý, không chỉ câu cuối.
    const inboundText =
      isZaloGroup && msg.mentioned
        ? joinGroupChatter(chatterKey, msg.senderId, msg.senderName, msg.text)
        : msg.text;
    const recognizedCounts = [...new Set(inboundStemCounts.filter((n): n is number => n !== null))];
    const photoStemContext = quotedPhotoStemCount
      ? `[DỮ KIỆN ẢNH: Ảnh khách trích dẫn khớp ảnh trong thư viện chậu ${quotedPhotoStemCount} cành. Dùng số cành này để trả lời; không đoán lại bằng mắt.]\n`
      : savedImages.length === 1 && recognizedCounts.length === 1
        ? `[DỮ KIỆN ẢNH: Ảnh khách gửi lại khớp ảnh trong thư viện chậu ${recognizedCounts[0]} cành. Dùng số cành này để trả lời; không đoán lại bằng mắt.]\n`
        : "";
    const latestUserMessage = staffDelegation
      ? `[LỆNH NỘI BỘ TỪ NHÂN VIÊN QUA -ld — không phải tin của khách, không gửi mã lệnh này cho khách]\n` +
        `Nhân viên vừa nói với khách: ${staffDelegation.slice(0, 1000)}\n` +
        `Hãy thực hiện ngay phần việc nhân viên vừa nhận làm trong đúng hội thoại này. ` +
        `Nếu đã hứa gửi màu/ảnh hoa đang có, đọc lại thư mục shared/hinh-hoa-dang-co-42dbp ` +
        `và chọn ảnh hiện có bằng send_file; hệ thống sẽ gửi kết quả một lần. Không chỉ nhắn lại lời hứa. ` +
        `Nếu câu nhân viên không chỉ ra việc có thể thực hiện an toàn, chỉ trả về đúng KHONG_LAM. ` +
        `Không tự đoán hay gửi gì cho khách.`
      : mergeMediaText(
      quotedPhotoDataUrl
        ? `${photoStemContext}[Khách đang trả lời trực tiếp ảnh đã gửi. Ảnh đi kèm lượt này chính là ảnh khách chọn; không suy đoán theo vị trí trong album.]\n${inboundText}`
        : `${photoStemContext}${inboundText}`,
      msg.media,
      savedImages.map((s) => s.name),
      savedDocs.map((s) => s.name),
    );
    // Inbox giữ cả những tin nhân viên/khách trao đổi trước khi Agent được duyệt.
    // Session của Agent có thể chưa tồn tại lúc đó, nên nạp đúng thread trước khi trả lời.
    const handoffMessages = agent.key === "nhan-vien-kinh-doanh-orchids-world" &&
      msg.channelKind === "zalo_personal"
      ? await listInboxMessages(db, ctx, channel.id, msg.chatKey.slice(msg.chatKey.indexOf(":") + 1), { limit: 30 })
        .catch((error) => {
          logger.warn(`Không đọc được ngữ cảnh Inbox khi tiếp quản: ${String(error)}`);
          return [];
        })
      : [];
    if (agent.key === "nhan-vien-kinh-doanh-orchids-world" && msg.peerKind === "direct" &&
        !staffDelegation && hasRecentCustomerInvoiceRequest(handoffMessages)) {
      const threadId = msg.chatKey.slice(msg.chatKey.indexOf(":") + 1);
      const currentTaxCode = customerInvoiceTaxCode(msg.text);
      if (currentTaxCode) {
        const credentials = await getMisaCredentials(db, ctx);
        if (credentials && currentTaxCode === credentials.taxCode) {
          return { kind: "reply", text: "Mã số thuế anh/chị gửi trùng mã số thuế bên bán của shop. Anh/chị vui lòng kiểm tra lại mã số thuế bên mua để em lập hóa đơn đúng ạ." };
        }
        if (credentials) {
          try {
            const buyer = await lookupMisaBuyerCompany({ taxCode: credentials.taxCode,
              username: credentials.username, password: decryptSecret(credentials.passwordEncrypted) }, currentTaxCode);
            return { kind: "reply", text: `Anh/chị xác nhận hóa đơn xuất cho ${buyer.name} (MST ${currentTaxCode}) đúng không ạ?` };
          } catch (error) {
            logger.warn(`misa.customer_company_lookup_fail: ${String(error)}`);
          }
        }
      } else if (isInvoiceConfirmation(msg.text)) {
        const credentials = await getMisaCredentials(db, ctx);
        if (credentials?.draftEnabled) {
          // The Zalo Inbox logger persists asynchronously; the current approval must be
          // visible before the draft validator checks message order and evidence.
          if (msg.messageId) {
            let visible = false;
            for (let attempt = 0; attempt < 6 && !visible; attempt++) {
              visible = !!await getInboxMessageByMsgId(db, ctx, channel.id, threadId, msg.messageId).catch(() => null);
              if (!visible) await new Promise((resolve) => setTimeout(resolve, 150));
            }
            if (!visible) return { kind: "reply", text: "Em đã nhận xác nhận của anh/chị nhưng chưa kiểm tra được lịch sử hóa đơn; em sẽ nhờ nhân viên xử lý ạ." };
          }
          try {
            const result = await runOrchidMisaStaffCommand(channel.id, threadId, "-xhd");
            return result.previewSent ? { kind: "ignore" } : { kind: "reply", text:
              "Em đã lưu hóa đơn nháp nhưng chưa gửi được bản xem trước. Em sẽ nhờ nhân viên kiểm tra và gửi lại; hóa đơn chưa phát hành ạ." };
          } catch (error) {
            logger.info(`misa.customer_draft_not_ready: ${String(error)}`);
          }
        }
      }
    }
    const handoffContext = orchidHandoffContext(handoffMessages);
    const requestedYellowSamples = agent.key === "nhan-vien-kinh-doanh-orchids-world" && msg.peerKind === "direct"
      ? requestedOrchidYellowSamples(msg.text, handoffMessages.filter((m) => m.direction === "in").map((m) => m.text))
      : [];
    const paymentContext = agent.key === "nhan-vien-kinh-doanh-orchids-world" && msg.peerKind === "direct"
      ? orchidCompanyPaymentContext(handoffMessages) : "";
    const deliveryContext = agent.key === "nhan-vien-kinh-doanh-orchids-world" && msg.peerKind === "direct"
      ? orchidDeliveryPriorityContext(handoffMessages) : "";
    const shippingHint = agent.key === "nhan-vien-kinh-doanh-orchids-world" && msg.peerKind === "direct"
      ? knownOrchidShippingHint(handoffMessages,
          personData?.tags.some((tag) => /(?:khách\s*)?sỉ/i.test(tag.name)) ? "wholesale" : "retail")
      : null;
    const shippingContext = orchidShippingHintContext(shippingHint);
    let dispatchContext = "";
    let kiotContext = "";
    let complaintReply: string | null = null;
    const orderGroupId = channel.config["orchid_order_dispatch_group"];
    if (agent.key === "nhan-vien-kinh-doanh-orchids-world" && channel.kind === "zalo_personal" &&
        msg.peerKind === "direct" && (mayConfirmOrchidOrder(msg.text) || mayCancelOrchidOrder(msg.text)) &&
        typeof orderGroupId === "string" && /^\d{1,30}$/.test(orderGroupId)) {
      const sourceThreadId = msg.chatKey.slice(msg.chatKey.indexOf(":") + 1);
      try {
        const provider = rt.providers.get(agent.provider, ctx.workspaceId);
        const limited = rt.gate
          ? gatedProvider(rt.gate, provider, { providerKey: agent.provider, priority: 0 })
          : provider;
        const current = { text: msg.text, senderName: msg.senderName ?? msg.senderId };
        const now = msg.sentAt ?? new Date();
        const cancellation = await classifyOrchidOrderCancellation(limited, agent.model, handoffMessages, current, now);
        const order = !cancellation && mayConfirmOrchidOrder(msg.text)
          ? await classifyConfirmedOrchidOrder(limited, agent.model, handoffMessages, current, now) : null;
        if (cancellation || order) {
          const thread = await getInboxThread(db, ctx, channel.id, sourceThreadId);
          const customer = thread?.contactAlias || thread?.profileName || thread?.name || msg.senderName || msg.senderId;
          const dispatchText = cancellation
            ? formatOrchidOrderCancellation(cancellation, customer)
            : formatOrchidOrderDispatch(order!, customer);
          const claimId = cancellation
            ? await claimOrchidOrderDispatch(db, ctx, {
              channelId: channel.id, threadId: sourceThreadId,
              fingerprint: orchidCancellationFingerprint(msg.messageId ?? "", msg.text, now),
              targetThreadId: orderGroupId, message: dispatchText,
            })
            : await claimOrchidOrderReport(db, ctx, {
              channelId: channel.id, threadId: sourceThreadId,
              targetThreadId: orderGroupId, message: dispatchText,
            });
          if (claimId) {
            const runtime = channelHandlers.get(channel.id)?.channel;
            try {
              if (!isPersonalChannel(runtime) || !runtime.isConnected()) throw new Error(`${channel.name} chưa kết nối Zalo`);
              const ids = await runtime.sendManual({
                threadId: orderGroupId, peerKind: "group", text: dispatchText,
                source: "agent", threadName: "Phan Don Cam Hoa",
              });
              if (!ids.length) throw new Error("Zalo không trả mã tin đã gửi");
              await finishOrchidOrderDispatch(db, ctx, claimId, ids[0] ?? null);
              dispatchContext = cancellation
                ? "[HỆ THỐNG: Đã báo nhóm phân đơn về yêu cầu hủy. Chưa xác nhận đơn đã được dừng; vẫn chỉ trả lời khách thật ngắn theo quy tắc hủy đơn.]"
                : "[HỆ THỐNG: Đã gửi thông báo đơn vào nhóm phân đơn cắm hoa thành công. Chỉ lúc này mới được nói với khách rằng đã báo các bạn làm hoa.]";
            } catch (error) {
              await finishOrchidOrderDispatch(db, ctx, claimId, null, String(error)).catch(() => {});
              logger.warn(`Không gửi được ${cancellation ? "yêu cầu hủy" : "đơn"} sang nhóm phân đơn: ${String(error)}`);
              dispatchContext = cancellation
                ? "[HỆ THỐNG: Chưa báo được nhóm phân đơn về yêu cầu hủy. Không nói với khách rằng đơn đã được dừng; cần nhân viên xử lý.]"
                : "[HỆ THỐNG: Chưa gửi được thông báo đơn vào nhóm phân đơn cắm hoa. Không được nói với khách rằng đã báo các bạn làm hoa; cần báo nhân viên xử lý.]";
            }
          } else {
            dispatchContext = cancellation
              ? "[HỆ THỐNG: Yêu cầu hủy này đã được ghi nhận để tránh gửi nhóm trùng. Không nói đã dừng đơn.]"
              : "[HỆ THỐNG: Đơn này đã được ghi nhận để tránh gửi trùng. Không tự khẳng định đã báo nhóm lần nữa.]";
          }
          if (order) {
            // Customer follow-ups never update a saved KiotViet slip.
            try {
              const credentials = await getKiotVietCredentials(db, ctx);
              if (credentials?.branchId) {
                kiotCreation: {
                const orderHistory = await listInboxMessages(db, ctx, channel.id, sourceThreadId, { limit: 200 });
                const lastReset = [...orderHistory].reverse().find((m) => m.direction === "in" && /^\/new\s*$/i.test(m.text.trim()));
                const since = lastReset ? new Date(lastReset.sentAt) : new Date(now.getTime() - 48 * 3600_000);
                if (await hasKiotVietOrderSince(db, ctx, channel.id, sourceThreadId, since)) {
                  kiotContext = "[HỆ THỐNG: Hội thoại đã có phiếu đặt hàng gần đây. Không tự tạo hoặc cập nhật thêm; nhân viên dùng -cn để bổ sung, -lb cho đơn mới.]";
                  break kiotCreation;
                }
                const sessionFingerprint = orchidOrderSessionFingerprint(orderHistory, order, now);
                const payloadFingerprint = orchidOrderPayloadFingerprint(order);
                const common = {
                  retailer: credentials.retailer,
                  clientId: decryptSecret(credentials.clientIdEncrypted),
                  clientSecret: decryptSecret(credentials.clientSecretEncrypted),
                  branchId: credentials.branchId,
                  ...(credentials.cashierUserId ? { cashierUserId: credentials.cashierUserId } : {}),
                  customer, customerPhone: thread?.phone, channelName: channel.name,
                  stems: order.stems, color: order.color, pot: order.pot,
                  price: order.price, delivery: order.delivery,
                  address: order.address, recipientPhone: order.recipientPhone,
                  cardText: order.cardText, instructions: order.instructions,
                  shippingFee: order.shippingFee, vatFee: order.vatFee,
                  companyInvoice: order.companyInvoice,
                };
                const kiotClaimId = await claimKiotVietOrderDraft(db, ctx, {
                  channelId: channel.id, threadId: sourceThreadId,
                  fingerprint: sessionFingerprint, payloadFingerprint,
                });
                let saved: { orderId: number; code: string } | null = null;
                let recordId: string | null = null;
                if (kiotClaimId) {
                  try {
                    saved = await createKiotVietOrchidDraft(common);
                    await finishKiotVietOrderDraft(db, ctx, kiotClaimId, {
                      orderId: saved.orderId, code: saved.code,
                    });
                    recordId = kiotClaimId;
                    kiotContext = `[HỆ THỐNG: Đã tạo phiếu đặt hàng nháp KiotViet mã ${saved.code}. Nhân viên cần kiểm tra thông tin và hoàn tất đơn. Chưa tạo hóa đơn hoặc ghi nhận thanh toán.]`;
                  } catch (error) {
                    const reason = error instanceof Error ? error.message : "Lỗi không xác định";
                    await finishKiotVietOrderDraft(db, ctx, kiotClaimId, { error: reason }).catch(() => {});
                    logger.warn(`Không tạo được đơn nháp KiotViet trên ${channel.name}: ${reason}`);
                    kiotContext = "[HỆ THỐNG: Chưa xác nhận tạo được đơn nháp KiotViet; cần nhân viên kiểm tra, không khẳng định đã lên đơn.]";
                  }
                }
                const billGroupId = channel.config["kiotviet_bill_group"];
                if (saved && recordId && typeof billGroupId === "string" && /^\d{1,30}$/.test(billGroupId)) {
                  try {
                    const runtime = channelHandlers.get(channel.id)?.channel;
                    if (!isPersonalChannel(runtime) || !runtime.isConnected()) throw new Error(`${channel.name} chưa kết nối Zalo`);
                    const slip = await readKiotVietOrderSlip({
                      retailer: credentials.retailer, clientId: common.clientId, clientSecret: common.clientSecret,
                      orderId: saved.orderId, code: saved.code,
                    });
                    const ids = await withKiotVietSlipImage({ ...slip, delivery: order.delivery },
                      { dataDir: rt.config.dataDir, workspaceId: ctx.workspaceId, channelId: channel.id }, (path) => runtime.sendManual({
                      threadId: billGroupId, peerKind: "group", text: kiotVietBillNotice("create", saved.code, customer), filePaths: [path],
                      source: "agent", threadName: "Đã Lên Bill",
                    }));
                    if (!ids.length) throw new Error("Zalo không trả mã ảnh đã gửi");
                    await finishKiotVietBillImage(db, ctx, recordId, { groupId: billGroupId, msgId: ids.at(-1)! });
                  } catch (imageError) {
                    const reason = imageError instanceof Error ? imageError.message : String(imageError);
                    await finishKiotVietBillImage(db, ctx, recordId, { error: reason }).catch(() => {});
                    logger.warn(`Đã lên phiếu ${saved.code} nhưng chưa gửi ảnh nhóm Đã Lên Bill: ${reason}`);
                  }
                }
                }
              }
            } catch (error) {
              logger.warn(`Không kiểm tra được kết nối KiotViet trên ${channel.name}: ${String(error)}`);
            }
          }
        }
      } catch (error) {
        logger.warn(`Không kiểm tra được thay đổi đơn trên ${channel.name}: ${String(error)}`);
      }
    }
    if (!staffDelegation && agent.key === "nhan-vien-kinh-doanh-orchids-world" && channel.kind === "zalo_personal" &&
        msg.peerKind === "direct" && typeof orderGroupId === "string" && /^\d{1,30}$/.test(orderGroupId)) {
      try {
        const provider = rt.providers.get(agent.provider, ctx.workspaceId);
        const limited = rt.gate
          ? gatedProvider(rt.gate, provider, { providerKey: agent.provider, priority: 0 })
          : provider;
        const customerClass = personData?.tags.some((tag) => /(?:khách\s*)?sỉ/i.test(tag.name))
          ? "wholesale" : "retail";
        const now = msg.sentAt ?? new Date();
        const action = await classifyOrchidFlowerComplaint(limited, agent.model, handoffMessages,
          { text: msg.text, senderName: msg.senderName ?? msg.senderId }, customerClass, now);
        if (action) {
          complaintReply = action === "wholesale_escalation" ? "Anh kiểm tra và báo em nhe."
            : /\banh\b/i.test(addressAs ?? "") && !/\bchị\b/i.test(addressAs ?? "")
              ? "Em kiểm tra và báo anh ạ." : "Em kiểm tra và báo chị ạ.";
          const sourceThreadId = msg.chatKey.slice(msg.chatKey.indexOf(":") + 1);
          const thread = await getInboxThread(db, ctx, channel.id, sourceThreadId);
          const customer = thread?.profileName || thread?.contactAlias || thread?.name || msg.senderName || msg.senderId;
          const dispatchText = formatOrchidFlowerComplaintDispatch(customer);
          const claimId = await claimOrchidOrderDispatch(db, ctx, {
            channelId: channel.id, threadId: sourceThreadId,
            fingerprint: orchidFlowerComplaintFingerprint(msg.messageId ?? "", msg.text, now),
            targetThreadId: orderGroupId, message: dispatchText,
          });
          if (claimId) {
            const runtime = channelHandlers.get(channel.id)?.channel;
            try {
              if (!isPersonalChannel(runtime) || !runtime.isConnected()) throw new Error(`${channel.name} chưa kết nối Zalo`);
              const ids = await runtime.sendManual({
                threadId: orderGroupId, peerKind: "group", text: dispatchText,
                source: "agent", threadName: "Phan Don Cam Hoa",
              });
              if (!ids.length) throw new Error("Zalo không trả mã tin đã gửi");
              await finishOrchidOrderDispatch(db, ctx, claimId, ids[0] ?? null);
            } catch (error) {
              await finishOrchidOrderDispatch(db, ctx, claimId, null, String(error)).catch(() => {});
              logger.warn(`Không gửi được phản ánh hoa sang nhóm phân đơn: ${String(error)}`);
            }
          }
        }
      } catch (error) {
        logger.warn(`Không kiểm tra được phản ánh hoa trên ${channel.name}: ${String(error)}`);
      }
    }
    if (complaintReply) return { kind: "reply", text: complaintReply };
    const userMessage = handoffContext || dispatchContext || kiotContext || shippingContext || deliveryContext || paymentContext
      ? `${handoffContext}\n\n${dispatchContext ? `${dispatchContext}\n\n` : ""}${kiotContext ? `${kiotContext}\n\n` : ""}${deliveryContext ? `${deliveryContext}\n\n` : ""}${shippingContext ? `${shippingContext}\n\n` : ""}${paymentContext ? `${paymentContext}\n\n` : ""}[YÊU CẦU MỚI NHẤT CẦN TRẢ LỜI]\n${latestUserMessage}`
      : latestUserMessage;
    // Vision = ảnh lượt này + các ảnh gần đây của session (đọc lại từ đĩa) —
    // người dùng gửi ảnh trước, nhắn yêu cầu sau thì model vẫn "nhìn thấy" ảnh.
    let userImages = quotedPhotoDataUrl ? [quotedPhotoDataUrl] : await recentImagesAsDataUrls(sessionId);
    if (!userImages.length && photos.length) {
      userImages = photos.map((m) => m.dataUrl!);
    }

    // Đăng ký TRƯỚC khi vào hàng đợi: /stop lúc run còn đang xếp hàng vẫn hủy
    // được (nếu chỉ đăng ký khi bắt đầu chạy thì /stop báo "không có gì chạy"
    // rồi run vẫn chạy sau đó).
    const ac = new AbortController();
    activeRuns.set(sessionId, ac);
    // Trace: moi luot chay tren kenh chat deu phai ghi (truoc 0025 khong ghi gi)
    const traceStart = Date.now();
    let traceUsage = { inputTokens: 0, outputTokens: 0 };
    let traceIterations = 0;
    let traceError: string | null = null;
    // Trace: ghi cho MOI luot chay tren kenh chat, KE CA luot loi (truoc 26/09/2026
    // luot loi throw truoc buoc ghi nen admin khong thay loi, phai doc log may chu).
    const writeTrace = () =>
      recordTraceSafe(db, ctx, {
        agentId: agent.id,
        sessionId: sessionId!,
        inputTokens: traceUsage.inputTokens,
        outputTokens: traceUsage.outputTokens,
        iterations: traceIterations,
        durationMs: Date.now() - traceStart,
        source: "channel",
        model: agent.model,
        provider: agent.provider,
        kind: channel.kind,
        ...(traceError ? { error: String(traceError).slice(0, 500) } : {}),
      });
    const finalText = await queue.schedule("main", async () => {
      if (ac.signal.aborted) return "";
      hooks?.onStatus?.("thinking");
      try {
        let streamed = "";
        let sinceTool = ""; // text từ sau tool gần nhất — thành block reply nếu có tool tiếp
        let done = "";
        for await (const ev of runAgent(loopDeps, {
          ctx,
          agent: {
            systemPrompt: agent.systemPrompt,
            model: agent.model,
            maxIterations: agent.maxIterations,
            ...(reasoningEffortOf(agent)
              ? { reasoningEffort: reasoningEffortOf(agent)! }
              : {}),
          },
          sessionId: sessionId!,
          userMessage,
          ...(userImages.length ? { userImages } : {}),
          signal: ac.signal,
        })) {
          if (ac.signal.aborted) break;
          if (ev.type === "text_delta") {
            streamed += ev.text;
            sinceTool += ev.text;
            // Streaming có thể gửi chữ ra kênh trước khi kiểm tra được cả câu.
            if (!protectPersonalAddress) hooks?.onTextDelta?.(ev.text);
          } else if (ev.type === "tool_call") {
            // câu dẫn trước tool ("Để em kiểm tra...") → bubble riêng
            const block = sinceTool.replace(MEDIA_MARKER_RE, "").trim();
            if (block && hooks?.onBlockReply) {
              if (roleMismatch(block)) {
                logger.warn(`Chặn câu dẫn đảo vai xưng hô trên kênh ${channel.id}`);
              } else {
                hooks.onBlockReply(block);
              }
              emittedBlockReply = true;
            }
            sinceTool = "";
            hooks?.onStatus?.(toolReactionStatus(ev.name));
          } else if (ev.type === "tool_result") {
            // Gom media do tool tạo ([[media:path]]). Marker này có thể đến từ
            // custom tool / MCP server (nội dung không kiểm soát) nên PHẢI xác
            // minh nằm trong vùng dữ liệu trước khi gửi ra ngoài.
            for (const m of ev.result.matchAll(/\[\[media:([^\]]+)\]\]/g)) {
              const raw = m[1]?.trim();
              if (!raw) continue;
              pendingMedia.push(raw);
            }
          } else if (ev.type === "done") {
            // Nội dung đã phát qua onBlockReply không được dùng lại làm câu kết.
            // Kênh không có hook vẫn cần fallback streamed để không mất chữ.
            done = ev.finalText || sinceTool || (emittedBlockReply ? "" : streamed);
            traceUsage = ev.usage;
            traceIterations = ev.iterations;
          } else if (ev.type === "error") {
            throw new Error(ev.message);
          }
        }
        return done;
      } finally {
        activeRuns.delete(sessionId!);
      }
    }, sessionId)
      .finally(() => activeRuns.delete(sessionId!))
      .catch((err: unknown) => {
        traceError = err instanceof Error ? err.message : String(err);
        writeTrace();
        if (ac.signal.aborted) return "";
        throw err;
      });

    if (ac.signal.aborted) return { kind: "ignore" };
    hooks?.onStatus?.("done");
    writeTrace();

    // Xác minh file từ marker: phải nằm trong thư mục riêng của chính người
    // dùng này hoặc vùng dùng chung, và không vượt jail qua symlink.
    // Bỏ qua toàn bộ khi agent đã send_file — chỉ gửi đúng file được chỉ định.
    if (pendingMedia.length && !explicitAttach) {
      const roots = [userDir, resolve(join(wsDir, "shared"))];
      for (const raw of pendingMedia) {
        const safe = await confineMediaPath(raw, roots);
        if (!safe) {
          logger.warn(`Bỏ qua media ngoài vùng dữ liệu: ${raw}`);
          continue;
        }
        const info = await stat(safe).catch(() => null);
        if (!info?.isFile() || info.size > 45 * 1024 * 1024) continue;
        if (!mediaOut.includes(safe)) mediaOut.push(safe);
      }
    }

    // Tự động gửi file agent vừa tạo trong lượt này — CHỈ khi model quên gọi
    // send_file (người dùng bảo "tạo file X" là muốn nhận file luôn). Nếu đã
    // send_file thì agent tự quyết file nào là thành phẩm, không auto gửi thêm.
    if (!explicitAttach) {
      for (const p of await newDeliverables(userDir, filesBefore)) {
        if (!mediaOut.includes(p)) mediaOut.push(p);
      }
    }

    // Yêu cầu so sánh lan vàng phải có ảnh thật, kể cả khi model chỉ trả chữ.
    for (const kind of requestedYellowSamples) {
      const path = orchidYellowSamplePath(join(wsDir, "shared"), kind);
      const info = await stat(path).catch(() => null);
      if (info?.isFile() && info.size <= 45 * 1024 * 1024 && !mediaOut.includes(path)) mediaOut.push(path);
      else if (!info?.isFile()) logger.warn(`Thiếu ảnh mẫu lan vàng: ${path}`);
    }

    // model có thể lặp lại marker trong câu trả lời — gỡ đi
    const cleanText = completeOrchidShippingReply(finalText.replace(MEDIA_MARKER_RE, "").trim(), shippingHint);
    const outgoingMedia = channel.kind === "zalo_personal"
      ? await prepareZaloPhotoPaths(mediaOut, userDir)
      : mediaOut;
    if (roleMismatch(cleanText)) {
      logger.warn(`Chặn câu kết đảo vai xưng hô trên kênh ${channel.id}`);
      return outgoingMedia.length ? { kind: "reply", text: "", media: outgoingMedia } : { kind: "ignore" };
    }
    if (staffDelegation && !cleanText && !outgoingMedia.length) return { kind: "ignore" };
    return {
      kind: "reply",
      // Đã có media hoặc thẻ duyệt gửi đi → final rỗng là hợp lệ (nội dung nằm
      // trong thẻ/file), không chèn placeholder gây bubble "(không có nội dung)".
      text: cleanText || (outgoingMedia.length || cardSent || emittedBlockReply ? "" : "(không có nội dung)"),
      ...(outgoingMedia.length ? { media: outgoingMedia } : {}),
    };
  };
}

/**
 * Nạp mọi channel enabled từ DB, giải mã token, khởi động.
 * Trả về manager để server stop khi shutdown.
 */
/** Tạo (chưa start) 1 channel từ row DB. Trả null nếu thiếu điều kiện. */
function buildChannel(
  rt: RuntimeDeps,
  queue: Scheduler,
  manager: ChannelManager,
  ch: EnabledChannel,
): Channel | null {
  if (!isChannelKindSupported(ch.kind)) {
    logger.warn(`Bỏ qua channel "${ch.name}" — kind chưa hỗ trợ: ${ch.kind}`);
    return null;
  }
  if (!ch.tokenEncrypted && !isPersonalChannelKind(ch.kind)) {
    logger.warn(`Bỏ qua channel "${ch.name}" — thiếu token`);
    return null;
  }
  let token: string;
  try {
    token = ch.tokenEncrypted ? decryptSecret(ch.tokenEncrypted) : "";
  } catch (err) {
    logger.warn(`Channel "${ch.name}": giải mã token lỗi (${(err as Error).message})`);
    return null;
  }
  try {
    const handler = makeInboundHandler(rt, queue, ch);
    const channel = manager.add(ch.kind, {
      id: ch.id,
      name: ch.name,
      token,
      config: ch.config,
      requirePairing: ch.requirePairing,
      onInbound: handler,
      onCallback: async (cb) => {
        for (const cbHandler of channelCallbackHandlers) {
          try {
            const res = await cbHandler(cb);
            if (res) return res;
          } catch (err) {
            logger.warn(`Callback handler lỗi: ${(err as Error).message}`);
          }
        }
        return undefined;
      },
      onError: (e) => logger.error(`Channel "${ch.name}" lỗi: ${e.message}`),
      onSecretChanged: async (secret) => {
        await updateChannel(rt.db.db, systemContext(ch.workspaceId), ch.id, {
          tokenEncrypted: encryptSecret(secret),
        });
      },
      // Zalo Personal: persist danh sách quan sát vào DB — danh sách chờ duyệt
      // (tên + uid, nhóm/cá nhân) sống qua restart. Fire-and-forget, lỗi chỉ log.
      onObserved: (peer) => {
        void upsertInboxObservedPeer(
          rt.db.db,
          systemContext(ch.workspaceId),
          ch.id,
          peer,
        ).catch((err) =>
          logger.warn(`zalo.observed_persist lỗi: ${(err as Error).message}`),
        );
      },
      // Inbox trực chat: lưu mọi tin đến/đi + danh bạ (zalo-inbox.ts)
      ...(isPersonalChannelKind(ch.kind) ? inboxHooks(rt.db.db, ch, rt.config.dataDir, async (threadId, peerKind) => {
        const sessionId = await getChannelSession(rt.db.db, systemContext(ch.workspaceId), ch.id, `${peerKind}:${threadId}`);
        if (sessionId) activeRuns.get(sessionId)?.abort();
      }) : {}),
    });
    channelHandlers.set(ch.id, { handler, channel, workspaceId: ch.workspaceId });
    return channel;
  } catch (err) {
    logger.warn(`Không tạo được channel "${ch.name}": ${(err as Error).message}`);
    return null;
  }
}

/** Trạng thái runtime để sửa channel áp dụng NGAY, không cần restart server. */
let live: { rt: RuntimeDeps; queue: Scheduler; manager: ChannelManager } | null = null;

/**
 * Chạy 1 việc trên ĐÚNG hàng đợi session của channels. Luồng ngoài (vd chào
 * mừng sau duyệt pairing trong app.ts) phải dùng hàm này thay vì queue riêng —
 * 2 queue khác nhau từng cho 2 lượt agent chạy song song cùng session, sinh
 * 2 tin chào mừng gần trùng khi provider chậm (antigravity ~30s/lượt).
 */
export function scheduleOnChannelQueue<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  if (live) return live.queue.schedule("main", fn, sessionId);
  return fn();
}

/**
 * Áp dụng thay đổi cho 1 channel đang chạy: dừng bản cũ, khởi động bản mới
 * theo row DB hiện tại (enabled=false hoặc row=null → chỉ dừng).
 * Trả ghi chú kết quả cho UI hiển thị.
 */
export async function applyChannelChange(
  channelId: string,
  row: EnabledChannel | null,
): Promise<string> {
  if (!live) return "Đã lưu — restart server (pnpm start) để áp dụng.";
  await live.manager.remove(channelId);
  channelHandlers.delete(channelId);
  forgetInboxChannel(channelId);
  if (!row) return "Đã dừng channel.";
  const channel = buildChannel(live.rt, live.queue, live.manager, row);
  if (!channel) {
    return "Đã lưu nhưng channel KHÔNG khởi động được (thiếu token hoặc kind chưa hỗ trợ) — xem log server.";
  }
  try {
    await channel.start();
    return "Đã lưu và khởi động lại channel — áp dụng ngay.";
  } catch (err) {
    return `Đã lưu nhưng khởi động lỗi: ${(err as Error).message}`;
  }
}

export async function startChannels(rt: RuntimeDeps): Promise<ChannelManager> {
  const manager = new ChannelManager();
  // Lane "main": trần số lượt agent chạy đồng thời trên mọi
  // channel — nhiều người nhắn cùng lúc thì xếp hàng thay vì bóp nghẹt VPS/LLM.
  // Cùng session vẫn tuần tự (KeyedQueue bên trong Scheduler).
  const queue = new Scheduler({
    main: Math.max(1, Number(process.env.PENAI_LANE_MAIN) || 8),
  });
  live = { rt, queue, manager };
  let started = 0;

  let list: EnabledChannel[] = [];
  try {
    list = await listEnabledChannels(rt.db.db);
  } catch (err) {
    logger.warn(`Không đọc được danh sách channel: ${(err as Error).message}`);
    return manager;
  }

  for (const ch of list) {
    if (buildChannel(rt, queue, manager, ch)) started++;
  }

  await manager.startAll();
  if (started > 0) logger.info(`Đã khởi động ${started} channel`);
  return manager;
}
