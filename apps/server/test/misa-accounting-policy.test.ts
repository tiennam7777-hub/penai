import { describe, expect, it } from "vitest";
import type { InboxMessageRow } from "@penai/db";
import { missingOldInvoiceDetailsRequest, taxCodeFromAccountingReply,
  misaAccountingNotice } from "../src/misa-accounting-policy.js";

const row = (id: string, direction: "in" | "out", text: string) =>
  ({ id, direction, text }) as InboxMessageRow;

describe("MISA accounting group policy", () => {
  it("reports only a refusal after a request for old invoice details", () => {
    const request = row("101", "in", "Xuất hóa đơn, thông tin XHD như cũ");
    const ask = row("102", "out", "Chị gửi lại mã số thuế để em kiểm tra nhé");
    const refuse = row("103", "in", "Chị không có, lấy thông tin cũ đi");
    expect(missingOldInvoiceDetailsRequest([request, ask, refuse])).toBe("101");
    expect(missingOldInvoiceDetailsRequest([request, refuse])).toBeNull();
    expect(missingOldInvoiceDetailsRequest([request, ask, row("104", "in", "MST 0312767097")])).toBeNull();
    expect(missingOldInvoiceDetailsRequest([request, row("105", "in", "/new"), ask, refuse])).toBeNull();
  });
  it("requires a tax code in the accounting reply", () => {
    expect(taxCodeFromAccountingReply("MST 0312767097, email a@b.vn"))
      .toEqual({ taxCode: "0312767097", email: "a@b.vn" });
    expect(taxCodeFromAccountingReply("Thông tin cũ nhé")).toBeNull();
    expect(taxCodeFromAccountingReply("Số điện thoại 0938699916")).toBeNull();
  });
  it("formats concise status notices", () => {
    expect(misaAccountingNotice("draft_saved", "Công ty A", "Hot 1")).toContain("chưa phát hành");
    expect(misaAccountingNotice("issued", "Công ty A", "Hot 1", "00000123")).toContain("00000123");
  });
});
