import type { InboxMessageRow } from "@penai/db";
import { calculateOrchidShipping, type OrchidShippingPolicy } from "@penai/tools";

export type ShippingHint = { destination: string; feeVnd: number; distanceKm: number; reportFee: boolean };

/** This controls what is said to the customer, without changing the internal tariff. */
export function makeOrchidShippingHint(
  input: { destination: string; distanceKm: number; stemCount: number; customerType: "retail" | "wholesale" },
  policy?: OrchidShippingPolicy,
): ShippingHint | null {
  const { destination, distanceKm } = input;
  if (input.customerType === "retail" && distanceKm <= 10) {
    // Zero is a placeholder; this branch must never describe delivery as free.
    return { destination, distanceKm, feeVnd: 0, reportFee: false };
  }
  const quote = calculateOrchidShipping(input, policy);
  return quote.kind === "quote" ? { destination, distanceKm, feeVnd: quote.feeVnd, reportFee: true } : null;
}
const normalize = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").toLowerCase();

/** Chỉ dùng các tuyến đã được cửa hàng xác nhận; tên cơ sở khác phải đo lại. */
export function knownRoute(text: string): { destination: string; distanceKm: number } | null {
  const normalized = normalize(text);
  if (/benh\s*vien\s*xuyen\s*a/.test(normalized) && /(?:ql\s*22|quoc\s*lo\s*22)/.test(normalized)) {
    return { destination: "Bệnh viện Xuyên Á trên QL22", distanceKm: 24.3 };
  }
  if (/hutech/.test(normalized) && /(?:coca[\s-]*cola|xa\s*lo\s*ha\s*noi|hiep\s*phu)/.test(normalized)) {
    return { destination: "HUTECH đối diện Coca-Cola", distanceKm: 14 };
  }
  return null;
}

function isAreaAddress(text: string): boolean {
  const n = normalize(text);
  return /\b(?:duong|khu|vinhomes?|chung cu|toa nha)\b.{2,}/.test(n) &&
    /\b(?:quan|phuong|vinhomes?|hcm|thu duc|grand park)\b/.test(n);
}

function isAddressText(text: string): boolean {
  const n = normalize(text);
  return !!knownRoute(text) || isAreaAddress(text) || /(?:dia\s*chi|\bgiao\b|\bden\b|\btoi\b|\btai\b)/.test(n) ||
    /(?:\d+[\w/-]*\s+(?:duong\s+)?[a-z]+\s+[a-z]+.*(?:phuong|quan|binh thanh|thu duc|tp\b|hcm)|^\s*\d+[\w/-]*\s+(?!canh\b|cay\b|chau\b|trieu\b|tr\b|gio\b|ngay\b)[a-z]+\s+[a-z]+\s+[a-z]+)/.test(n);
}

function latestDeliveryText(messages: InboxMessageRow[]): string {
  const reset = messages.findLastIndex((message) => message.direction === "in" && /^\s*\/(?:new|reset)\s*$/i.test(message.text));
  const recent = messages.slice(reset + 1).filter((message) => message.direction === "in").slice(-20);
  return recent.map((message) => message.text).reverse().find(isAddressText) ?? "";
}

/** Extract only a single current pot, without inventing stems for a photo or a price range. */
export function orchidShippingRequest(messages: InboxMessageRow[]): { destination: string; stemCount: number } | null {
  const reset = messages.findLastIndex(m => m.direction === "in" && /^\s*\/(?:new|reset)\s*$/i.test(m.text));
  const recent = messages.slice(reset + 1).slice(-30);
  const last = recent.filter(m => m.direction === "in").at(-1)?.text ?? "";
  if (!isAddressText(last) && !/(?:ship|phi|gia|bao nhieu|canh|cay|chi phi)/.test(normalize(last))) return null;
  const delivery = latestDeliveryText(recent);
  if (!delivery) return null;
  let destination = delivery.replace(/^[\s\S]*?(?:địa chỉ(?:\s+giao)?\s*[:：]?|giao(?:\s+hoa)?\s+(?:đến|tới|tại|về)|giao tại)\s*/i, "")
    .replace(/[.!?]\s*(?:giá|gia|bao nhiêu)[\s\S]*$/i, "").trim();
  // A bare acknowledgement such as "giao về địa chỉ này" must not erase the address just above it.
  if (/^(?:này|nay)$/i.test(destination)) {
    const previous = recent.filter(m => m.direction === "in" && m.text !== delivery).map(m => m.text).reverse().find(isAddressText);
    if (previous) destination = previous;
  }
  if (!knownRoute(destination) && !isAreaAddress(destination) && !/^\s*\d+[\w/-]*\s+\S+\s+\S+/.test(destination) &&
      !/(?:bệnh viện|benh vien|tòa nhà|toa nha|trường|truong|chung cư|chung cu|khách sạn|khach san)/i.test(destination)) return null;
  if (recent.some(m => /(?:\b[2-9]\d*\s*chậu|\b[2-9]\d*\s*chau)/i.test(m.text))) return null;
  const stemsIn = (text: string) => {
    if (/(?:\d+\s*[-–]\s*\d+|\d+\s*(?:hoặc|hay|đến)\s*\d+)\s*(?:cành|canh|cây|cay)/i.test(text)) return null;
    const matches = [...text.matchAll(/(\d+)\s*(?:cành|canh|cây|cay)(?!\p{L})/giu)];
    if (matches.length !== 1 || /(?:kiểm tra|chưa rõ|tạm tính|cần xác nhận|\/cây|\/cành)/i.test(text)) return null;
    return Number(matches[0]![1]);
  };
  let stemCount: number | null = null;
  for (const m of [...recent].reverse().filter(m => m.direction === "in")) {
    stemCount = stemsIn(m.text); if (stemCount) break;
  }
  if (!stemCount) for (const m of [...recent].reverse().filter(m => m.direction === "out")) {
    if (!/chậu|chau/i.test(m.text)) continue;
    stemCount = stemsIn(m.text); if (stemCount) break;
  }
  return stemCount && stemCount <= 500 ? { destination, stemCount } : null;
}

