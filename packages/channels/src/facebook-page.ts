import { createHmac, timingSafeEqual } from "node:crypto";
import type { ChannelDeps, ChannelMessageLog, InboundMessage, OutboundMessage } from "./types.js";

const GRAPH_VERSION = "v24.0";
const MAX_TEXT = 2000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function trustedFacebookImageUrl(value: string): boolean {
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase();
    return u.protocol === "https:" && (host === "fbcdn.net" || host.endsWith(".fbcdn.net") ||
      host === "fbsbx.com" || host.endsWith(".fbsbx.com"));
  } catch { return false; }
}

async function fetchFacebookImage(value: string): Promise<{ bytes: Buffer; mime: string } | null> {
  let url = value;
  for (let hop = 0; hop < 3; hop++) {
    if (!trustedFacebookImageUrl(url)) return null;
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get("location");
      if (!next) return null;
      url = new URL(next, url).toString();
      continue;
    }
    if (!response.ok || !response.body) return null;
    const mime = (response.headers.get("content-type") ?? "").split(";")[0]!.toLowerCase();
    if (!/^(image\/jpeg|image\/png|image\/webp|image\/gif)$/.test(mime)) return null;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      const part = Buffer.from(chunk);
      size += part.length;
      if (size > MAX_IMAGE_BYTES) return null;
      chunks.push(part);
    }
    return size ? { bytes: Buffer.concat(chunks), mime } : null;
  }
  return null;
}

export interface FacebookPageCredentials {
  pageAccessToken: string;
  appSecret: string;
  verifyToken: string;
}

export function parseFacebookPageCredentials(value: string): FacebookPageCredentials {
  let data: unknown;
  try { data = JSON.parse(value); } catch { throw new Error("Credential Fanpage phải là JSON hợp lệ"); }
  const c = data as Partial<FacebookPageCredentials> | null;
  if (!c || typeof c.pageAccessToken !== "string" || !c.pageAccessToken.trim() ||
      typeof c.appSecret !== "string" || !c.appSecret.trim() ||
      typeof c.verifyToken !== "string" || !c.verifyToken.trim()) {
    throw new Error("Fanpage cần pageAccessToken, appSecret và verifyToken");
  }
  return { pageAccessToken: c.pageAccessToken, appSecret: c.appSecret, verifyToken: c.verifyToken };
}

export function verifyFacebookSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header ?? "");
  if (!match || !appSecret) return false;
  const received = Buffer.from(match[1]!, "hex");
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  return timingSafeEqual(received, expected);
}

type FacebookMessaging = {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: { mid?: string; text?: string; is_echo?: boolean; attachments?: Array<{ type?: string; payload?: { url?: string } }> };
};

export function parseFacebookPageWebhook(channelId: string, pageId: string, payload: unknown): Array<{ message: InboundMessage; log: ChannelMessageLog; echo: boolean }> {
  const body = payload as { object?: string; entry?: Array<{ id?: string; messaging?: FacebookMessaging[] }> } | null;
  if (body?.object !== "page" || !Array.isArray(body.entry)) return [];
  const result: Array<{ message: InboundMessage; log: ChannelMessageLog; echo: boolean }> = [];
  for (const entry of body.entry) {
    if (!entry || entry.id !== pageId || !Array.isArray(entry.messaging)) continue;
    for (const event of entry.messaging) {
      if (!event || typeof event !== "object") continue;
      const msg = event.message;
      if (!msg || !event.sender?.id || !event.recipient?.id) continue;
      const echo = msg.is_echo === true;
      if (echo ? event.sender.id !== pageId : event.recipient.id !== pageId) continue;
      const peerId = echo ? event.recipient.id : event.sender.id;
      if (!/^\d{1,30}$/.test(peerId)) continue;
      const attachment = Array.isArray(msg.attachments)
        ? msg.attachments.find((a) => a && typeof a.payload?.url === "string") : undefined;
      const contentType = attachment?.type === "image" ? "photo" : attachment ? "file" : "text";
      const text = typeof msg.text === "string" ? msg.text : "";
      if (!text && !attachment) continue;
      const sentAt = Number.isFinite(event.timestamp) && Number(event.timestamp) > 0 &&
        Number(event.timestamp) <= 8_640_000_000_000_000 ? new Date(Number(event.timestamp)) : new Date();
      const log: ChannelMessageLog = {
        threadId: peerId, peerKind: "direct", msgId: msg.mid ?? "", direction: echo ? "out" : "in",
        source: echo ? "app" : "peer", senderId: event.sender.id,
        senderName: echo ? "Fanpage" : peerId, contentType, text,
        ...(attachment?.payload?.url ? { media: { url: attachment.payload.url } } : {}), sentAt,
        threadName: echo ? "" : peerId,
      };
      const message: InboundMessage = {
        channelId, channelKind: "facebook_page", chatKey: `direct:${peerId}`, senderId: peerId,
        senderName: peerId, text: text || (contentType === "photo" ? "[Khách gửi ảnh]" : "[Khách gửi tệp]"),
        ...(msg.mid ? { messageId: msg.mid } : {}), sentAt, peerKind: "direct",
        ...(attachment?.payload?.url ? { media: [{ kind: contentType === "photo" ? "photo" : "document", note: `Tệp Messenger: ${attachment.payload.url}` }] } : {}),
      };
      result.push({ message, log, echo });
    }
  }
  return result;
}

