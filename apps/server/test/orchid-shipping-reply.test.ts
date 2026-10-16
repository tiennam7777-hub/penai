import { describe, expect, it } from "vitest";
import type { InboxMessageRow } from "@penai/db";
import { completeOrchidShippingReply, knownOrchidShippingHint, orchidShippingHintContext, orchidDeliveryPriorityContext } from "../src/orchid-shipping-reply.js";

const inbound = (text: string) => ({ direction: "in", text }) as InboxMessageRow;

describe("orchid quote with shipping", () => {
  it("calculates the known QL22 route from messages after /new", () => {
    const messages = [
      inbound("Phí giao bệnh viện xuyên á quốc lộ 22 là bao nhiêu"),
      inbound("/new"),
      inbound("Mai 9h giao 1 chậu trắng đến bệnh viện xuyên á trên quốc lộ 22. Giá bao nhiêu"),
      inbound("10 cành"),
    ];
    const hint = knownOrchidShippingHint(messages, "retail");
    expect(hint).toEqual({ destination: "Bệnh viện Xuyên Á trên QL22", distanceKm: 24.3, feeVnd: 180_000 });
    expect(orchidShippingHintContext(hint)).toContain("180.000đ");
    expect(completeOrchidShippingReply(
      "Chậu trắng 10 cành giá 2.000.000đ, chưa gồm VAT 5% em nhé. Phí giao đến Bệnh viện Xuyên Á trên QL22 Anh kiểm tra lại rồi báo em.",
      hint,
    )).toBe("Chậu trắng 10 cành giá 2.000.000đ, chưa gồm VAT 5% em nhé. Phí ship đến Bệnh viện Xuyên Á trên QL22 là 180.000đ.");
  });

  it("keeps unknown routes and existing shipping quotes untouched", () => {
    expect(knownOrchidShippingHint([inbound("10 cành đến địa chỉ mới")], "retail")).toBeNull();
    const hint = knownOrchidShippingHint([inbound("Chậu 10 cành giao HUTECH đối diện Coca-Cola, giá sao")], "retail");
    expect(hint?.feeVnd).toBe(100_000);
    expect(completeOrchidShippingReply("Chậu 10 cành giá 2.000.000đ. Phí ship 100.000đ.", hint))
      .toBe("Chậu 10 cành giá 2.000.000đ. Phí ship 100.000đ.");
  });

  it("drops the old hospital route when the customer gives a new delivery address", () => {
    const messages = [
      inbound("10 cành giao Bệnh viện Xuyên Á trên QL22"),
      inbound("Cho em 1 chậu 10 cành tím mai giao 1002 Kha Vạn Cân. Giá bao nhiêu"),
    ];
    expect(knownOrchidShippingHint(messages, "retail")).toBeNull();
    expect(orchidDeliveryPriorityContext(messages)).toContain("1002 Kha Vạn Cân");
  });
});