export function orchidDeliveryPriorityContext(messages: InboxMessageRow[]): string {
  const latest = latestDeliveryText(messages);
  return latest ? `[ĐIỂM GIAO KHÁCH VỪA NÓI: ${latest.slice(0, 300)}. Nếu khác địa chỉ trong tin cũ, bỏ địa chỉ và phí ship cũ; chỉ tính theo điểm giao mới.]` : "";
}

/** Lấy điểm giao và số cành trong yêu cầu hiện tại, kể cả khi vừa /new. */
export function knownOrchidShippingHint(
  messages: InboxMessageRow[],
  customerType: "retail" | "wholesale",
  policy?: OrchidShippingPolicy,
): ShippingHint | null {
  const input = orchidShippingRequest(messages);
  if (!input) return null;
  const route = knownRoute(input.destination);
  if (!route) return null;
  return makeOrchidShippingHint({ ...route, customerType, stemCount: input.stemCount }, policy);
}

export function orchidShippingHintContext(hint: ShippingHint | null): string {
  if (!hint) return "";
  if (!hint.reportFee) return `[QUY TẮC TRẢ LỜI PHÍ SHIP: Khách lẻ, điểm giao ${hint.destination}, đường bộ ${hint.distanceKm} km, không hơn 10 km. Chỉ xác nhận ngắn "Dạ" khi nhận địa chỉ. Không nhắc phí ship, không nói 0đ/miễn phí/free ship, không xin vị trí để tính phí, không hẹn kiểm tra chính sách/phí giao. Không cộng một khoản ship vào tổng báo khách. Nếu khách hỏi việc khác thì vẫn trả lời đúng việc đó.]`;
  return `[DỮ KIỆN PHÍ SHIP ĐÃ TÍNH: Khu vực giao ${hint.destination}, tuyến đường bộ khoảng ${hint.distanceKm.toFixed(1)} km từ 42 Điện Biên Phủ. Phí ship ước tính theo loại khách và số cành hiện tại khoảng ${hint.feeVnd.toLocaleString("vi-VN")}đ. Dùng số này báo ngắn, chấp nhận sai số vị trí 500 m–1 km. Không hỏi số nhà, tòa/block/cổng hay ghim vị trí chỉ để báo phí; không yêu cầu khách xác nhận đúng tòa nhà tìm được nếu đã đúng khu vực. Không hẹn kiểm tra/báo phí sau.]`;
}

/** Chốt an toàn nếu model bỏ qua khoản ship dù dữ kiện đã có. */
export function completeOrchidShippingReply(reply: string, hint: ShippingHint | null, customerType?: "retail" | "wholesale"): string {
  if (!reply.trim()) return reply;
  if (hint?.reportFee === false || (!hint && customerType === "retail")) {
    // Do not quote retail delivery until the road distance is verified as over 10 km.
    const withoutShipping = reply.split(/(?<=[.!?])\s+|\n|[,;]\s*(?=(?:phí|tiền|cước|ship(?!per)|free|giao.{0,30}miễn phí))/i)
      .filter(part => !/(?:ship(?!per)|(?:phí|tiền|cước)\s*(?:giao|vận chuyển)|(?:giao|vận chuyển).{0,40}(?:miễn phí|0\s*đ))/i.test(part))
      .join(" ").trim();
    return withoutShipping || "Dạ.";
  }
  if (!hint) return reply;
  const existing = reply.match(/phí\s*(?:ship|giao)[^\d\n]*?(\d[\d.,]*)\s*(đ|k\b)/i);
  const existingFee = existing ? Number(existing[1]!.replace(/[.,]/g, "")) * (/k/i.test(existing[2]!) ? 1000 : 1) : null;
  if (existingFee === hint.feeVnd || (hint.feeVnd === 0 && /(?:giao|ship).{0,40}miễn phí|free\s*ship/i.test(reply))) return reply;
  const fee = hint.feeVnd === 0 ? "miễn phí" : `${hint.feeVnd.toLocaleString("vi-VN")}đ`;
  const sentence = hint.feeVnd === 0
    ? `Giao đến ${hint.destination} miễn phí.`
    : `Phí ship đến ${hint.destination} khoảng ${fee}.`;
  const withoutDeferral = reply.split(/(?<=[.!?])\s+|\n/).filter(part =>
    !/(?:phí\s*(?:ship|giao)|tiền\s*ship|free\s*ship|giao.{0,40}miễn phí)/i.test(part)).join(" ").trim();
  return `${withoutDeferral} ${sentence}`.replace(/\s{2,}/g, " ").trim();
}
