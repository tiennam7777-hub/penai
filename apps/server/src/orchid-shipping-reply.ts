import type { InboxMessageRow } from "@penai/db";
import { calculateOrchidShipping } from "@penai/tools";

type ShippingHint = { destination: string; feeVnd: number; distanceKm: number };

/** Chỉ dùng các tuyến đã được cửa hàng xác nhận; tên cơ sở khác phải đo lại. */
function knownRoute(text: string): { destination: string; distanceKm: number } | null {
  const normalized = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/benh\s*vien\s*xuyen\s*a/.test(normalized) && /(?:ql\s*22|quoc\s*lo\s*22)/.test(normalized)) {
    return { destination: "Bệnh viện Xuyên Á trên QL22", distanceKm: 24.3 };
  }
  if (/hutech/.test(normalized) && /(?:coca[\s-]*cola|xa\s*lo\s*ha\s*noi|hiep\s*phu)/.test(normalized)) {
    return { destination: "HUTECH đối diện Coca-Cola", distanceKm: 14 };
  }
  return null;
}

/** Lấy điểm giao và số cành trong yêu cầu hiện tại, kể cả khi vừa /new. */
export function knownOrchidShippingHint(
  messages: InboxMessageRow[],
  customerType: "retail" | "wholesale",
): ShippingHint | null {
  const reset = messages.findLastIndex((message) => message.direction === "in" && /^\s*\/(?:new|reset)\s*$/i.test(message.text));
  const incoming = messages.slice(reset + 1).filter((message) => message.direction === "in");
  const recent = incoming.slice(-8);
  const last = recent.at(-1)?.text ?? "";
  if (!recent.length || !/(?:\bgia\b|bao\s*nhieu|\bphi\b|canh)/i.test(
    last.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(),
  )) return null;
  const route = knownRoute(recent.map((message) => message.text).join("\n"));
  if (!route) return null;
  const stemText = recent.map((message) => message.text).reverse().find((text) => /\d+\s*(?:cành|canh|cây|cay)/i.test(text)) ?? "";
  const stems = Number(stemText.match(/(\d+)\s*(?:cành|canh|cây|cay)/i)?.[1]);
  if (!Number.isInteger(stems) || stems < 1 || stems > 99) return null;
  const quote = calculateOrchidShipping({ customerType, stemCount: stems, distanceKm: route.distanceKm });
  return quote.kind === "quote" ? { ...route, feeVnd: quote.feeVnd } : null;
}

export function orchidShippingHintContext(hint: ShippingHint | null): string {
  if (!hint) return "";
  return `[DỮ KIỆN PHÍ SHIP ĐÃ TÍNH: Điểm giao ${hint.destination}, tuyến đường bộ ${hint.distanceKm} km từ 42 Điện Biên Phủ. Phí ship theo đúng loại khách và số cành hiện tại là ${hint.feeVnd.toLocaleString("vi-VN")}đ. Khi báo giá chậu, BẮT BUỘC báo khoản này ngay trong cùng tin. Không nói kiểm tra/báo phí ship sau.]`;
}

/** Chốt an toàn nếu model bỏ qua khoản ship dù dữ kiện đã có. */
export function completeOrchidShippingReply(reply: string, hint: ShippingHint | null): string {
  if (!hint || !/\bgiá\s*[\d.,]+/i.test(reply) || !/(?:chậu|hoa)/i.test(reply)) return reply;
  if (/phí\s*(?:ship|giao)[^.!?\n]*?\d[\d.,]*\s*(?:đ|k\b)/i.test(reply)) return reply;
  const fee = hint.feeVnd === 0 ? "miễn phí" : `${hint.feeVnd.toLocaleString("vi-VN")}đ`;
  const sentence = hint.feeVnd === 0
    ? `Giao đến ${hint.destination} miễn phí.`
    : `Phí ship đến ${hint.destination} là ${fee}.`;
  const withoutDeferral = reply.replace(/phí\s*(?:ship|giao)[^.!?\n]*?(?:kiểm tra|báo sau|báo lại|rồi báo)[^.!?\n]*[.!?]?/iu, "").trim();
  return `${withoutDeferral} ${sentence}`.replace(/\s{2,}/g, " ").trim();
}
