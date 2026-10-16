import type { InboxMessageRow } from "@penai/db";

/** Cung cấp hai số tiền từ báo giá hoa + ship gần nhất khi khách xin tài khoản. */
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
  const shippingRaw = quote.text.match(/phí\s*(?:ship|giao)[^\n]{0,150}?(\d[\d.,]*)\s*đ/iu)?.[1];
  const freeShipping = /(?:giao|ship)[^\n]{0,80}?miễn\s*phí/iu.test(quote.text);
  if (!shippingRaw && !freeShipping) {
    return "[CHƯA CÓ TỔNG THANH TOÁN: Giá hoa đã có nhưng chưa có phí ship chắc chắn cho đúng điểm giao. Xác định phí ship trước khi gửi số tiền chuyển khoản; không tự báo tổng hoặc VAT.]";
  }
  const shippingFee = freeShipping ? 0 : Number(shippingRaw?.replace(/[.,]/g, ""));
  if (!Number.isSafeInteger(shippingFee) || shippingFee < 0) return "";
  const cashTotal = flowerPrice + shippingFee;
  const withVat = Math.round(cashTotal * 1.05);
  return `[SỐ TIỀN THANH TOÁN ĐÃ TÍNH: Giá hoa ${flowerPrice.toLocaleString("vi-VN")}đ + phí ship ${shippingFee.toLocaleString("vi-VN")}đ = ${cashTotal.toLocaleString("vi-VN")}đ tiền mặt. Nếu lấy hóa đơn VAT 5% trên CẢ giá hoa và ship thì tổng chuyển khoản công ty là ${withVat.toLocaleString("vi-VN")}đ. Khi gửi tài khoản, báo đúng hai số tiền: "${withVat.toLocaleString("vi-VN")}đ đã gồm VAT" và "${cashTotal.toLocaleString("vi-VN")}đ tiền mặt nếu không lấy VAT". Không báo ${flowerPrice.toLocaleString("vi-VN")}đ hoặc VAT chỉ trên hoa. Nếu khách đã đổi chậu, địa chỉ hay phí ship sau báo giá này, phải tính lại.]`;
}
