import { afterEach, describe, expect, it, vi } from "vitest";
import type { InboxMessageRow } from "@penai/db";
import { createMisaUnpublishedInvoice, verifyMisaWebConnection } from "../src/misa-api.js";
import { hasExplicitVatApproval, invoiceRequestFingerprint, parseInvoiceEvidence } from "../src/misa-invoice-extract.js";

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
      const refId = new URL(url).searchParams.get("id");
      return new Response(JSON.stringify({ data: { RefID: refId, PublishStatus: 0 } }));
    });
    globalThis.fetch = calls as typeof fetch;
    const saved = await createMisaUnpublishedInvoice(login, {
      buyerName: "Công ty A", buyerTaxCode: "0311111111", buyerAddress: "TP HCM",
      buyerEmail: "buyer@example.com", buyerContact: "Anh A", itemName: "Chậu lan hồ điệp 5 cành",
      quantity: 1, unitPrice: 1_000_000, vatRate: 10, series: "1C26TGP",
    });
    expect(saved.refId).toMatch(/^[0-9a-f-]{36}$/);
    const insert = calls.mock.calls.find((call) => String(call[0]).endsWith("/SAInvoice/Insert"))!;
    const body = JSON.parse(String(insert[1]?.body));
    expect(JSON.parse(body.data).PublishStatus).toBe(0);
    expect(JSON.parse(body.data).InvNo).toBe("<Chưa cấp số>");
    expect(calls.mock.calls.map((call) => String(call[0])).join(" ")).not.toMatch(/publishinvoice|signinvoice/i);
  });

  it("requires explicit buyer and agreed amount", () => {
    expect(parseInvoiceEvidence(JSON.stringify({ buyerName: "Công ty A", buyerTaxCode: "0311111111",
      buyerAddress: "TP HCM", buyerEmail: "buyer@example.com", itemName: "Chậu lan", totalPrice: 1_000_000 })))
      .toMatchObject({ totalPrice: 1_000_000 });
    expect(parseInvoiceEvidence(JSON.stringify({ buyerName: "Công ty A", buyerTaxCode: "",
      buyerAddress: "TP HCM", buyerEmail: "buyer@example.com", itemName: "Chậu lan", totalPrice: 1_000_000 })))
      .toBeNull();
  });

  it("requires a human VAT 5% quote followed by customer approval", () => {
    const row = (direction: "in" | "out", source: string, text: string) =>
      ({ direction, source, text }) as InboxMessageRow;
    const evidence = parseInvoiceEvidence(JSON.stringify({ buyerName: "Công ty A", buyerTaxCode: "0311111111",
      buyerAddress: "TP HCM", buyerEmail: "buyer@example.com", itemName: "Chậu lan", totalPrice: 1_000_000,
      vatQuoteText: "Giá 1 triệu chưa VAT, VAT 5% là 50 nghìn", vatAcceptanceText: "Ok, xuất giúp chị" }))!;
    const messages = [row("out", "web", evidence.vatQuoteText), row("in", "zalo", evidence.vatAcceptanceText)];
    expect(hasExplicitVatApproval(messages, evidence, 5)).toBe(true);
    expect(hasExplicitVatApproval(messages, evidence, 10)).toBe(false);
    expect(hasExplicitVatApproval([...messages].reverse(), evidence, 5)).toBe(false);
    expect(hasExplicitVatApproval([row("out", "agent", evidence.vatQuoteText), messages[1]!], evidence, 5)).toBe(false);
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
  });
});
