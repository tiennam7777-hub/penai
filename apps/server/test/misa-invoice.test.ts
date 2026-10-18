import { afterEach, describe, expect, it, vi } from "vitest";
import type { InboxMessageRow } from "@penai/db";
import { createMisaUnpublishedInvoice, lookupMisaBuyerCompany,
  previewMisaUnpublishedInvoice, verifyMisaWebConnection } from "../src/misa-api.js";
import { hasConfirmedBuyerCompany, hasExplicitVatApproval, invoiceRequestFingerprint,
  customerInvoiceTaxCode, hasRecentCustomerInvoiceRequest, isInvoiceConfirmation,
  parseInvoiceEvidence, staffInvoiceFingerprint } from "../src/misa-invoice-extract.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("MISA invoice draft", () => {
  const login = { taxCode: "0312767097", username: "account@example.com", password: "secret-pass" };
  it("verifies the OAuth company identity before saving credentials", async () => {
    const calls = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "a".repeat(30), TaxCode: login.taxCode, CompanyID: 9480 }), { status: 200 }));
    globalThis.fetch = calls;
    await verifyMisaWebConnection(login);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(String(calls.mock.calls[0]![0])).toContain("/v2/oauth");
    calls.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "a".repeat(30), TaxCode: "0311111111", CompanyID: 9480 }), { status: 200 }));
    await expect(verifyMisaWebConnection(login)).rejects.toThrow("Mã số thuế");
  });

  it("only inserts an unpublished invoice and confirms its saved state", async () => {
    const calls = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v2/oauth")) return new Response(JSON.stringify({ access_token: "a".repeat(30), TaxCode: login.taxCode, CompanyID: 9480 }));
      if (url.endsWith("/SAInvoice/Insert")) return new Response(JSON.stringify({ success: true }));
      const refId = url.split("/").at(-1);
      return new Response(JSON.stringify({ data: { RefID: refId, PublishStatus: 0 } }));
    });
    globalThis.fetch = calls as typeof fetch;
    const saved = await createMisaUnpublishedInvoice(login, {
      buyerName: "Công ty A", buyerTaxCode: "0311111111", buyerAddress: "TP HCM",
      buyerEmail: "buyer@example.com", buyerContact: "", itemName: "Hoa Lan Hồ Điệp",
      itemCode: "HH00001", unitName: "Cây",
      quantity: 1, unitPrice: 1_000_000, vatRate: 10, series: "1C26TGP",
    });
    expect(saved.refId).toMatch(/^[0-9a-f-]{36}$/);
    const insert = calls.mock.calls.find((call) => String(call[0]).endsWith("/SAInvoice/Insert"))!;
    const body = JSON.parse(String(insert[1]?.body));
    expect(JSON.parse(body.data).PublishStatus).toBe(0);
    expect(JSON.parse(body.data).InvNo).toBe("<Chưa cấp số>");
    expect(JSON.parse(body.data).ReceiverName).toBe("");
    expect(JSON.parse(body.detail)[0].InventoryItemCode).toBe("HH00001");
    expect(JSON.parse(body.detail)[0].UnitName).toBe("Cây");
    expect(calls.mock.calls.map((call) => String(call[0])).join(" ")).not.toMatch(/publishinvoice|signinvoice/i);
  });

  const sample = { buyerName: "Công ty A", buyerTaxCode: "0311111111", buyerAddress: "TP HCM",
    buyerEmail: "buyer@example.com", buyerContact: "", kind: "standard", actualStemCount: 5,
    flowerAmount: 1_000_000, shippingFee: 0, tallPotFee: 0, requestedInvoicePreTax: 1_000_000,
    companyQuestionText: "Đúng Công ty A không ạ?", companyAcceptanceText: "Đúng rồi",
    vatQuoteText: "Giá 1 triệu chưa VAT, VAT 5% là 50 nghìn", vatAcceptanceText: "Ok, xuất giúp chị" };

  it("requires actual stems, prices and buyer tax code", () => {
    expect(parseInvoiceEvidence(JSON.stringify(sample))).toMatchObject({ actualStemCount: 5 });
    expect(parseInvoiceEvidence(JSON.stringify({ ...sample, buyerTaxCode: "" }))).toBeNull();
    expect(parseInvoiceEvidence(JSON.stringify({ ...sample, actualStemCount: 0 }))).toBeNull();
  });

  it("requires a human VAT 5% quote followed by customer approval", () => {
    const row = (direction: "in" | "out", source: string, text: string) =>
      ({ direction, source, text }) as InboxMessageRow;
    const evidence = parseInvoiceEvidence(JSON.stringify(sample))!;
    const messages = [row("out", "web", evidence.vatQuoteText), row("in", "zalo", evidence.vatAcceptanceText)];
    expect(hasExplicitVatApproval(messages, evidence, 5)).toBe(true);
    expect(hasExplicitVatApproval(messages, evidence, 10)).toBe(false);
    expect(hasExplicitVatApproval([...messages].reverse(), evidence, 5)).toBe(false);
    expect(hasExplicitVatApproval([row("out", "agent", evidence.vatQuoteText), messages[1]!], evidence, 5)).toBe(true);
    expect(hasConfirmedBuyerCompany([row("out", "agent", "Đúng Công ty A không ạ?"),
      row("in", "zalo", "Đúng rồi")], evidence, "Công ty A")).toBe(true);
    expect(hasConfirmedBuyerCompany([row("out", "agent", "Đúng Công ty khác không ạ?"),
      row("in", "zalo", "Đúng rồi")], evidence, "Công ty A")).toBe(false);
  });

  it("reads the full registered company name from MISA nested data", async () => {
    const calls = vi.fn(async (url: string) => url.endsWith("/v2/oauth")
      ? new Response(JSON.stringify({ access_token: "a".repeat(30), TaxCode: login.taxCode, CompanyID: 9480 }))
      : new Response(JSON.stringify({ success: true, data: JSON.stringify({ Success: true,
        Data: JSON.stringify({ companyName: "Công ty trách nhiệm hữu hạn Hoa Lan Hồ Điệp Rất Dài",
          address: "42 Điện Biên Phủ" }) }) })));
    globalThis.fetch = calls as typeof fetch;
    expect(await lookupMisaBuyerCompany(login, "0311111111")).toMatchObject({ address: "42 Điện Biên Phủ" });
  });

  it("accepts only a PDF preview from MISA", async () => {
    const bytes = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(150)]);
    globalThis.fetch = vi.fn(async (url: string) => url.endsWith("/v2/oauth")
      ? new Response(JSON.stringify({ access_token: "a".repeat(30), TaxCode: login.taxCode, CompanyID: 9480 }))
      : new Response(bytes, { headers: { "content-type": "application/pdf" } })) as typeof fetch;
    expect(await previewMisaUnpublishedInvoice(login, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toEqual(bytes);
    globalThis.fetch = vi.fn(async (url: string) => url.endsWith("/v2/oauth")
      ? new Response(JSON.stringify({ access_token: "a".repeat(30), TaxCode: login.taxCode, CompanyID: 9480 }))
      : new Response("<html>not a PDF</html>")) as typeof fetch;
    await expect(previewMisaUnpublishedInvoice(login, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"))
      .rejects.toThrow("PDF");
  });

  it("uses one customer request as the duplicate guard", () => {
    const row = (id: string, direction: "in" | "out", text: string) => ({ id, direction, text,
      sentAt: new Date(), source: "zalo" }) as unknown as InboxMessageRow;
    const messages = [row("req-1", "in", "xuất hóa đơn thông tin như cũ"), row("cmd", "out", "-xhd")];
    expect(invoiceRequestFingerprint(messages)).toBe(invoiceRequestFingerprint([...messages, row("cmd-2", "out", "-xhd")]));
    expect(invoiceRequestFingerprint([...messages, row("req-2", "in", "xuất hóa đơn đơn mới")]))
      .not.toBe(invoiceRequestFingerprint(messages));
    expect(invoiceRequestFingerprint([row("no", "in", "không lấy hóa đơn đâu")])).toBeNull();
    expect(invoiceRequestFingerprint([row("old", "in", "thông tin XHD như cũ nhé")])).not.toBeNull();
    expect(staffInvoiceFingerprint(parseInvoiceEvidence(JSON.stringify(sample))!)).toBe(
      staffInvoiceFingerprint(parseInvoiceEvidence(JSON.stringify(sample))!));
    expect(hasRecentCustomerInvoiceRequest([row("req-1", "in", "Xhd cho a"), row("yes", "in", "Ok")])).toBe(true);
    expect(hasRecentCustomerInvoiceRequest([row("req-1", "in", "Xhd cho a"), row("reset", "in", "/new")])).toBe(false);
    expect(isInvoiceConfirmation("Ok")).toBe(true);
    expect(isInvoiceConfirmation("Ok nhưng đổi công ty")).toBe(false);
    expect(customerInvoiceTaxCode("Công ty A, MST: 0312767097")).toBe("0312767097");
    expect(customerInvoiceTaxCode("Gọi 0938699916 nhé")).toBeNull();
  });
});
