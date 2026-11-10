import { describe, expect, it } from "vitest";
import type { InboxMessageRow } from "@penai/db";
import type { Provider } from "@penai/providers";
import { classifyOrchidOrderDecision, currentOrchidOrderMessages, explicitOrchidOrderCommitment,
  formatOrchidOrderReview, orchidOrderReviewReply, parseOrchidOrderDecision, mayConfirmOrchidOrder, orchidOrderReviewFingerprint,
} from "../src/orchid-order-dispatch.js";

const now = new Date("2026-11-08T12:08:53Z");
const rows = (data: Array<Partial<InboxMessageRow>>) => data.map((row, i) => ({
  id: String(i + 1), direction: "in", source: "zalo", senderName: "Quỳnh Như", msgId: `msg-${i}`,
  sentAt: "2026-11-08T12:04:00Z", text: "", contentType: "text", meta: null, media: null, ...row,
})) as InboxMessageRow[];
const history = rows([
  { text: "Anh ơi em đặt lan ạ" },
  { contentType: "photo", media: { localPath: "/workspace/photo.jpg" } },
  { text: "Dạ mẫu này ạ" },
  { text: "45-47 Nguyễn Văn Kỉnh, Cát Lái - Openlive" },
  { text: "Dạ giao tầm 11h sáng mai. Ngày 9/11" },
  { text: "Dạ làm giúp em" },
]);
function provider(content: string | null, stopReason = "end"): Provider {
  return { chat: async () => ({ content, stopReason, toolCalls: [] }) } as unknown as Provider;
}

