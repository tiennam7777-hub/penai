import type { InboxMessageRow } from "@penai/db";

export interface InboxZaloQuote {
  msgId: string;
  cliMsgId: string;
  uidFrom: string;
  ts: number;
  msgType: string;
  content: string | Record<string, unknown>;
  propertyExt: string;
  ttl: number;
}

/** Only quote Zalo messages for which the platform identifiers and original content are available. */
export function inboxZaloQuote(message: InboxMessageRow): InboxZaloQuote | null {
  const cliMsgId = message.meta?.cliMsgId;
  const ts = new Date(message.sentAt).getTime();
  if (message.removed || !message.msgId || typeof cliMsgId !== "string" || !cliMsgId ||
      !message.senderId || !Number.isFinite(ts)) return null;

  if (message.contentType === "text" && message.text) {
    return { msgId: message.msgId, cliMsgId, uidFrom: message.senderId, ts,
      msgType: "webchat", content: message.text, propertyExt: "", ttl: 0 };
  }
  if (message.contentType !== "photo") return null;
  const source = message.meta?.zaloQuoteSource;
  const saved = source && typeof source === "object" ? source as Record<string, unknown> : null;
  const content = saved?.content && typeof saved.content === "object"
    ? saved.content as Record<string, unknown>
    : typeof message.media?.url === "string" && message.media.url
      ? { href: message.media.url, thumb: message.media.thumb ?? message.media.url }
      : null;
  if (!content || typeof content.href !== "string" || !content.href) return null;
  return { msgId: message.msgId, cliMsgId, uidFrom: message.senderId, ts,
    msgType: "chat.photo", content,
    propertyExt: typeof saved?.propertyExt === "string" ? saved.propertyExt : "",
    ttl: typeof saved?.ttl === "number" ? saved.ttl : 0 };
}