export class FacebookPageChannel {
  readonly kind = "facebook_page";
  readonly id: string;
  readonly name: string;
  readonly pageId: string;
  private readonly credentials: FacebookPageCredentials;
  private readonly deps: ChannelDeps;
  private readonly sentIds = new Set<string>();
  private readonly receivedIds = new Set<string>();
  private connected = false;

  constructor(deps: ChannelDeps) {
    this.deps = deps;
    this.id = deps.id;
    this.name = deps.name;
    this.pageId = String(deps.config.pageId ?? "");
    if (!/^\d{1,30}$/.test(this.pageId)) throw new Error("Fanpage cần config.pageId là ID số của Page");
    this.credentials = parseFacebookPageCredentials(deps.token);
  }
  async start(): Promise<void> { await this.verifyPage(); }
  async stop(): Promise<void> { this.connected = false; }
  isRunning(): boolean { return this.connected; }
  isConnected(): boolean { return this.connected; }
  accountInfo() { return { id: this.pageId, name: this.name }; }
  verifyToken(value: string): boolean {
    const a = Buffer.from(value);
    const b = Buffer.from(this.credentials.verifyToken);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  verifySignature(rawBody: Buffer, header: string | undefined): boolean {
    return verifyFacebookSignature(rawBody, header, this.credentials.appSecret);
  }
  async verifyPage(): Promise<{ id: string; name: string }> {
    const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${this.pageId}?fields=id,name`, {
      headers: { authorization: `Bearer ${this.credentials.pageAccessToken}` }, signal: AbortSignal.timeout(15_000),
    });
    const data = await response.json() as { id?: string; name?: string; error?: { message?: string } };
    if (!response.ok || data.id !== this.pageId) throw new Error(`Không xác minh được Page ID/token: ${data.error?.message ?? response.status}`);
    this.connected = true;
    return { id: data.id, name: data.name ?? this.name };
  }
  async acceptWebhook(payload: unknown): Promise<void> {
    for (const item of parseFacebookPageWebhook(this.id, this.pageId, payload)) {
      if (item.log.msgId && this.receivedIds.has(item.log.msgId)) continue;
      if (item.log.msgId) {
        this.receivedIds.add(item.log.msgId);
        setTimeout(() => this.receivedIds.delete(item.log.msgId), 24 * 60 * 60_000).unref?.();
      }
      if (item.log.msgId && this.sentIds.has(item.log.msgId)) continue;
      const imageUrl = item.log.contentType === "photo" ? item.log.media?.url : undefined;
      if (imageUrl) {
        try {
          const image = await fetchFacebookImage(imageUrl);
          if (image) {
            const ext = image.mime === "image/png" ? "png" : image.mime === "image/webp" ? "webp" : image.mime === "image/gif" ? "gif" : "jpg";
            const localPath = await this.deps.saveInboxFile?.(image.bytes, ext);
            if (localPath) item.log.media = { ...item.log.media, localPath };
            item.message.media = [{ kind: "photo", dataUrl: `data:${image.mime};base64,${image.bytes.toString("base64")}` }];
          }
        } catch (error) { this.deps.onError?.(error as Error); }
      }
      this.deps.onMessageLog?.(item.log);
      if (item.echo) continue;
      try {
        const result = await this.deps.onInbound(item.message);
        if (result.kind === "reply" && (result.text || result.media?.length)) {
          await this.send({ chatKey: item.message.chatKey, text: result.text, media: result.media });
        }
      } catch (error) { this.deps.onError?.(error as Error); }
    }
  }
  private async sendText(recipientId: string, text: string, source: ChannelMessageLog["source"], webUserId?: string): Promise<string> {
    const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${this.pageId}/messages`, {
      method: "POST", headers: { authorization: `Bearer ${this.credentials.pageAccessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ recipient: { id: recipientId }, messaging_type: "RESPONSE", message: { text: text.slice(0, MAX_TEXT) } }),
    });
    const data = await response.json() as { message_id?: string; error?: { message?: string } };
    if (!response.ok || !data.message_id) throw new Error(`Messenger gửi lỗi ${response.status}: ${data.error?.message ?? "không có message_id"}`);
    this.sentIds.add(data.message_id);
    setTimeout(() => this.sentIds.delete(data.message_id!), 120_000).unref?.();
    this.deps.onMessageLog?.({ threadId: recipientId, peerKind: "direct", msgId: data.message_id,
      direction: "out", source, senderId: this.pageId, senderName: this.name, ...(webUserId ? { webUserId } : {}),
      contentType: "text", text: text.slice(0, MAX_TEXT), sentAt: new Date() });
    return data.message_id;
  }
  private async sendTextChunks(recipientId: string, text: string, source: ChannelMessageLog["source"], webUserId?: string): Promise<string[]> {
    const ids: string[] = [];
    for (let start = 0; start < text.length; start += MAX_TEXT)
      ids.push(await this.sendText(recipientId, text.slice(start, start + MAX_TEXT), source, webUserId));
    return ids;
  }
  private async sendImage(recipientId: string, path: string, source: ChannelMessageLog["source"], webUserId?: string): Promise<string> {
    if (!this.deps.publishMediaUrl) throw new Error("Fanpage chưa có địa chỉ HTTPS để gửi ảnh");
    const url = await this.deps.publishMediaUrl(path);
    const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${this.pageId}/messages`, {
      method: "POST", headers: { authorization: `Bearer ${this.credentials.pageAccessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ recipient: { id: recipientId }, messaging_type: "RESPONSE", message: {
        attachment: { type: "image", payload: { url, is_reusable: false } },
      } }),
    });
    const data = await response.json() as { message_id?: string; error?: { message?: string } };
    if (!response.ok || !data.message_id) throw new Error(`Messenger gửi ảnh lỗi ${response.status}: ${data.error?.message ?? "không có message_id"}`);
    this.sentIds.add(data.message_id);
    setTimeout(() => this.sentIds.delete(data.message_id!), 120_000).unref?.();
    this.deps.onMessageLog?.({ threadId: recipientId, peerKind: "direct", msgId: data.message_id,
      direction: "out", source, senderId: this.pageId, senderName: this.name, ...(webUserId ? { webUserId } : {}),
      contentType: "photo", text: "", media: { localPath: path }, sentAt: new Date() });
    return data.message_id;
  }
  async send(msg: OutboundMessage): Promise<void> {
    const recipientId = msg.chatKey.replace(/^direct:/, "");
    if (!/^\d{1,30}$/.test(recipientId)) throw new Error("Messenger chỉ gửi tới Page-scoped ID hợp lệ");
    if (msg.text.trim()) await this.sendTextChunks(recipientId, msg.text.trim(), "agent");
    for (const path of msg.media ?? []) await this.sendImage(recipientId, path, "agent");
  }
  async sendManual(input: { threadId: string; peerKind: "direct" | "group"; text?: string; filePaths?: string[]; source: ChannelMessageLog["source"]; webUserId?: string }): Promise<string[]> {
    if (input.peerKind !== "direct" || !/^\d{1,30}$/.test(input.threadId)) throw new Error("Messenger chỉ hỗ trợ DM của Page");
    const ids: string[] = [];
    if (input.text?.trim()) ids.push(...await this.sendTextChunks(input.threadId, input.text.trim(), input.source, input.webUserId));
    for (const path of input.filePaths ?? []) ids.push(await this.sendImage(input.threadId, path, input.source, input.webUserId));
    return ids;
  }
  // Inbox dùng chung cho nhiều nền tảng; các thao tác QR/danh bạ Zalo không áp dụng cho Fanpage.
  status() { return { running: this.connected, connected: this.connected, listening: this.connected, account: this.accountInfo(),
    error: null, unofficialWarning: "", safeMode: true as const, demoThreads: [], observedCount: 0, openDirect: true }; }
  demoThreads(): string[] { return []; }
  setDemoThreads(_threads: string[]): void { throw new Error("Fanpage không dùng danh sách demo"); }
  listObserved(): [] { return []; }
  startQrLogin(): Promise<{ id: string }> { throw new Error("Fanpage kết nối bằng Meta App, không dùng QR"); }
  qrStatus(_id: string): null { return null; }
  logout(): Promise<void> { throw new Error("Hãy tạm dừng kênh Fanpage trong Channels"); }
  listTargets(): Promise<[]> { return Promise.resolve([]); }
  syncContacts(): Promise<{ friends: number; groups: number }> { return Promise.resolve({ friends: 0, groups: 0 }); }
  findUserByPhone(_phone: string): Promise<null> { return Promise.resolve(null); }
  resolvePhone(_phone: string): Promise<{ uid: string; name: string }> { throw new Error("Messenger không tìm khách bằng số điện thoại"); }
  lookupGroupName(_threadId: string): Promise<string> { throw new Error("Fanpage không hỗ trợ nhóm"); }
  sendTestMessage(threadId: string, peerKind: "direct" | "group", text: string): Promise<void> {
    return this.sendManual({ threadId, peerKind, text, source: "web" }).then(() => {});
  }
  setAutoReaction(_value: "heart" | "like" | null): void {}
  getAutoReaction(): null { return null; }
  react(): Promise<void> { throw new Error("Messenger chưa hỗ trợ thả cảm xúc từ PenAI"); }
}
