import { randomUUID } from "node:crypto";

/** MISA's documented web API stores an unpublished SAInvoice. Never call publish/sign endpoints. */
const BASE = "https://app.meinvoice.vn/api";

export interface MisaLogin {
  taxCode: string;
  username: string;
  password: string;
}

export interface MisaDraftInput {
  buyerName: string;
  buyerTaxCode: string;
  buyerAddress: string;
  buyerEmail: string;
  buyerContact: string;
  itemName: string;
  itemCode: string;
  unitName: string;
  quantity: number;
  unitPrice: number;
  amountBeforeVat: number;
  vatRate: number;
  series: string;
}

/** MISA returns the registered legal name without the UI's visual truncation. */
export async function lookupMisaBuyerCompany(login: MisaLogin, buyerTaxCode: string): Promise<{
  name: string; address: string;
}> {
  if (!/^\d{10}(?:-\d{3})?$/.test(buyerTaxCode)) throw new Error("Mã số thuế người mua không hợp lệ");
  const { token } = await misaWebToken(login);
  const response = await fetch(`${BASE}/v2/Other/GetCompanyInfoByTaxCodeV3?taxCode=${encodeURIComponent(buyerTaxCode)}`, {
    headers: { Authorization: `Bearer ${token}`, TaxCode: login.taxCode },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await readPayload(response);
  const outer = payloadObject(body.data);
  const company = payloadObject(outer.Data ?? outer.data);
  const name = String(company.companyName ?? company.CompanyName ?? "").trim();
  const address = String(company.address ?? company.Address ?? "").trim();
  if (!response.ok || body.success !== true || outer.Success === false || !name || !address) {
    throw new Error("MISA chưa tra được đầy đủ tên và địa chỉ công ty theo mã số thuế; chưa lập nháp");
  }
  return { name, address };
}

function payloadObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { return payloadObject(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

async function readPayload(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text();
  try { return payloadObject(JSON.parse(raw)); } catch { return {}; }
}

export async function misaWebToken(login: MisaLogin, signal = AbortSignal.timeout(15_000)):
  Promise<{ token: string; companyId: number }> {
  const response = await fetch(`${BASE}/v2/oauth`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", TaxCode: login.taxCode },
    body: new URLSearchParams({ grant_type: "password", username: login.username, password: login.password }),
    signal,
  });
  const body = await readPayload(response);
  const token = body.access_token ?? payloadObject(body.data).access_token;
  if (!response.ok || typeof token !== "string" || token.length < 20) {
    throw new Error("MISA chưa xác thực được API web cho tài khoản này. Kiểm tra quyền tích hợp hoặc liên hệ MISA.");
  }
  const returnedTaxCode = body.TaxCode ?? body.taxCode ?? payloadObject(body.data).TaxCode;
  if (String(returnedTaxCode ?? "").trim() !== login.taxCode) {
    throw new Error("Mã số thuế MISA trả về không khớp tài khoản cần kết nối");
  }
  const companyId = Number(body.CompanyID ?? body.companyID ?? body.companyId);
  if (!Number.isSafeInteger(companyId) || companyId < 1) {
    throw new Error("MISA không trả mã công ty cho tài khoản API này");
  }
  return { token, companyId };
}

export async function verifyMisaWebConnection(login: MisaLogin): Promise<void> {
  // OAuth itself returns the authenticated company's TaxCode and CompanyID.
  // getcurent is an optional legacy endpoint and can fail for valid accounts.
  await misaWebToken(login, AbortSignal.timeout(20_000));
}

/** Admin-only, read-only diagnostics for a RefID already recorded by PenAI. */
export async function inspectMisaInvoiceReadback(login: MisaLogin, refId: string): Promise<Record<string, unknown>> {
  if (!/^[0-9a-f-]{36}$/i.test(refId)) throw new Error("Mã hóa đơn MISA không hợp lệ");
  const { token } = await misaWebToken(login);
  const output: Record<string, unknown> = {};
  for (const [variant, path] of [["legacy", "SAInvoice/Get"], ["v3", "code/v3sainvoice"]]) {
    const response = await fetch(`${BASE}/v2/${path}/${encodeURIComponent(refId)}`, {
      headers: { Authorization: `Bearer ${token}`, TaxCode: login.taxCode },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await readPayload(response);
    const data = payloadObject(body.data ?? body.Data);
    const nested = payloadObject(data.master ?? data.Master ?? data.invoice ?? data.Invoice);
    const details = Array.isArray(data.InvoiceDetails) ? data.InvoiceDetails : [];
    output[variant!] = {
      httpStatus: response.status, success: body.success, topKeys: Object.keys(body).slice(0, 30),
      dataKind: Array.isArray(body.data) ? "array" : typeof body.data,
      dataKeys: Object.keys(data).slice(0, 30), nestedKeys: Object.keys(nested).slice(0, 30),
      refId: nested.RefID ?? data.RefID ?? null,
      publishStatus: nested.PublishStatus ?? data.PublishStatus ?? null,
      errorCode: body.errorCode ?? body.ErrorCode ?? null,
      error: String(body.error ?? "").slice(0, 300),
      content: String(body.content ?? "").slice(0, 300),
      invoiceType: data.InvoiceType ?? null, sourceType: data.SourceType ?? null,
      templateNo: data.InvTemplateNo ?? null, templateId: data.InvoiceTemplateID ?? null,
      detailsCount: details.length,
      detailKeys: Object.keys(payloadObject(details[0])).slice(0, 50),
    };
  }
  const templateResponse = await fetch(`${BASE}/v2/code/v3common/template`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, TaxCode: login.taxCode, "Content-Type": "application/json" },
    body: JSON.stringify({ TypeInvoice: 1, TaxCode: login.taxCode,
      UserName: login.username, Password: login.password }),
    signal: AbortSignal.timeout(15_000),
  });
  const templateBody = await readPayload(templateResponse);
  let templateData: unknown = templateBody.data;
  if (typeof templateData === "string") {
    try { templateData = JSON.parse(templateData); } catch { templateData = null; }
  }
  const list = Array.isArray(templateData) ? templateData :
    (Array.isArray(payloadObject(templateData).Data) ? payloadObject(templateData).Data as unknown[] : []);
  output.templateList = {
    httpStatus: templateResponse.status, success: templateBody.success,
    errorCode: templateBody.errorCode ?? null,
    error: String(templateBody.error ?? "").slice(0, 200),
    dataKind: Array.isArray(templateData) ? "array" : typeof templateData,
    dataKeys: Object.keys(payloadObject(templateData)).slice(0, 30),
    count: list.length,
    samples: list.slice(0, 5).map((item) => {
      const t = payloadObject(item);
      return { keys: Object.keys(t).slice(0, 30), series: t.InvSeries ?? t.invSeries ?? null,
        templateNo: t.InvTemplateNo ?? null, templateId: t.InvoiceTemplateID ?? null };
    }),
  };
  const previewResponse = await fetch(`${BASE}/v2/v3invoice/code/preview/${encodeURIComponent(refId)}`, {
    headers: { Authorization: `Bearer ${token}`, TaxCode: login.taxCode },
    signal: AbortSignal.timeout(15_000),
  });
  const previewBytes = Buffer.from(await previewResponse.arrayBuffer());
  output.preview = { httpStatus: previewResponse.status,
    contentType: previewResponse.headers.get("content-type"), bytes: previewBytes.length,
    isPdf: previewBytes.subarray(0, 5).toString("ascii") === "%PDF-" };
  return output;
}

/** Fetch the preview only for a saved draft. Reject HTML/JSON errors and oversized files. */
export async function previewMisaUnpublishedInvoice(login: MisaLogin, refId: string): Promise<Buffer> {
  if (!/^[0-9a-f-]{36}$/i.test(refId)) throw new Error("Mã hóa đơn nháp MISA không hợp lệ");
  const { token } = await misaWebToken(login);
  const response = await fetch(`${BASE}/v2/v3invoice/code/preview/${encodeURIComponent(refId)}`, {
    headers: { Authorization: `Bearer ${token}`, TaxCode: login.taxCode },
    signal: AbortSignal.timeout(20_000),
  });
  const length = Number(response.headers.get("content-length") ?? 0);
  if (!response.ok || length > 10 * 1024 * 1024) throw new Error("MISA chưa trả bản xem trước hóa đơn nháp");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 100 || bytes.length > 10 * 1024 * 1024 ||
      bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("MISA chưa trả tệp PDF xem trước hợp lệ");
  }
  return bytes;
}

async function misaV3Template(login: MisaLogin, token: string, series: string): Promise<{
  templateId: string; templateNo: string;
}> {
  const response = await fetch(`${BASE}/v2/code/v3common/template`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, TaxCode: login.taxCode, "Content-Type": "application/json" },
    body: JSON.stringify({ TypeInvoice: 1, TaxCode: login.taxCode,
      UserName: login.username, Password: login.password }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await readPayload(response);
  let data: unknown = body.data;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { data = null; }
  }
  const templates = Array.isArray(data) ? data : [];
  const template = templates.map(payloadObject).find((t) =>
    String(t.InvSeries ?? "") === series && Number(t.InvoiceType) === 1 && t.Inactive !== true);
  const templateId = String(template?.IPTemplateID ?? "");
  const templateNo = String(template?.InvTemplateNo ?? "");
  if (!response.ok || body.success !== true || !/^[0-9a-f-]{36}$/i.test(templateId) || !templateNo) {
    throw new Error(`MISA chưa trả mẫu hóa đơn có mã đang dùng cho ký hiệu ${series}; chưa lập nháp`);
  }
  return { templateId, templateNo };
}

/** Result is accepted only after MISA GET confirms the same RefID remains unpublished. */
export async function createMisaUnpublishedInvoice(login: MisaLogin, input: MisaDraftInput,
  refId = randomUUID()): Promise<{ refId: string }> {
  const signal = AbortSignal.timeout(25_000);
  const { token, companyId } = await misaWebToken(login, signal);
  const template = await misaV3Template(login, token, input.series);
  const detailId = randomUUID();
  const amount = input.amountBeforeVat;
  if (!Number.isSafeInteger(amount) || amount < 1 ||
      Math.round(input.quantity * input.unitPrice) !== amount) {
    throw new Error("Đơn giá và thành tiền hóa đơn không khớp sau làm tròn");
  }
  const vat = Math.round(amount * input.vatRate / 100);
  const total = amount + vat;
  const detail = [{
    RefDetailID: detailId, RefID: refId, InventoryItemCode: input.itemCode,
    InventoryItemName: input.itemName, UnitName: input.unitName,
    Description: input.itemName, InventoryItemType: 0, Quantity: input.quantity,
    UnitPrice: input.unitPrice, AmountOC: amount, Amount: amount,
    DiscountRate: 0, DiscountAmountOC: 0, DiscountAmount: 0,
    VATRate: input.vatRate, VATAmountOC: vat, VATAmount: vat, IsTemp: false,
    IsPromotion: false, SortOrder: 1,
  }];
  const data = {
    RefID: refId, CompanyID: companyId, SourceType: 0,
    InvTemplateNo: template.templateNo, InvoiceTemplateID: template.templateId,
    InvoiceType: 1, EntityState: 1, IsAutoCalculate: false,
    InvoiceDetails: detail.map((line) => ({ ...line, EntityState: 1, CompanyID: companyId })),
    AccountObjectTaxCode: input.buyerTaxCode,
    AccountObjectName: input.buyerName,
    AccountObjectAddress: input.buyerAddress,
    ContactName: input.buyerContact,
    ReceiverName: input.buyerContact,
    ReceiverEmail: input.buyerEmail,
    PaymentMethod: "TM/CK",
    InvSeries: input.series,
    InvNo: "",
    InvDate: new Date().toISOString(),
    VATRate: input.vatRate,
    TotalSaleAmountOC: amount, TotalDiscountAmountOC: 0,
    TotalVATAmountOC: vat, TotalAmountOC: total,
    CurrencyID: "VND", ExchangeRate: 1,
    TotalSaleAmount: amount, TotalDiscountAmount: 0,
    TotalVATAmount: vat, TotalAmount: total, TotalAmountWithVAT: total,
    TotalAmountWithoutVATOC: amount, TotalVATAmountViewOC: vat,
    PublishStatus: 0, CompanyTaxCode: login.taxCode,
  };
  const response = await fetch(`${BASE}/v2/code/v3sainvoice/insertone`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, TaxCode: login.taxCode, "Content-Type": "application/json" },
    body: JSON.stringify(data), signal,
  });
  const body = await readPayload(response);
  const errorCodes = body.errorCode ?? body.ErrorCode;
  if (!response.ok || body.success !== true || body.error ||
      (Array.isArray(errorCodes) ? errorCodes.length > 0 : !!errorCodes)) {
    const code = Array.isArray(errorCodes) ? errorCodes.slice(0, 3).join(",") : String(errorCodes ?? "");
    const reason = String(body.error ?? body.content ?? "").slice(0, 150);
    throw new Error(`MISA từ chối lưu hóa đơn nháp (HTTP ${response.status}, success=${String(body.success)}, mã=${code}, lỗi=${reason})`);
  }
  const read = await fetch(`${BASE}/v2/code/v3sainvoice/${encodeURIComponent(refId)}`, {
    headers: { Authorization: `Bearer ${token}`, TaxCode: login.taxCode }, signal: AbortSignal.timeout(15_000),
  });
  const got = await readPayload(read);
  const invoice = payloadObject(got.data ?? got.Data ?? got);
  if (!read.ok || got.success !== true || String(invoice.RefID ?? "") !== refId ||
      Number(invoice.PublishStatus) !== 0 ||
      Number(invoice.TotalSaleAmountOC) !== amount ||
      Number(invoice.TotalVATAmountOC) !== vat || Number(invoice.TotalAmountOC) !== total) {
    throw new Error("MISA có thể đã nhận hóa đơn nhưng chưa xác minh được trạng thái nháp; không tự gửi lại");
  }
  return { refId };
}
