import { describe, expect, it } from "vitest";
import { buildOrchidStemReport, parseOrchidStemText } from "../src/orchid-stem-report.js";

describe("orchid stem report", () => {
  it("reads the actual group caption formats", () => {
    expect(parseOrchidStemText("C hong (9c)")).toEqual({ customerName: "C hong", stems: 9 });
    expect(parseOrchidStemText("Hà phượg. 9. Cảnh")).toEqual({ customerName: "Hà phượg", stems: 9 });
    expect(parseOrchidStemText("Nacy 10 tam")).toEqual({ customerName: "Nacy", stems: 10 });
    expect(parseOrchidStemText("Shop chị hương")).toBeNull();
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
});
