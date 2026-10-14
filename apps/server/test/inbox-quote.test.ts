import { describe, expect, it } from "vitest";
import type { InboxMessageRow } from "@penai/db";
import { inboxZaloQuote } from "../src/inbox-quote.js";

const base = { id: "1", threadId: "peer", msgId: "zalo-1", direction: "in", source: "zalo",
  senderId: "sender", senderName: "Khách", webUserId: null, webUserName: null,
  contentType: "text", text: "Mẫu này giá bao nhiêu?", media: null, meta: { cliMsgId: "cli-1" },
  sentAt: "2026-10-14T03:00:00.000Z" } as InboxMessageRow;

describe("Zalo Inbox reply quote", () => {
  it("quotes a saved text message", () => {
    expect(inboxZaloQuote(base)).toMatchObject({ msgId: "zalo-1", cliMsgId: "cli-1", uidFrom: "sender",
      msgType: "webchat", content: "Mẫu này giá bao nhiêu?" });
  });
  it("quotes an incoming photo using its Zalo URL", () => {
    expect(inboxZaloQuote({ ...base, contentType: "photo", text: "", media: { url: "https://example.com/photo.jpg" } }))
      .toMatchObject({ msgType: "chat.photo", content: { href: "https://example.com/photo.jpg" } });
  });
  it("quotes a sent photo when the Zalo echo supplied its original metadata", () => {
    expect(inboxZaloQuote({ ...base, contentType: "photo", text: "", media: { localPath: "/tmp/photo.jpg" },
      meta: { cliMsgId: "cli-1", zaloQuoteSource: { content: { href: "https://example.com/photo.jpg" } } } }))
      .toMatchObject({ msgType: "chat.photo", content: { href: "https://example.com/photo.jpg" } });
  });
  it("rejects old sent photos, recalled messages, and missing Zalo ids", () => {
    expect(inboxZaloQuote({ ...base, contentType: "photo", text: "", media: { localPath: "/tmp/photo.jpg" } })).toBeNull();
    expect(inboxZaloQuote({ ...base, removed: "recalled" })).toBeNull();
    expect(inboxZaloQuote({ ...base, meta: null })).toBeNull();
  });
});
