import type { InboxMessageRow } from "@penai/db";

const fold = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();

/** The latest customer message must be a refusal after an old-details request and an information request. */
export function missingOldInvoiceDetailsRequest(history: InboxMessageRow[]): string | null {
  const currentIndex = history.findLastIndex((message) => message.direction === "in");
  const current = history[currentIndex];
  if (!current || current.direction !== "in" || !current.id) return null;
  const refusal = fold(current.text);
  if (!/(?:khong|ko|chua|dung|lay).{0,35}(?:co|nho|gui|cung cap|thong tin|mst|cu|lai)/.test(refusal) &&
      !/(?:thong tin cu|thong tin nhu cu).{0,30}(?:di|nhe|nha)/.test(refusal)) return null;
  for (let i = currentIndex - 1; i >= 0; i--) {
    const prior = history[i]!;
    if (prior.direction !== "out" || !/(?:mst|ma so thue|thong tin|hoa don|xhd)/.test(fold(prior.text))) continue;
    for (let j = i - 1; j >= 0; j--) {
      const request = history[j]!;
      const text = fold(request.text);
      if (request.direction === "in" && /^\s*\/(?:new|reset)\s*$/.test(text)) break;
      if (request.direction === "in" && /(?:xhd|hoa don)/.test(text) &&
          /(?:thong tin|mst)/.test(text) && /(?:cu|truoc|nhu cu)/.test(text)) return request.id;
      if (request.direction === "in" && /(?:xhd|hoa don)/.test(text) &&
          !/(?:cu|truoc|nhu cu)/.test(text)) break;
    }
    break;
  }
  return null;
}

/** Accounting replies must contain a tax code; MISA supplies the full legal name/address. */
export function taxCodeFromAccountingReply(text: string): { taxCode: string; email: string } | null {
  if (!/(?:\bmst\b|ma so thue)/.test(fold(text)) &&
      !/^\s*\d{10}(?:-\d{3})?\s*$/.test(text)) return null;
  const taxCode = text.match(/(?<!\d)\d{10}(?:-\d{3})?(?!\d)/)?.[0] ?? "";
  if (!taxCode) return null;
  const email = text.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0] ?? "";
  return { taxCode, email };
}

export function misaAccountingNotice(kind: "draft_saved" | "issued" | "missing_info",
  customer: string, source: string, invoiceNumber?: string): string {
  const name = customer.trim().slice(0, 120) || "Khách chưa rõ tên";
  const via = source.trim().slice(0, 80);
  if (kind === "missing_info") return `${name} — nguồn ${via}: cần xuất hóa đơn, chưa có thông tin. Kế toán vui lòng trả lời tin này kèm MST.`;
  if (kind === "draft_saved") return `Đã xuất hóa đơn nháp cho ${name} — nguồn ${via}; chưa phát hành.`;
  return `Đã phát hành hóa đơn số ${invoiceNumber || "(chưa rõ)"} cho ${name} — nguồn ${via}.`;
}
