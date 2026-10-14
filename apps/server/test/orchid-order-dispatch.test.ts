import { describe, expect, it } from "vitest";
import {
  classifyConfirmedOrchidOrder, formatOrchidOrderDispatch, mayConfirmOrchidOrder,
  orchidOrderFingerprint, parseConfirmedOrchidOrder,
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
  });

  it("forms one usable group message even when the agreed price is absent", () => {
    const order = parseConfirmedOrchidOrder(JSON.stringify({
      confirmed: true, customer: "Anh Nam", pot: "chậu lan cây cao",
      stems: 15, color: "vàng", price: null, delivery: "08:00 15/10/2026",
    }));
    expect(order).not.toBeNull();
    expect(formatOrchidOrderDispatch(order!, "Tiến Nam")).toBe(
      "- Khách hàng: Tiến Nam\n- chậu lan cây cao 15 cành màu vàng; giá: chưa chốt; thời gian giao: 08:00 15/10/2026",
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
