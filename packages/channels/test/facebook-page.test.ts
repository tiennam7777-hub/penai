import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { FacebookPageChannel, parseFacebookPageWebhook, verifyFacebookSignature } from "../src/facebook-page.js";
import type { ChannelDeps, InboundMessage } from "../src/types.js";

const credentials = JSON.stringify({ pageAccessToken: "page-token", appSecret: "app-secret", verifyToken: "verify-123" });
const payload = { object: "page", entry: [{ id: "42", messaging: [{
  sender: { id: "100" }, recipient: { id: "42" }, timestamp: 1_700_000_000_000,
  message: { mid: "m-1", text: "Chậu 8 cành giá bao nhiêu?" },
}] }] };

function deps(over: Partial<ChannelDeps> = {}): ChannelDeps {
  return { id: "channel-1", name: "Fanpage", token: credentials, config: { pageId: "42" },
    requirePairing: false, onInbound: vi.fn(async () => ({ kind: "ignore" as const })), ...over };
}

describe("Facebook Page Messenger", () => {
  it("verifies the exact raw request bytes and rejects invalid signatures", () => {
    const raw = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${createHmac("sha256", "app-secret").update(raw).digest("hex")}`;
    expect(verifyFacebookSignature(raw, signature, "app-secret")).toBe(true);
    expect(verifyFacebookSignature(Buffer.from(JSON.stringify({ ...payload, x: 1 })), signature, "app-secret")).toBe(false);
    expect(verifyFacebookSignature(raw, "sha1=123", "app-secret")).toBe(false);
    expect(new FacebookPageChannel(deps()).verifyToken("verify-123")).toBe(true);
    expect(new FacebookPageChannel(deps()).verifyToken("wrong")).toBe(false);
  });

  it("accepts only messages addressed to this Page and does not feed echoes to Agent", async () => {
    const input = { ...payload, entry: [...payload.entry, { id: "43", messaging: payload.entry[0]!.messaging }] };
    expect(parseFacebookPageWebhook("channel-1", "42", input)).toHaveLength(1);
    const onInbound = vi.fn(async (_message: InboundMessage) => ({ kind: "ignore" as const }));
    const onMessageLog = vi.fn();
    const channel = new FacebookPageChannel(deps({ onInbound, onMessageLog }));
    await channel.acceptWebhook(payload);
    await channel.acceptWebhook(payload);
    expect(onInbound).toHaveBeenCalledTimes(1);
    expect(onMessageLog).toHaveBeenCalledTimes(1);
    expect(onInbound.mock.calls[0]![0].chatKey).toBe("direct:100");
    await channel.acceptWebhook({ object: "page", entry: [{ id: "42", messaging: [{ sender: { id: "42" },
      recipient: { id: "100" }, message: { mid: "m-2", text: "Chào anh", is_echo: true } }] }] });
    expect(onInbound).toHaveBeenCalledTimes(1);
    expect(onMessageLog).toHaveBeenCalledTimes(2);
  });

  it("does not send to a group or malformed recipient", async () => {
    const channel = new FacebookPageChannel(deps());
    await expect(channel.sendManual({ threadId: "group:100", peerKind: "group", text: "Hi", source: "web" })).rejects.toThrow();
    await expect(channel.send({ chatKey: "direct:not-id", text: "Hi" })).rejects.toThrow();
  });

  it("ignores malformed Page events without dropping valid messages", () => {
    const malformed = { object: "page", entry: [null, { id: "42", messaging: [
      null, { sender: { id: "100" }, recipient: { id: "42" },
        timestamp: 9e20, message: { mid: "m-3", text: "Xin chào", attachments: [null] } },
    ] }] };
    const parsed = parseFacebookPageWebhook("channel-1", "42", malformed);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.message.text).toBe("Xin chào");
    expect(Number.isFinite(parsed[0]!.message.sentAt?.getTime())).toBe(true);
  });

  it("sends text as a Page response and records the returned message ID", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(
      JSON.stringify({ message_id: "m-out" }), { status: 200, headers: { "content-type": "application/json" } },
    ));
    try {
      const onMessageLog = vi.fn();
      const channel = new FacebookPageChannel(deps({ onMessageLog }));
      const ids = await channel.sendManual({ threadId: "100", peerKind: "direct", text: "Chào anh", source: "web" });
      expect(ids).toEqual(["m-out"]);
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/42/messages"), expect.objectContaining({
        method: "POST", body: expect.stringContaining('"messaging_type":"RESPONSE"'),
      }));
      expect(onMessageLog).toHaveBeenCalledWith(expect.objectContaining({ msgId: "m-out", source: "web" }));
    } finally { fetchMock.mockRestore(); }
  });
});
