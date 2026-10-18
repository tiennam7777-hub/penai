import { describe, expect, it } from "vitest";
import { buildOrchidStemReport, filterOrchidStemReport, orchidStemDateBounds, parseOrchidStemText } from "../src/orchid-stem-report.js";

describe("orchid stem report", () => {
  it("reads the actual group caption formats", () => {
    expect(parseOrchidStemText("C hong (9c)")).toEqual({ customerName: "C hong", stems: 9 });
    expect(parseOrchidStemText("C Chi (8c) Lộc")).toEqual({ customerName: "C Chi", stems: 8 });
    expect(parseOrchidStemText("Chị Lan (12 cành) Toàn")).toEqual({ customerName: "Chị Lan", stems: 12 });
    expect(parseOrchidStemText("Hà cii(3c 2v)")).toEqual({ customerName: "Hà cii", stems: 6 });
    expect(parseOrchidStemText("A trung. Cảnh 5 2v")).toEqual({ customerName: "A trung", stems: 10 });
    expect(parseOrchidStemText("C Chi (3c 2v) Lộc")).toEqual({ customerName: "C Chi", stems: 6 });
    expect(parseOrchidStemText("Hà phượg. 9. Cảnh")).toEqual({ customerName: "Hà phượg", stems: 9 });
    expect(parseOrchidStemText("Nacy 10 tam")).toEqual({ customerName: "Nacy", stems: 10 });
    expect(parseOrchidStemText("Mrr thế guta\n Cảnh 10")).toEqual({ customerName: "Mrr thế guta", stems: 10 });
    expect(parseOrchidStemText("Cảnh. A thịnh 9")).toEqual({ customerName: "A thịnh", stems: 9 });
    expect(parseOrchidStemText("Shop chị hương")).toBeNull();
    expect(parseOrchidStemText("C trang q9")).toBeNull();
    expect(parseOrchidStemText("Khách A 10 cành + ship 140000")).toBeNull();
    expect(parseOrchidStemText("C Chi (8c) hủy")).toBeNull();
    expect(parseOrchidStemText("C Chi (8c) Lộc 2")).toBeNull();
    expect(parseOrchidStemText("C Chi 3c 2v + ship 50000")).toBeNull();
    expect(parseOrchidStemText("C Chi 150c 2v")).toBeNull();
  });

  it("sums by stable sender ID and local day while keeping ambiguous messages for review", () => {
    const base = { senderId: "42", senderName: "Lộc", sentAt: "2026-10-18T12:00:00.000Z" };
    const report = buildOrchidStemReport([
      { ...base, msgId: "a", text: "C hong (9c)" },
      { ...base, msgId: "b", text: "Khách Hoa 5 cành" },
      { ...base, msgId: "c", text: "Shop chị hương 9 10" },
      { ...base, msgId: "d", text: "C Chi (8c) Lộc" },
    ]);
    expect(report.monthly).toMatchObject([{ senderId: "42", stems: 22, jobs: 3 }]);
    expect(report.daily).toMatchObject([{ day: "2026-10-18", stems: 22 }]);
    expect(report.review.map(x => x.msgId)).toEqual(["c"]);
  });

  it("joins a nearby customer name and quantity from the same sender and labels Hot 6 correctly", () => {
    const at = "2026-10-18T11:42:00.000Z";
    const report = buildOrchidStemReport([
      { msgId: "name", senderId: "one", senderName: "Trung Toàn", text: "c trang", sentAt: at },
      { msgId: "count", senderId: "one", senderName: "Trung Toàn", text: "10c", sentAt: "2026-10-18T11:42:10.000Z" },
      { msgId: "six", senderId: "six", senderName: "Lan Hồ Điệp Orchids World S", text: "Nacy 10 tam", sentAt: at },
    ]);
    expect(report.entries.map(x => [x.senderName, x.customerName, x.stems])).toEqual([
      ["Trung Toàn", "c trang", 10], ["Lan Hồ Điệp Orchids World VI", "Nacy", 10],
    ]);
  });

  it("multiplies cành by vòi in daily and monthly totals instead of sending these captions to review", () => {
    const at = "2026-10-18T08:00:00.000Z";
    const report = buildOrchidStemReport([
      { msgId: "pot-1", senderId: "van", senderName: "Văn Hoàng", text: "Hà cii(3c 2v)", sentAt: at },
      { msgId: "pot-2", senderId: "hot4", senderName: "Lan Hồ Điệp Orchids World Iv", text: "A trung. Cảnh 5 2v", sentAt: at },
    ]);
    expect(report.entries.map(x => [x.msgId, x.customerName, x.stems])).toEqual([
      ["pot-1", "Hà cii", 6], ["pot-2", "A trung", 10],
    ]);
    expect(report.daily.map(x => x.stems)).toEqual([6, 10]);
    expect(report.monthly.map(x => x.stems)).toEqual([6, 10]);
    expect(report.review).toEqual([]);
  });

  it("uses inclusive Vietnam dates across months and rejects invalid ranges", () => {
    const bounds = orchidStemDateBounds("2026-10-18", "2026-11-02");
    expect(bounds?.start.toISOString()).toBe("2026-10-17T17:00:00.000Z");
    expect(bounds?.end.toISOString()).toBe("2026-11-02T17:00:00.000Z");
    expect(orchidStemDateBounds("2026-02-30", "2026-03-01")).toBeNull();
    expect(orchidStemDateBounds("2026-11-02", "2026-10-18")).toBeNull();
  });

  it("filters all totals, details and review items to one employee", () => {
    const sentAt = "2026-10-18T08:00:00.000Z";
    const report = buildOrchidStemReport([
      { msgId: "a", senderId: "one", senderName: "Văn Hoàng", text: "Hà cii(3c 2v)", sentAt },
      { msgId: "b", senderId: "two", senderName: "Trung Toàn", text: "Chị Lan 8c", sentAt },
      { msgId: "c", senderId: "one", senderName: "Văn Hoàng", text: "Khách 8 9", sentAt },
    ]);
    const selected = filterOrchidStemReport(report, "Văn Hoàng");
    expect(selected.entries.map(x => x.msgId)).toEqual(["a"]);
    expect(selected.monthly.map(x => x.stems)).toEqual([6]);
    expect(selected.daily.map(x => x.stems)).toEqual([6]);
    expect(selected.review.map(x => x.msgId)).toEqual(["c"]);
  });
});
