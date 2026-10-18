import { describe, expect, it, vi } from "vitest";
import type { InboxMessageRow } from "@penai/db";
import type { Provider } from "@penai/providers";
import { classifyIncreasedInvoiceRequest, increasedInvoiceAccountingNotice,
  mayRequestIncreasedInvoice, MISA_INCREASE_CUSTOMER_REPLY,
  parseIncreasedInvoiceRequest } from "../src/misa-increase-request.js";

const row = (direction: "in" | "out", source: string, text: string) =>
  ({ direction, source, text, sentAt: new Date().toISOString() }) as InboxMessageRow;

describe("increased MISA invoice requests", () => {
  const sale = "Tổng 2.130.000đ: 10 cành 2.000.000đ, ship 130.000đ.";
  const request = "Xuất cho e 3,5 tr nha";
  const history = [row("out", "agent", sale), row("in", "zalo", request)];
  it("requires a real agreed sale and the latest customer's higher-invoice request", () => {
    expect(mayRequestIncreasedInvoice(request, history)).toBe(true);
    expect(mayRequestIncreasedInvoice("Cho chị xuất tăng hóa đơn nhé", history)).toBe(true);
    expect(mayRequestIncreasedInvoice("Vậy xuất đúng số này đi", history)).toBe(false);
    expect(parseIncreasedInvoiceRequest(JSON.stringify({ increased: true, customerText: request,
      actualEvidenceText: sale, requestEvidenceText: request }), request, history)).toBe(true);
    const lower = "Xuất hóa đơn 2 tr thôi";
    expect(parseIncreasedInvoiceRequest(JSON.stringify({ increased: true, customerText: lower,
      actualEvidenceText: sale, requestEvidenceText: lower }), lower,
      [row("out", "agent", sale), row("in", "zalo", lower)])).toBe(false);
    expect(parseIncreasedInvoiceRequest(JSON.stringify({ increased: true, customerText: request,
      actualEvidenceText: "Anh không thể xuất hóa đơn 3,5 triệu", requestEvidenceText: request }),
      request, [...history, row("out", "agent", "Anh không thể xuất hóa đơn 3,5 triệu")])).toBe(false);
    expect(parseIncreasedInvoiceRequest(JSON.stringify({ increased: true, customerText: "Tin khác",
      actualEvidenceText: sale, requestEvidenceText: request }), request, history)).toBe(false);
    expect(parseIncreasedInvoiceRequest(JSON.stringify({ increased: true, customerText: request,
      actualEvidenceText: sale, requestEvidenceText: request }), request,
      [row("out", "agent", sale), row("in", "zalo", "/new"), row("in", "zalo", request)])).toBe(false);
  });
  it("also recognizes approval of a staff-proposed increase", () => {
    const staff = "A xhd nháp cho e 3.510.000 với số cành là 18 nhé";
    const approval = "Ok a, xuất đi anh";
    const messages = [row("out", "agent", sale), row("out", "app", staff), row("in", "zalo", approval)];
    expect(mayRequestIncreasedInvoice(approval, messages)).toBe(true);
    expect(parseIncreasedInvoiceRequest(JSON.stringify({ increased: true, customerText: approval,
      actualEvidenceText: sale, requestEvidenceText: staff }), approval, messages)).toBe(true);
  });
  it("asks the model once and keeps the customer and group messages short", async () => {
    const provider = { chat: vi.fn().mockResolvedValue({ stopReason: "end", toolCalls: [],
      content: JSON.stringify({ increased: true, customerText: request,
        actualEvidenceText: sale, requestEvidenceText: request }) }) } as unknown as Provider;
    expect(await classifyIncreasedInvoiceRequest(provider, "model", history, request)).toBe(true);
    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(MISA_INCREASE_CUSTOMER_REPLY).toBe("để em nhờ kế toán kiểm tra cái này cho chị");
    expect(increasedInvoiceAccountingNotice("Hot 6", "NV Bán Hàng Hot 1"))
      .toBe("Khách hàng Hot 6 — nguồn NV Bán Hàng Hot 1 — yêu cầu xuất hóa đơn tăng lên.");
  });
});