describe("orders selected by photo must not disappear", () => {
  it("keeps Quỳnh Như's confirmed photo order as a review when stems are unknown", async () => {
    const result = await classifyOrchidOrderDecision(provider(JSON.stringify({
      confirmed: true, stems: null, color: "mẫu ảnh khách chọn", delivery: "11:00 09/11/2026",
      address: "45-47 Nguyễn Văn Kỉnh, Cát Lái - Openlive",
    })), "test", history, { text: "Dạ làm giúp em", senderName: "Quỳnh Như" }, now);
    expect(result.kind).toBe("review");
    if (result.kind !== "review") throw new Error("Order dropped");
    expect(result.review.missing).toEqual(["số cành"]);
    const notice = formatOrchidOrderReview(result.review, "Ms Quỳnh Như", history, "Dạ làm giúp em");
    expect(notice).toContain("CHƯA LÊN BILL");
    expect(notice).toContain("11:00 09/11/2026");
    expect(notice).toContain("45-47 Nguyễn Văn Kỉnh");
    expect(orchidOrderReviewReply(result.review, true)).toContain("Đơn chưa lên bill");
    expect(orchidOrderReviewReply(result.review, false)).not.toContain("đã báo nhân viên");
  });

  it.each([null, '{"confirmed":false}', 'invalid', '{"confirmed":true', 'null'])(
    "escalates an explicit commitment even if classification returns %s", async (raw) => {
      expect((await classifyOrchidOrderDecision(provider(raw), "test", history,
        { text: "Dạ làm giúp em", senderName: "Quỳnh Như" }, now)).kind).toBe("review");
    });

  it("preserves the order when provider is unavailable or output is truncated", async () => {
    const broken = { chat: async () => { throw new Error("fetch failed"); } } as unknown as Provider;
    for (const p of [broken, provider('{"confirmed":true,"stems":5,"color":"vàng"}', "max_tokens")]) {
      expect((await classifyOrchidOrderDecision(p, "test", history,
        { text: "Dạ làm giúp em", senderName: "Quỳnh Như" }, now)).kind).toBe("review");
    }
  });

  it("sends actual photos and verified counts to the decision provider", async () => {
    let input: Record<string, any> = {};
    const p = { chat: async (request: typeof input) => {
      input = request;
      return { content: '{"confirmed":true,"stems":8,"color":"mẫu ảnh khách chọn"}', stopReason: "end", toolCalls: [] };
    } } as unknown as Provider;
    const evidence = [{ messageId: "sample-8", sentAt: now.toISOString(), dataUrl: "data:image/jpeg;base64,cGhvdG8=", stems: 8 }];
    expect((await classifyOrchidOrderDecision(p, "test", history,
      { text: "Dạ làm giúp em", senderName: "Quỳnh Như" }, now, evidence)).kind).toBe("ready");
    expect(input.messages[0].images).toEqual([evidence[0]!.dataUrl]);
    expect(input.messages[0].content).toContain("thư viện đã xác minh 8 cành");
    expect(input.system).toContain("không ước lượng số cành");
  });

  it("continues to create a bill when the customer supplies the missing stems", async () => {
    expect(mayConfirmOrchidOrder("8 cành nha")).toBe(true);
    expect(mayConfirmOrchidOrder("8")).toBe(true);
    expect(mayConfirmOrchidOrder("8 nha")).toBe(true);
    expect(mayConfirmOrchidOrder("vàng nha")).toBe(true);
    const result = await classifyOrchidOrderDecision(provider('{"confirmed":true,"stems":8,"color":"mẫu ảnh khách chọn"}'),
      "test", history, { text: "8 cành nha", senderName: "Quỳnh Như" }, now);
    expect(result.kind).toBe("ready");
  });

  it.each(["Dạ cảm ơn", "Dạ", "Giá mẫu này bao nhiêu?", "Chưa làm giúp em nhé", "Đừng chốt", "Làm bảng chữ giúp em", "đổi mẫu giúp em", "hủy đơn giúp em"])(
    "does not turn %s into a fallback order", async (text) => {
      expect(explicitOrchidOrderCommitment(text, history)).toBe(false);
      expect((await classifyOrchidOrderDecision(provider('{"confirmed":false}'), "test", history,
        { text, senderName: "Quỳnh Như" }, now)).kind).toBe("none");
    });

  it("never turns missing/invalid products into zero-stem bills", () => {
    for (const stems of [null, 0, -1, 201]) {
      expect(parseOrchidOrderDecision(JSON.stringify({ confirmed: true, stems, color: "ảnh mẫu" })).kind).toBe("review");
    }
    expect(parseOrchidOrderDecision('{"confirmed":true,"stems":8,"color":null}').kind).toBe("review");
    expect(parseOrchidOrderDecision("null").kind).toBe("none");
  });

  it("does not report an initial shopping enquiry before the customer picks a product", async () => {
    const enquiry = rows([{ text: "Anh ơi em đặt lan ạ" }]);
    expect((await classifyOrchidOrderDecision(provider('{"confirmed":false}'), "test", enquiry,
      { text: "Anh ơi em đặt lan ạ", senderName: "Quỳnh Như" }, now)).kind).toBe("none");
  });

  it("deduplicates repeated confirmations without blocking the completed order's report", () => {
    const key = orchidOrderReviewFingerprint(history, now);
    expect(key).toMatch(/^order-review:/);
    expect(key).not.toMatch(/^order-session:/);
    expect(orchidOrderReviewFingerprint([...history, ...rows([{ id: "repeat", text: "chốt chậu này nha" }])], now)).toBe(key);
    expect(orchidOrderReviewFingerprint(rows([{ id: "new-order", text: "Em đặt lan" }]), now)).not.toBe(key);
  });

  it("excludes old purchases, recalled photos, and messages before /new", () => {
    const old = rows([{ text: "5 cành xanh", sentAt: "2026-10-13T05:15:00Z" }, ...history]);
    expect(currentOrchidOrderMessages(old, now).some((m) => m.text === "5 cành xanh")).toBe(false);
    const reset = rows([{ text: "đặt lan", sentAt: "2026-11-08T11:00:00Z" },
      { text: "/new" }, { text: "mẫu mới" }, { contentType: "photo", meta: { removed: "recalled" } }]);
    expect(currentOrchidOrderMessages(reset, now).map((m) => m.text)).toEqual(["mẫu mới"]);
  });
});
