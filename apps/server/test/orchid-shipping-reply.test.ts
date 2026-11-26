import { describe, expect, it } from "vitest";
import type { InboxMessageRow } from "@penai/db";
import { completeOrchidShippingReply, knownOrchidShippingHint, makeOrchidShippingHint, orchidShippingHintContext, orchidDeliveryPriorityContext, orchidShippingRequest } from "../src/orchid-shipping-reply.js";

const inbound = (text: string) => ({ direction: "in", text }) as InboxMessageRow;
const outbound = (text: string) => ({ direction: "out", text }) as InboxMessageRow;

describe("orchid quote with shipping", () => {
  it("accepts a street and residential area without asking for a house or tower", () => {
    const request = orchidShippingRequest([outbound("Chậu 7 cành giá 1.400.000đ."), inbound("đường D1 đó, khu Vinhome quận 9")]);
    expect(request).toEqual({ destination: "đường D1 đó, khu Vinhome quận 9", stemCount: 7 });
    const hint = makeOrchidShippingHint({ destination: request!.destination, stemCount: 7, distanceKm: 24.8, customerType: "retail" });
    expect(orchidShippingHintContext(hint)).toContain("sai số vị trí 500 m–1 km");
    expect(completeOrchidShippingReply("Dạ anh.", hint)).toContain("khoảng 180.000đ");
  });
  it.each([3.2, 8, 9.99, 10])("suppresses retail delivery fees at %s km, including free-delivery wording", distanceKm => {
    const hint = makeOrchidShippingHint({ destination: "290 Nam Kỳ Khởi Nghĩa", distanceKm, stemCount: 10, customerType: "retail" });
    expect(hint?.reportFee).toBe(false);
    expect(orchidShippingHintContext(hint)).toContain('Chỉ xác nhận ngắn "Dạ"');
    expect(completeOrchidShippingReply("Phí ship là 70.000đ.", hint)).toBe("Dạ.");
    expect(completeOrchidShippingReply("Giao miễn phí chị nhé.", hint)).toBe("Dạ.");
    expect(completeOrchidShippingReply("Chị gửi em ghim vị trí để tính phí giao nhé.", hint)).toBe("Dạ.");
    expect(completeOrchidShippingReply("Chậu 10 cành giá 2.000.000đ, phí ship 70.000đ.", hint)).toBe("Chậu 10 cành giá 2.000.000đ");
    expect(completeOrchidShippingReply("Dạ chị.", hint)).toBe("Dạ chị.");
  });
  it("reports fees strictly above 10 km and for wholesale customers at any distance", () => {
    const retail = makeOrchidShippingHint({ destination: "Điểm xa", distanceKm: 10.001, stemCount: 10, customerType: "retail" });
    const wholesale = makeOrchidShippingHint({ destination: "Điểm gần", distanceKm: 2, stemCount: 10, customerType: "wholesale" });
    expect(retail?.reportFee).toBe(true);
    expect(completeOrchidShippingReply("Dạ.", retail)).toContain("Phí ship");
    expect(wholesale).toMatchObject({ reportFee: true, feeVnd: 20_000 });
    expect(completeOrchidShippingReply("Dạ.", wholesale)).toContain("20.000đ");
  });
  it("does not ask retail customers for shipping fees without a verified route over 10 km", () => {
    expect(completeOrchidShippingReply("Dạ chị. Em cần nhân viên xác minh phí giao.", null, "retail")).toBe("Dạ chị.");
    expect(completeOrchidShippingReply("", null, "retail")).toBe("");
    expect(completeOrchidShippingReply("Chậu giá 500.000đ.", null, "retail")).toBe("Chậu giá 500.000đ.");
    expect(completeOrchidShippingReply("Dạ, shipper giao lúc 8h30.", null, "retail")).toBe("Dạ, shipper giao lúc 8h30.");
    expect(completeOrchidShippingReply("Cần nhân viên xác minh phí giao.", null, "wholesale")).toBe("Cần nhân viên xác minh phí giao.");
  });
  it("suppresses retail shipping inside 10 km regardless of pot size", () => {
    for (const stemCount of [1, 2, 36, 100]) {
      expect(makeOrchidShippingHint({ destination: "Điểm gần", distanceKm: 10, stemCount, customerType: "retail" })?.reportFee).toBe(false);
    }
    expect(makeOrchidShippingHint({ destination: "Điểm xa", distanceKm: 11, stemCount: 2, customerType: "retail" })).toBeNull();
  });
  it("recognizes the real bare address that previously caused a deferred quote", () => {
    expect(orchidShippingRequest([outbound("Dạ chậu mẫu 7 cành giá 1.400.000đ chưa VAT ạ."),
      inbound("31 đống đa p2 bình thạnh")])).toEqual({ destination: "31 đống đa p2 bình thạnh", stemCount: 7 });
  });
  it("does not reuse shipping data across reset or infer stems for multiple pots", () => {
    expect(orchidShippingRequest([inbound("10 cành giao HUTECH đối diện Coca-Cola"), inbound("/new"), inbound("31 đống đa p2 bình thạnh")])).toBeNull();
    expect(orchidShippingRequest([inbound("2 chậu 10 cành giao HUTECH đối diện Coca-Cola")])).toBeNull();
    expect(orchidShippingRequest([inbound("7-10 cành giao HUTECH đối diện Coca-Cola")])).toBeNull();
  });
  it("calculates the known QL22 route from messages after /new", () => {
    const messages = [
      inbound("Phí giao bệnh viện xuyên á quốc lộ 22 là bao nhiêu"),
      inbound("/new"),
      inbound("Mai 9h giao 1 chậu trắng đến bệnh viện xuyên á trên quốc lộ 22. Giá bao nhiêu"),
      inbound("10 cành"),
    ];
    const hint = knownOrchidShippingHint(messages, "retail");
    expect(hint).toEqual({ destination: "Bệnh viện Xuyên Á trên QL22", distanceKm: 24.3, feeVnd: 180_000, reportFee: true });
    expect(orchidShippingHintContext(hint)).toContain("180.000đ");
    expect(completeOrchidShippingReply(
      "Chậu trắng 10 cành giá 2.000.000đ, chưa gồm VAT 5% em nhé. Phí giao đến Bệnh viện Xuyên Á trên QL22 Anh kiểm tra lại rồi báo em.",
      hint,
    )).toBe("Chậu trắng 10 cành giá 2.000.000đ, chưa gồm VAT 5% em nhé. Phí ship đến Bệnh viện Xuyên Á trên QL22 khoảng 180.000đ.");
  });

  it("keeps unknown routes and existing shipping quotes untouched", () => {
    expect(knownOrchidShippingHint([inbound("10 cành đến địa chỉ mới")], "retail")).toBeNull();
    const hint = knownOrchidShippingHint([inbound("Chậu 10 cành giao HUTECH đối diện Coca-Cola, giá sao")], "retail");
    expect(hint?.feeVnd).toBe(100_000);
    expect(completeOrchidShippingReply("Chậu 10 cành giá 2.000.000đ. Phí ship 100.000đ.", hint))
      .toBe("Chậu 10 cành giá 2.000.000đ. Phí ship 100.000đ.");
    expect(completeOrchidShippingReply("Phí ship 80.000đ.", hint)).toBe("Phí ship đến HUTECH đối diện Coca-Cola khoảng 100.000đ.");
  });

  it("drops the old hospital route when the customer gives a new delivery address", () => {
    const messages = [
      inbound("10 cành giao Bệnh viện Xuyên Á trên QL22"),
      inbound("Cho em 1 chậu 10 cành tím mai giao 1002 Kha Vạn Cân. Giá bao nhiêu"),
    ];
    expect(knownOrchidShippingHint(messages, "retail")).toBeNull();
    expect(orchidDeliveryPriorityContext(messages)).toContain("1002 Kha Vạn Cân");
  });

  it("quotes a known route when the customer supplies the address without asking the price", () => {
    const messages = [inbound("Chậu 10 cành"), inbound("Giao đến Bệnh viện Xuyên Á trên QL22 sáng mai")];
    const hint = knownOrchidShippingHint(messages, "retail");
    expect(hint?.feeVnd).toBe(180_000);
    expect(completeOrchidShippingReply("Anh nhận địa chỉ rồi em nhé.", hint))
      .toBe("Anh nhận địa chỉ rồi em nhé. Phí ship đến Bệnh viện Xuyên Á trên QL22 khoảng 180.000đ.");
  });
});
