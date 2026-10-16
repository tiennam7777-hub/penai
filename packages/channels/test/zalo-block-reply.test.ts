import { describe, expect, it, vi } from "vitest";
import { ThreadType } from "zca-js";
import { parseAiReplyDelaySeconds, ZaloPersonalChannel } from "../src/zalo-personal.js";

it("accepts only the configured Zalo reply delay choices", () => {
  expect(parseAiReplyDelaySeconds({})).toBe(0);
  expect(parseAiReplyDelaySeconds({ ai_reply_delay_seconds: 15 })).toBe(15);
  expect(parseAiReplyDelaySeconds({ ai_reply_delay_seconds: 40 })).toBe(40);
  expect(parseAiReplyDelaySeconds({ ai_reply_delay_seconds: "40" })).toBe(0);
  expect(parseAiReplyDelaySeconds({ ai_reply_delay_seconds: 41 })).toBe(0);
});

it("waits at least 15 seconds from the customer's message before sending AI replies", async () => {
  vi.useFakeTimers();
  try {
    const sendMessage = vi.fn(async (_input: { msg: string }) => ({ message: { msgId: "out-1" }, attachment: [] }));
    const channel = new ZaloPersonalChannel({
      id: "delayed-reply", name: "Hot 1", token: "{}",
      config: { ai_reply_delay_seconds: 15 }, requirePairing: false,
      onInbound: async (_msg, hooks) => {
        hooks?.onBlockReply?.("Em kiểm tra phí ship nhé.");
        return { kind: "reply", text: "Phí ship là 80.000đ." };
      },
    });
    Object.assign(channel, { api: { sendMessage }, account: { id: "self", name: "Shop" } });
    const handle = (channel as unknown as { handleMessage: (message: unknown) => Promise<void> }).handleMessage.bind(channel);
    const pending = handle({ type: ThreadType.User, threadId: "customer", isSelf: false,
      data: { msgId: "incoming-delay", uidFrom: "customer", content: "Ship bao nhiêu?", msgType: "webchat" } });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(sendMessage.mock.calls.map(([input]) => input.msg)).toEqual([
      "Em kiểm tra phí ship nhé.", "Phí ship là 80.000đ.",
    ]);
  } finally {
    vi.useRealTimers();
  }
});

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
