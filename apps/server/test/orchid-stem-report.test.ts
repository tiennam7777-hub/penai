import { describe, expect, it } from "vitest";
import { addOrchidWorkPlanCounts, buildOrchidStemReport, filterOrchidStemReport, orchidStemDateBounds, orchidStemRefreshMonths, orchidStemTime, parseOrchidStemText, parseOrchidWorkPlanCount } from "../src/orchid-stem-report.js";
import { INDEX_HTML } from "../src/ui.js";

describe("orchid stem report", () => {
  it("reads completed daily self reports without taking tomorrow's plan", () => {
    const at = "2026-10-29T13:00:00.000Z";
    expect(parseOrchidWorkPlanCount("báo cáo cv\ntổng cắm 124c\nKh 30/10 cắm đơn", at))
      .toEqual({ day: "2026-10-29", stems: 124 });
    expect(parseOrchidWorkPlanCount("Bccv\nCắm 107\nKh 30/10 cắm hoa", at)?.stems).toBe(107);
    expect(parseOrchidWorkPlanCount("Bccv\n- tổng cắm 10₫(70 cây)\n-kh30/10", at)?.stems).toBe(70);
    expect(parseOrchidWorkPlanCount("Bccv: cắm 12 đơn 105 cây. Kh 30/10", at)?.stems).toBe(105);
    expect(parseOrchidWorkPlanCount("28/10\nCắm 56 cây\n29/10\nCắm 100 cây nếu có đơn", at))
      .toEqual({ day: "2026-10-28", stems: 56 });
    expect(parseOrchidWorkPlanCount("KH 30/10\nCắm 100 cây", at)).toBeNull();
  });

  it("matches NVBC by sender ID and original day, keeping missing reports blank", () => {
    const report = buildOrchidStemReport([
      { msgId: "one", senderId: "uid-1", senderName: "Trung Toàn", text: "Khách Hoa 5c", sentAt: "2026-10-29T03:00:00.000Z" },
      { msgId: "two", senderId: "uid-2", senderName: "Lộc Nguyễn", text: "Khách Lan 8c", sentAt: "2026-10-29T03:00:00.000Z" },
    ]);
    const joined = addOrchidWorkPlanCounts(report, [
      { msgId: "a", senderId: "uid-1", senderName: "Trung Toàn", text: "Bccv\ntổng cắm 110c", sentAt: "2026-10-29T12:00:00.000Z" },
      { msgId: "b", senderId: "uid-1", senderName: "Trung Toàn", text: "Bccv\ntổng cắm 124c", sentAt: "2026-10-29T16:00:00.000Z" },
      { msgId: "c", senderId: "other-uid", senderName: "Lộc Nguyễn", text: "Bccv\nCắm 107", sentAt: "2026-10-29T16:00:00.000Z" },
    ]);
    expect(joined.daily.map(x => x.nvbc)).toEqual([124, null]);
    expect(joined.monthly.map(x => x.nvbc)).toEqual([124, null]);
  });
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

  it("counts a later quote of the sender's own unnumbered photo once on the photo day", () => {
    const photo = { msgId: "photo-1", senderId: "worker", senderName: "Lộc", text: "", contentType: "photo",
      sentAt: "2026-10-18T16:55:00.000Z", inRange: true };
    const report = buildOrchidStemReport([
      photo,
      { msgId: "quote-1", senderId: "worker", senderName: "Lộc", text: "8c", quotedMsgId: "photo-1",
        quoteOwnerId: "worker", sentAt: "2026-10-19T00:05:00.000Z", inRange: true },
      { msgId: "quote-2", senderId: "worker", senderName: "Lộc", text: "8 cành", quotedMsgId: "photo-1",
        quoteOwnerId: "worker", sentAt: "2026-10-19T00:06:00.000Z", inRange: true },
    ]);
    expect(report.entries).toMatchObject([{ msgId: "quote-1", quotedPhotoMsgId: "photo-1",
      senderId: "worker", stems: 8, day: "2026-10-18",
      sentAt: "2026-10-18T16:55:00.000Z", quoteSentAt: "2026-10-19T00:05:00.000Z" }]);
    expect(report.monthly).toMatchObject([{ stems: 8, jobs: 1 }]);
    expect(orchidStemTime(report.entries[0]!.sentAt)).toBe("23:55");
  });

  it("matches a quoted photo by Zalo cliMsgId when globalMsgId is zero", () => {
    const report = buildOrchidStemReport([
      { msgId: "photo", cliMsgId: "1793266190761", senderId: "worker", senderName: "Lộc Nguyễn",
        text: "", contentType: "photo", sentAt: "2026-10-29T09:29:51.266Z" },
      { msgId: "quote", quotedMsgId: "0", quotedCliMsgId: "1793266190761", quoteOwnerId: "worker",
        senderId: "worker", senderName: "Lộc Nguyễn", text: "20c", sentAt: "2026-10-29T16:34:37.417Z" },
    ]);
    expect(report.entries).toMatchObject([{ senderName: "Lộc Nguyễn", stems: 20,
      day: "2026-10-29", quotedPhotoMsgId: "photo" }]);
  });

  it("places an owner-confirmed legacy quote on the original photo day without inventing its time", () => {
    const report = buildOrchidStemReport([
      { msgId: "quote", quotedMsgId: "0", quoteOwnerId: "worker", senderId: "worker",
        senderName: "Trung Toàn", text: "cen 20c", originalPhotoDay: "2026-10-28",
        sentAt: "2026-10-29T11:25:44.497Z", inRange: true },
    ]);
    expect(report.entries).toMatchObject([{ day: "2026-10-28", sentAt: "2026-10-29T11:25:44.497Z",
      quoteSentAt: "2026-10-29T11:25:44.497Z", originalDayConfirmed: true, stems: 20 }]);
    expect(report.daily).toMatchObject([{ day: "2026-10-28", stems: 20 }]);
  });

  it("does not treat an unnumbered photo as a report or a hint for a later bare count", () => {
    const at = "2026-10-18T10:00:00.000Z";
    const report = buildOrchidStemReport([
      { msgId: "photo", senderId: "worker", senderName: "Lộc", text: "Chị Lan",
        contentType: "photo", sentAt: at },
      { msgId: "bare", senderId: "worker", senderName: "Lộc", text: "8c",
        sentAt: "2026-10-18T10:01:00.000Z" },
    ]);
    expect(report.entries).toEqual([]);
    expect(report.monthly).toEqual([]);
    expect(report.daily).toEqual([]);
    expect(report.review.map(x => x.msgId)).toEqual(["bare"]);
  });

  it("uses a quote after the requested period for a photo inside it", () => {
    const report = buildOrchidStemReport([
      { msgId: "photo", senderId: "worker", senderName: "Lộc", text: "", contentType: "photo",
        sentAt: "2026-10-31T12:00:00.000Z", inRange: true },
      { msgId: "quote", senderId: "worker", senderName: "Lộc", text: "8 cành", quotedMsgId: "photo",
        quoteOwnerId: "worker", sentAt: "2026-11-01T03:00:00.000Z", inRange: false },
    ]);
    expect(report.daily).toMatchObject([{ day: "2026-10-31", stems: 8 }]);
  });

  it("refreshes the original photo's saved month for a quote in a later month", () => {
    expect(orchidStemRefreshMonths("2026-11-15T03:00:00.000Z", {
      contentType: "photo", text: "", sentAt: "2026-10-10T03:00:00.000Z",
    })).toEqual(["2026-11", "2026-10"]);
    expect(orchidStemRefreshMonths("2026-10-15T03:00:00.000Z", {
      contentType: "photo", text: "", sentAt: "2026-10-10T03:00:00.000Z",
    })).toEqual(["2026-10"]);
  });

  it("uses the existing Hot 6 display name for quoted photo totals", () => {
    const at = "2026-10-18T10:00:00.000Z";
    const report = buildOrchidStemReport([
      { msgId: "photo", senderId: "six", senderName: "Lan Hồ Điệp Orchids World S", text: "", contentType: "photo", sentAt: at },
      { msgId: "quote", senderId: "six", senderName: "Lan Hồ Điệp Orchids World S", text: "8c", quotedMsgId: "photo",
        quoteOwnerId: "six", sentAt: at },
      { msgId: "named", senderId: "six", senderName: "Lan Hồ Điệp Orchids World S", text: "Khách Hoa 5c", sentAt: at },
    ]);
    expect(report.monthly).toMatchObject([{ senderName: "Lan Hồ Điệp Orchids World VI", stems: 13, jobs: 2 }]);
  });

  it("credits a colleague's quoted count to the photo sender on the photo day", () => {
    const report = buildOrchidStemReport([
      { msgId: "photo", senderId: "worker", senderName: "Duy Khánh", text: "", contentType: "photo",
        sentAt: "2026-10-10T03:00:00.000Z" },
      { msgId: "quote", senderId: "colleague", senderName: "Lộc Nguyễn", text: "@Duy Khánh 5c",
        quotedMsgId: "photo", quoteOwnerId: "worker", sentAt: "2026-10-15T03:00:00.000Z" },
    ]);
    expect(report.entries).toMatchObject([{ msgId: "quote", quotedPhotoMsgId: "photo",
      senderId: "worker", senderName: "Duy Khánh", stems: 5, day: "2026-10-10" }]);
    expect(report.monthly).toMatchObject([{ senderName: "Duy Khánh", stems: 5, jobs: 1 }]);
  });

  it("credits a colleague's Hot 6 mention without adding it to the colleague's total", () => {
    const report = buildOrchidStemReport([
      { msgId: "photo", senderId: "six", senderName: "Lan Hồ Điệp Orchids World S", text: "",
        contentType: "photo", sentAt: "2026-10-21T02:30:00.000Z" },
      { msgId: "quote", senderId: "loc", senderName: "Lộc Nguyễn",
        text: "@Lan Hồ Điệp Orchids World S 8cây", quotedMsgId: "photo", quoteOwnerId: "six",
        sentAt: "2026-10-29T11:28:00.000Z" },
    ]);
    expect(report.monthly).toMatchObject([{ senderName: "Lan Hồ Điệp Orchids World VI", stems: 8, jobs: 1 }]);
    expect(report.daily).toMatchObject([{ day: "2026-10-21", senderName: "Lan Hồ Điệp Orchids World VI", stems: 8 }]);
  });

  it("does not credit a mismatched photo owner or count an already numbered photo twice", () => {
    const at = "2026-10-18T10:00:00.000Z";
    const report = buildOrchidStemReport([
      { msgId: "blank", senderId: "worker", senderName: "Lộc", text: "", contentType: "photo", sentAt: at },
      { msgId: "other", senderId: "boss", senderName: "Anh Nam", text: "8c", quotedMsgId: "blank",
        quoteOwnerId: "someone-else", sentAt: at },
      { msgId: "numbered", senderId: "worker", senderName: "Lộc", text: "Khách Hoa 5c", contentType: "photo", sentAt: at },
      { msgId: "again", senderId: "worker", senderName: "Lộc", text: "5c", quotedMsgId: "numbered",
        quoteOwnerId: "worker", sentAt: at },
    ]);
    expect(report.monthly).toMatchObject([{ senderId: "worker", stems: 5, jobs: 1 }]);
    expect(report.review.map(x => x.msgId)).toContain("other");
  });

  it("uses the photo owner instead of a nearby name from the colleague who quotes it", () => {
    const at = "2026-10-18T10:00:00.000Z";
    const report = buildOrchidStemReport([
      { msgId: "photo", senderId: "worker", senderName: "Lộc", text: "", contentType: "photo", sentAt: at },
      { msgId: "name", senderId: "boss", senderName: "Anh Nam", text: "Khách Hoa", sentAt: at },
      { msgId: "quote", senderId: "boss", senderName: "Anh Nam", text: "8c", quotedMsgId: "photo",
        quoteOwnerId: "worker", sentAt: "2026-10-18T10:01:00.000Z" },
    ]);
    expect(report.entries).toMatchObject([{ msgId: "quote", senderId: "worker",
      customerName: "Ảnh báo cáo", stems: 8 }]);
  });

  it("holds conflicting quotes of the same photo for review", () => {
    const at = "2026-10-18T10:00:00.000Z";
    const report = buildOrchidStemReport([
      { msgId: "photo", senderId: "worker", senderName: "Lộc", text: "", contentType: "photo", sentAt: at },
      { msgId: "first", senderId: "worker", senderName: "Lộc", text: "8c", quotedMsgId: "photo", quoteOwnerId: "worker", sentAt: at },
      { msgId: "second", senderId: "worker", senderName: "Lộc", text: "9c", quotedMsgId: "photo", quoteOwnerId: "worker", sentAt: at },
    ]);
    expect(report.entries).toEqual([]);
    expect(report.review.map(x => x.msgId)).toEqual(["first", "second"]);
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
    const selected = filterOrchidStemReport(addOrchidWorkPlanCounts(report, []), "Văn Hoàng");
    expect(selected.entries.map(x => x.msgId)).toEqual(["a"]);
    expect(selected.monthly.map(x => x.stems)).toEqual([6]);
    expect(selected.daily.map(x => x.stems)).toEqual([6]);
    expect(selected.review.map(x => x.msgId)).toEqual(["c"]);
  });

  it("keeps the date patterns intact in the browser script", () => {
    // ui.ts is a template literal: a single backslash would disappear before the browser sees it.
    expect(INDEX_HTML).toContain("/^\\d{4}-\\d{2}-\\d{2}$/");
    expect(INDEX_HTML).toContain("/^20\\d{2}-(0[1-9]|1[0-2])$/");
  });
});
