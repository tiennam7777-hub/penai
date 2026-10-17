import { describe, expect, it } from "vitest";
import {
  classifyConfirmedOrchidOrder, classifyOrchidOrderCancellation,
  formatOrchidOrderCancellation, formatOrchidOrderDispatch,
  mayCancelOrchidOrder, mayConfirmOrchidOrder, orchidCancellationFingerprint,
  orchidOrderFingerprint, parseConfirmedOrchidOrder, parseOrchidOrderCancellation,
} from "../src/orchid-order-dispatch.js";
import type { Provider } from "@penai/providers";

describe("orchid order dispatch", () => {
  it("only classifies messages that might confirm an order", () => {
    expect(mayConfirmOrchidOrder("Ok e")).toBe(true);
    expect(mayConfirmOrchidOrder("Chốt chậu này giao sáng mai nhé")).toBe(true);
    expect(mayConfirmOrchidOrder("Anh hỏi giá chậu 15 cành")).toBe(false);
  });
  it("rejects inquiries and incomplete confirmations", () => {
    expect(parseConfirmedOrchidOrder('{"confirmed":false}')).toBeNull();
    expect(parseConfirmedOrchidOrder('{"confirmed":true,"stems":15,"color":"vàng","delivery":""}')).toBeNull();
    expect(parseConfirmedOrchidOrder('{"confirmed":true,"stems":0,"color":"vàng","delivery":"08:00 15/10/2026"}')).toBeNull();
    expect(parseConfirmedOrchidOrder("not-json")).toBeNull();
    expect(parseConfirmedOrchidOrder('{"confirmed":true,"stems":5,"color":"vàng","delivery":null}')).toBeNull();
    expect(parseConfirmedOrchidOrder('{"confirmed":true,"stems":5,"color":"vàng","delivery":null,"deliveryDeferred":true,"addressDeferred":true}')).toMatchObject({
      stems: 5, color: "vàng", delivery: null,
    });
  });

  it("forms one usable group message even when the agreed price is absent", () => {
    const order = parseConfirmedOrchidOrder(JSON.stringify({
      confirmed: true, customer: "Anh Nam", pot: "chậu lan cây cao",
      stems: 15, color: "vàng", price: null, delivery: "08:00 15/10/2026", addressDeferred: true,
    }));
    expect(order).not.toBeNull();
    expect(formatOrchidOrderDispatch(order!, "Tiến Nam")).toBe(
      "- Khách hàng: Tiến Nam\n- chậu lan cây cao 15 cành màu vàng; giá: chưa chốt; thời gian giao: 08:00 15/10/2026; địa chỉ: khách báo sau",
    );
    expect(orchidOrderFingerprint(order!)).toBe(orchidOrderFingerprint({ ...order!, customer: "Tên khác" }));
  });

  it("checks the current Zalo message even if its asynchronous Inbox log has not arrived", async () => {
    let prompt = "";
    const provider = { chat: async (input: { messages: Array<{ content: string }> }) => {
      prompt = input.messages[0]!.content;
      return { stopReason: "end", toolCalls: [], content: '{"confirmed":false}' };
    } } as unknown as Provider;
    const result = await classifyConfirmedOrchidOrder(provider, "test", [],
      { text: "Ok e", senderName: "Tiến Nam" }, new Date("2026-10-14T16:10:00Z"));
    expect(result).toBeNull();
    expect(prompt).toContain("Khách (Tiến Nam): Ok e");
    expect(prompt).toContain("Tin khách mới nhất cần xét: Ok e");
  });
});

describe("orchid cancellation dispatch", () => {
  it("recognizes explicit and partial cancellation candidates", () => {
    expect(mayCancelOrchidOrder("Chị hủy đơn này")).toBe(true);
    expect(mayCancelOrchidOrder("Còn 1 chậu giao VOV thôi")).toBe(true);
    expect(mayCancelOrchidOrder("Giá chậu này bao nhiêu?")).toBe(false);
  });

  it("forms one short group notice without claiming staff already stopped the order", () => {
    const full = parseOrchidOrderCancellation('{"cancelled":true,"scope":"all","part":"","remaining":""}');
    const partial = parseOrchidOrderCancellation('{"cancelled":true,"scope":"partial","part":"1 chậu","remaining":"1 chậu giao VOV"}');
    expect(formatOrchidOrderCancellation(full!, "Chị Trang")).toBe(
      "Đơn hàng Chị Trang: khách yêu cầu hủy toàn bộ đơn. Nhờ nhân viên kiểm tra và dừng đơn.",
    );
    expect(formatOrchidOrderCancellation(partial!, "Chị Trang")).toBe(
      "Đơn hàng Chị Trang: khách yêu cầu hủy 1 chậu, giữ 1 chậu giao VOV. Nhờ nhân viên kiểm tra và dừng phần hủy.",
    );
    expect(parseOrchidOrderCancellation('{"cancelled":true,"scope":"partial","part":""}')).toBeNull();
    expect(parseOrchidOrderCancellation('{"cancelled":false}')).toBeNull();
  });

  it("deduplicates the same Zalo message and excludes a second message", () => {
    const now = new Date("2026-10-17T00:00:00Z");
    const first = orchidCancellationFingerprint("zalo-1", "Hủy 1 chậu", now);
    expect(first).toBe(orchidCancellationFingerprint("zalo-1", "Hủy 1 chậu", now));
    expect(first).not.toBe(orchidCancellationFingerprint("zalo-2", "Hủy 1 chậu", now));
    expect(first).not.toBe(orchidOrderFingerprint({ customer: "Trang", stems: 5, color: "vàng", pot: "chậu", price: null, delivery: "08:00 17/10/2026" }));
  });

  it("uses the latest customer request and its conversation context", async () => {
    let prompt = "";
    const provider = { chat: async (input: { messages: Array<{ content: string }> }) => {
      prompt = input.messages[0]!.content;
      return { stopReason: "end", toolCalls: [], content: '{"cancelled":true,"scope":"partial","part":"1 chậu","remaining":"1 chậu giao VOV"}' };
    } } as unknown as Provider;
    const result = await classifyOrchidOrderCancellation(provider, "test", [],
      { text: "Còn 1 chậu giao VOV thôi", senderName: "Chị Trang" }, new Date("2026-10-17T00:00:00Z"));
    expect(result?.scope).toBe("partial");
    expect(prompt).toContain("Khách (Chị Trang): Còn 1 chậu giao VOV thôi");
    expect(prompt).toContain("Tin khách mới nhất cần xét: Còn 1 chậu giao VOV thôi");
  });
});
