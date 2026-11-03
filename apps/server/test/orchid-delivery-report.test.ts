import { describe, expect, it } from "vitest";
import { buildDeliveryReport, parseDeliveryReport } from "../src/orchid-delivery-report.js";
import { INDEX_HTML } from "../src/ui.js";
import vm from "node:vm";

const at = "2026-11-03T12:00:00.000Z";
describe("orchid delivery report", () => {
  it("reads actual delivery formats and separates far and heavy", () => {
    expect(parseDeliveryReport("2/11 Danh đi 11 đơn.1xa +2 nặng...kế hoạch mai giao sớm", at))
      .toMatchObject({ orders: 11, far: 1, heavy: 2, day: "2026-11-02" });
    expect(parseDeliveryReport("Ship 9 đơn ( 6 nặng 3 xa)", at)).toMatchObject({ orders: 9, far: 3, heavy: 6 });
    expect(parseDeliveryReport("Đi được 8 đơn, hỗ trợ thêm 1 đơn là 9 (2 đơn nặng 1 đơn xa)", at))
      .toMatchObject({ orders: 9, far: 1, heavy: 2 });
    expect(parseDeliveryReport("3/11 Ship 12 đơn (2 nặng) lấy 4 thùng hoa (3 nặng)", at))
      .toMatchObject({ orders: 12, far: 0, heavy: 2 });
    expect(parseDeliveryReport("02/11 Đi Được 6 đơn, trong đo co 2 đon xa", at))
      .toMatchObject({ orders: 6, far: 2, heavy: 0 });
    expect(parseDeliveryReport("BCCV a di dc 10 don..1 xa.5 nang..tang ca tối", at))
      .toMatchObject({ orders: 10, far: 1, heavy: 5 });
    expect(parseDeliveryReport("1/11 e đi tổng 16 đơn..1xa..5 nặng..tăng ca", at))
      .toMatchObject({ orders: 16, far: 1, heavy: 5, day: "2026-11-01" });
    expect(parseDeliveryReport("3/11 giao 2đơn --- tăng ca", at))
      .toMatchObject({ orders: 2, far: 0, heavy: 0 });
  });
  it("ignores sales, flower work, and tomorrow's plan", () => {
    expect(parseDeliveryReport("chat lên đơn 23 đơn; phân đơn cắm", at)).toBeNull();
    expect(parseDeliveryReport("Cắm 7 đơn; KHNM giao 5 đơn", at)).toBeNull();
  });
  it("takes latest report once per employee and ranks by monthly deliveries", () => {
    const messages = [
      { msgId: "1", senderId: "a", senderName: "A", text: "giao 5 đơn", sentAt: at },
      { msgId: "2", senderId: "a", senderName: "A", text: "giao 8 đơn", sentAt: "2026-11-03T13:00:00Z" },
      { msgId: "3", senderId: "b", senderName: "B", text: "ship 9 đơn", sentAt: at },
    ];
    const report = buildDeliveryReport(messages, "2026-11-03", "2026-11-03");
    expect(report.monthly.map(x => [x.senderName, x.orders])).toEqual([["B", 9], ["A", 8]]);
    expect(report.totals.orders).toBe(17);
  });
  it("keeps the dashboard script valid and shows the delivery item after flower report", () => {
    const script = INDEX_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new vm.Script(script!.replace(/%%[A-Z_]+%%/g, "null"))).not.toThrow();
    expect(INDEX_HTML.indexOf('id: "delivery-report"')).toBeGreaterThan(INDEX_HTML.indexOf('id: "stem-report"'));
  });
});
