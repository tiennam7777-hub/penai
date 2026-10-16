import type { InboxMessageRow } from "@penai/db";

/** Cung cấp số tiền VAT từ báo giá hoa gần nhất khi khách xin tài khoản công ty. */
export function orchidCompanyPaymentContext(messages: InboxMessageRow[]): string {
  const last = messages.at(-1);
  if (!last || last.direction !== "in" || !/(?:s[oố]\s*t[aà]i\s*kho[aả]n|stk|chuy[eể]n\s*kho[aả]n)/iu.test(last.text)) return "";
  const reset = messages.findLastIndex((message) => message.direction === "in" && /^\s*\/(?:new|reset)\s*$/i.test(message.text));
  const quote = messages.slice(reset + 1, -1).reverse().find((message) =>
    message.direction === "out" && /(?:chậu|hoa)[^\n]{0,150}?giá\s*\d[\d.,]*\s*đ/iu.test(message.text) &&
    /chưa\s*gồm\s*VAT\s*5\s*%/iu.test(message.text));
  if (!quote) return "";
  const raw = quote.text.match(/(?:chậu|hoa)[^\n]{0,150}?giá\s*(\d[\d.,]*)\s*đ/iu)?.[1];
  const flowerPrice = Number(raw?.replace(/[.,]/g, ""));
  if (!Number.isSafeInteger(flowerPrice) || flowerPrice <= 0) return "";
  const withVat = Math.round(flowerPrice * 1.05);
  return `[SỐ TIỀN CHUYỂN KHOẢN ĐÃ TÍNH: Giá hoa đã báo ${flowerPrice.toLocaleString("vi-VN")}đ, chưa gồm VAT 5%. Số tiền giá hoa cộng VAT là ${withVat.toLocaleString("vi-VN")}đ. Khi gửi số tài khoản công ty, nói đúng MỘT số tiền này là "${withVat.toLocaleString("vi-VN")}đ luôn VAT"; không liệt kê phép tính, không cộng phí ship vào số tiền này. Nếu giá hoa đã được khách đổi sau báo giá, phải tính lại theo giá mới.]`;
}
