import { describe, expect, it, vi } from "vitest";
import { ThreadType } from "zca-js";
import { ZaloPersonalChannel } from "../src/zalo-personal.js";

describe("Zalo block replies", () => {
  it.each([
    { final: "em gửi a màu hoa đang có", expected: ["em gửi a màu hoa đang có"] },
    { final: "Anh chọn màu nào nhắn em nhé", expected: ["em gửi a màu hoa đang có", "Anh chọn màu nào nhắn em nhé"] },
  ])("sends each distinct reply once: $final", async ({ final, expected }) => {
    const sendMessage = vi.fn(async (_input: { msg: string }) => ({ message: { msgId: "out-1" }, attachment: [] }));
    const channel = new ZaloPersonalChannel({
      id: "reply-test", name: "Reply test", token: "{}", config: {}, requirePairing: false,
      onInbound: async (_msg, hooks) => {
        hooks?.onBlockReply?.("em gửi a màu hoa đang có");
        hooks?.onBlockReply?.("em gửi a màu hoa đang có");
        return { kind: "reply", text: final };
      },
    });
    Object.assign(channel, { api: { sendMessage }, account: { id: "self", name: "Shop" } });
    const handle = (channel as unknown as { handleMessage: (message: unknown) => Promise<void> }).handleMessage.bind(channel);
    await handle({ type: ThreadType.User, threadId: "customer", isSelf: false,
      data: { msgId: "incoming-1", uidFrom: "customer", content: "Gửi màu hoa", msgType: "webchat" } });
    expect(sendMessage.mock.calls.map(([input]) => input.msg)).toEqual(expected);
  });
});
