import { describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import { buildOrchidQualityReport, orchidQualityWorkbook, parseOrchidQuality } from "../src/orchid-quality-report.js";
const message = (text: string, msgId = "1", extra = {}) => ({ text, msgId, senderName: "Văn Hoàng",
  senderId: "person", sentAt: "2026-11-07T06:32:50.504Z", ...extra });

describe("Đi hoa xấu - cây 2 nhánh", () => {
  it("lọc chính xác nhân viên, giữ danh sách đầy đủ và cộng tổng theo người", () => {
    const messages = [message("3 cây 2v, 2 cây xấu (chậu 35c c Nhi)"),
      message("4 cây xấu (chậu 9c Kim Chi)", "2"),
      message("2c 2v chậu 6c a Thông", "3", { senderName: "Trung Toàn" }),
      message("1c", "4", { senderName: "Trung Toàn" })];
    const all = buildOrchidQualityReport(messages, "2026-11-01", "2026-11-30");
    expect(all.monthly).toEqual([
      { senderName: "Văn Hoàng", total: 9, bad: 6, twoBranch: 3, unknown: 0, reports: 2, review: 0 },
      { senderName: "Trung Toàn", total: 3, bad: 0, twoBranch: 2, unknown: 1, reports: 2, review: 1 },
    ]);
    const filtered = buildOrchidQualityReport(messages, "2026-11-01", "2026-11-30", "", "Văn Hoàng");
    expect(filtered.senders).toHaveLength(2);
    expect(filtered.entries).toHaveLength(2);
    expect(filtered.totals).toMatchObject({ total: 9, bad: 6, twoBranch: 3 });
    expect(filtered.monthly).toHaveLength(1);
    const search = buildOrchidQualityReport(messages, "2026-11-01", "2026-11-30", "nhi", "Văn Hoàng");
    expect(search.totals).toMatchObject({ total: 5, bad: 2, twoBranch: 3 });
    expect(buildOrchidQualityReport(messages, "2026-11-01", "2026-11-30", "", "Không có").entries).toHaveLength(0);
    const zip = new AdmZip(orchidQualityWorkbook(filtered, "2026-11"));
    expect(zip.readAsText("xl/workbook.xml")).toContain("Theo nhân viên");
    expect(zip.readAsText("xl/worksheets/sheet3.xml")).toContain("Văn Hoàng");
    expect(zip.readAsText("xl/worksheets/sheet3.xml")).not.toContain("Trung Toàn");
  });
  it.each([
    ["3 cây 2v, 2 cây xấu (chậu 35c c nhi)", 5, 2, 3, 0, 35],
    ["5c( 2c 2v , 3c het nu)", 5, 3, 2, 0, null],
    ["3c ( 1c(2v) , 2c ( chay nu) )", 3, 2, 1, 0, null],
    ["1 cây 2v (c trang 9c)", 1, 0, 1, 0, 9],
    ["1 xấu, 1 cây 2v (chậu 12c hà icd)", 2, 1, 1, 0, 12],
    ["1 cây 2v, 1 xấu (chậu 15c cong tam)", 2, 1, 1, 0, 15],
    ["8 cây ( việt sinh phát)", 8, 0, 0, 8, null],
    ["1 c( het nu)", 1, 1, 0, 0, null],
    ["Chậu 10 cành hoa tốt 2", null, 0, 0, 0, 10],
    ["1 chậu 10 nancy", null, 0, 0, 0, 10],
    ["4c (2v)", 4, 0, 4, 0, null],
    ["shop siin 5 cây 2 vòi (Sơn)", 5, 0, 5, 0, null],
    ["1c 2v a dũng", 1, 0, 1, 0, null],
    ["5c(2c 2v, 2c hết nụ)", null, 0, 0, 0, null],
  ])("tách số cây và cành chậu: %s", (text, total, bad, twoBranch, unknown, potStems) => {
    expect(parseOrchidQuality(text as string)).toMatchObject({ total, bad, twoBranch, unknown, potStems });
  });
  it("tìm không dấu theo khách và số cành, tổng chỉ tính các hàng tìm được", () => {
    const report = buildOrchidQualityReport([message("3 cây 2v, 2 cây xấu (chậu 35c c Nhi)"),
      message("1c 2v chậu 6c a Thông", "2")], "2026-11-01", "2026-11-30", "nhi");
    expect(report.entries).toHaveLength(1);
    expect(report.totals).toMatchObject({ total: 5, bad: 2, twoBranch: 3 });
    expect(buildOrchidQualityReport([message("1c 2v chậu 6c a Thông")], "2026-11-01", "2026-11-30", "thong").entries).toHaveLength(1);
  });
  it("không đếm trùng msgId, không suy từ ảnh, tính ngày Việt Nam", () => {
    const m = message("2 cây 2 vòi");
    const report = buildOrchidQualityReport([m, m, message("", "photo", { contentType: "photo" }),
      message("1c", "next", { sentAt: "2026-11-30T18:00:00Z" })], "2026-11-01", "2026-11-30");
    expect(report.totals.total).toBe(2);
    expect(report.uncaptionedMedia).toBe(1);
  });
  it("sửa bằng trích dẫn thay số gốc và giữ khách, ngày gốc", () => {
    const report = buildOrchidQualityReport([message("2c 2v chậu 6c a Thông"),
      message("Sửa 3c 2v", "2", { quotedMsgId: "1", sentAt: "2026-12-01T01:00:00Z" })], "2026-11-01", "2026-11-30");
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({ total: 3, customerName: "chậu 6c a Thông", potStems: 6 });
  });
  it("Excel giữ một cột nhân viên, tin gốc và bộ lọc", () => {
    const report = buildOrchidQualityReport([message("3 cây 2v, 2 cây xấu (chậu 35c c nhi)")], "2026-11-01", "2026-11-30");
    const zip = new AdmZip(orchidQualityWorkbook(report, "2026-11", "nhi"));
    expect(zip.readAsText("xl/worksheets/sheet2.xml")).toContain("Nhân viên");
    expect(zip.readAsText("xl/worksheets/sheet2.xml")).toContain("35c c nhi");
    expect(zip.readAsText("xl/worksheets/sheet1.xml")).toContain("nhi");
  });
});
