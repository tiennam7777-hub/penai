import { describe, expect, it } from "vitest";
import { buildOrchidStemReport, parseOrchidStemText } from "../src/orchid-stem-report.js";

describe("orchid stem report", () => {
  it("reads the actual group caption formats", () => {
    expect(parseOrchidStemText("C hong (9c)")).toEqual({ customerName: "C hong", stems: 9 });
    expect(parseOrchidStemText("Hà phượg. 9. Cảnh")).toEqual({ customerName: "Hà phượg", stems: 9 });
    expect(parseOrchidStemText("Nacy 10 tam")).toEqual({ customerName: "Nacy", stems: 10 });
    expect(parseOrchidStemText("Mrr thế guta\n Cảnh 10")).toEqual({ customerName: "Mrr thế guta", stems: 10 });
    expect(parseOrchidStemText("Cảnh. A thịnh 9")).toEqual({ customerName: "A thịnh", stems: 9 });
    expect(parseOrchidStemText("Shop chị hương")).toBeNull();
    expect(parseOrchidStemText("C trang q9")).toBeNull();
    expect(parseOrchidStemText("Khách A 10 cành + ship 140000")).toBeNull();
  });

  it("sums by stable sender ID and local day while keeping ambiguous messages for review", () => {
    const base = { senderId: "42", senderName: "Lộc", sentAt: "2026-10-18T12:00:00.000Z" };
    const report = buildOrchidStemReport([
      { ...base, msgId: "a", text: "C hong (9c)" },
      { ...base, msgId: "b", text: "Khách Hoa 5 cành" },
      { ...base, msgId: "c", text: "Shop chị hương 9 10" },
    ]);
    expect(report.monthly).toMatchObject([{ senderId: "42", stems: 14, jobs: 2 }]);
    expect(report.daily).toMatchObject([{ day: "2026-10-18", stems: 14 }]);
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
});
