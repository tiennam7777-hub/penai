import type { OrchidStemMessage } from "@penai/db";
import { orchidStemDay, orchidStemDateBounds } from "./orchid-stem-report.js";

export interface DeliveryRow { day: string; senderId: string; senderName: string; orders: number; far: number; heavy: number; msgId: string; text: string; sentAt: string }

function deliveryDay(text: string, sentAt: string): string {
  const sentDay = orchidStemDay(sentAt);
  const header = text.slice(0, 100).match(/(?:^|\b)(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(20\d{2}))?/u);
  if (header) {
    const candidate = `${header[3] || sentDay.slice(0, 4)}-${header[2]!.padStart(2, "0")}-${header[1]!.padStart(2, "0")}`;
    if (orchidStemDateBounds(candidate, candidate)) return candidate;
  }
  if (/\b(?:hôm qua|hom qua)\b/iu.test(text.slice(0, 100)) ||
      new Date(Date.parse(sentAt) + 7 * 3600_000).getUTCHours() < 9) {
    const previous = new Date(`${sentDay}T00:00:00.000Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    return previous.toISOString().slice(0, 10);
  }
  return sentDay;
}

function parseDeliverySupplement(text: string, sentAt: string) {
  const normalized = text.normalize("NFKD").replace(/\p{M}/gu, "").replace(/đ/giu, "d").toLowerCase();
  if (!/^\s*bo\s+sung\b/u.test(normalized)) return null;
  const value = (pattern: RegExp) => {
    const matches = [...normalized.matchAll(pattern)].map(match => Number(match[1] || match[2]));
    return matches.length === 1 ? matches[0]! : 0;
  };
  const far = value(/\b(\d{1,3})\s*(?:don\s*)?xa\b|\bxa\s*(\d{1,3})\b/gu);
  const heavy = value(/\b(\d{1,3})\s*(?:don\s*)?nang\b|\bnang\s*(\d{1,3})\b/gu);
  const orders = value(/\b(?:giao|ship|di)\s*(?:them\s*)?(\d{1,3})\s*don\b/gu) ||
    (!far && !heavy ? value(/\b(\d{1,3})\s*don\b/gu) : 0);
  if (!orders && !far && !heavy) return { day: deliveryDay(text, sentAt), orders: 0, far: 0, heavy: 0 };
  return { day: deliveryDay(text, sentAt), orders, far, heavy };
}

const KEN_VU_LABEL = "Ken-chery+ A Vũ hot Seven";
function deliveryPerson(message: OrchidStemMessage): { key: string; name: string } {
  const normalized = message.senderName.normalize("NFKD").replace(/\p{M}/gu, "")
    .toLocaleLowerCase("vi").replace(/[^\p{L}\p{N}]+/gu, "");
  if (normalized === "kenchery" || normalized === "avuhotseven") {
    return { key: "ken-vu", name: KEN_VU_LABEL };
  }
  return { key: message.senderId, name: message.senderName };
}

/** Only completed deliveries in the work report; never count tomorrow's plan or order handling. */
export function parseDeliveryReport(text: string, sentAt: string): { day: string; orders: number; far: number; heavy: number } | null {
  const day = deliveryDay(text, sentAt);
  const completed = text.split(/\b(?:KHNM|KHCV|KẾ HOẠCH|KE HOACH|kế hoạch mai)\b/iu)[0]!;
  const parts = completed.replace(/\b((?:đi|di|giao|ship)\s*(?:được|dc)?)\s*\.{2,}\s*(?=\d{1,3}\s*(?:đơn|đon|don))/giu, "$1 ")
    .split(/[\n.;]|\.{2,}|-{2,}/u).map(x => x.trim()).filter(Boolean);
  const shipping = parts.filter(x => /(?<![\p{L}])(?:giao|ship|đi|di)(?![\p{L}])/iu.test(x) && /(?:đơn|đon|don)/iu.test(x)
    && !/(?:lên đơn|len don|chốt đơn|chot don|phân đơn|phan don|cắm|cam|xử lý|xu ly|đi sáng|di sang)/iu.test(x));
  if (!shipping.length) return null;
  const numbers: number[] = [];
  for (const part of shipping) {
    const matches = [...part.matchAll(/(?:(?<![\p{L}])(?:giao|ship|đi|di)(?![\p{L}])(?:\s+được|\s+dc)?[\s.]*)(\d{1,3})\s*(?:đơn|đon|don)|(\d{1,3})\s*(?:đơn|đon|don)/giu)];
    for (const m of matches) {
      if (/^\s*(?:xa|nặng|nang|năng)\b/iu.test(part.slice(m.index! + m[0].length))) continue;
      numbers.push(Number(m[1] || m[2]));
    }
  }
  // "8 đơn, hỗ trợ thêm 1 là 9" explicitly replaces the earlier subtotal.
  const corrected = /(?:là|la|tổng|tong)\s*(\d{1,3})\s*(?:đơn|don)?/iu.exec(completed);
  const total = /(?:giao|ship|đi|di)\s*(?:được|dc)?\s*(?:tổng|tong)\s*(\d{1,3})\s*(?:đơn|đon|don)/iu.exec(completed);
  const orders = total ? Number(total[1]) : corrected && /hỗ trợ|ho tro/iu.test(completed)
    ? Number(corrected[1]) : numbers.length === 1 ? numbers[0]! : 0;
  if (!orders || orders > 100) return null;
  const shippingStart = completed.indexOf(shipping[0]!);
  const scope = completed.slice(Math.max(0, shippingStart)).split(/(?:lấy|lay|tăng ca|tang ca|làm|lam|dọn dẹp|don dep|bọc|boc|xử lý|xu li|quét|quet|kế hoạch|ke hoach)/iu)[0]!;
  const metric = (word: string) => {
    const found = [...scope.matchAll(new RegExp(`(?:(\\d{1,3})\\s*(?:đơn|đon|don)?\\s*(?:${word})|(?:${word})\\s*(\\d{1,3})\\s*(?:đơn|đon|don))`, "giu"))]
      .map(m => Number(m[1] || m[2]));
    return found.length === 1 ? found[0]! : found.length === 0 ? 0 : -1;
  };
  const far = metric("xa"), heavy = metric("nặng|nang|năng");
  if (far < 0 || heavy < 0 || far > orders || heavy > orders) return null;
  return { day, orders, far, heavy };
}

export function buildDeliveryReport(messages: OrchidStemMessage[], from: string, to: string) {
  const latest = new Map<string, DeliveryRow>();
  const review: OrchidStemMessage[] = [];
  const seen = new Set<string>();
  for (const message of [...messages].sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.msgId.localeCompare(b.msgId))) {
    if (seen.has(message.msgId)) continue;
    seen.add(message.msgId);
    const person = deliveryPerson(message);
    const supplement = parseDeliverySupplement(message.text, message.sentAt);
    if (supplement) {
      if (supplement.day < from || supplement.day > to) continue;
      const prior = latest.get(`${supplement.day}:${person.key}`);
      if (!prior || (!supplement.orders && !supplement.far && !supplement.heavy) ||
          prior.far + supplement.far > prior.orders + supplement.orders ||
          prior.heavy + supplement.heavy > prior.orders + supplement.orders) {
        review.push({ ...message, senderName: person.name });
      } else {
        prior.orders += supplement.orders; prior.far += supplement.far; prior.heavy += supplement.heavy;
        prior.text += `\n[Bổ sung ${message.msgId}] ${message.text}`;
      }
      continue;
    }
    const parsed = parseDeliveryReport(message.text, message.sentAt);
    if (!parsed) {
      if (orchidStemDay(message.sentAt) >= from && orchidStemDay(message.sentAt) <= to &&
          /(?<![\p{L}])(?:giao|ship|đi|di)(?![\p{L}]).{0,25}\d{1,3}\s*(?:đơn|đon|don)/iu.test(message.text)) {
        review.push({ ...message, senderName: person.name });
      }
      continue;
    }
    if (parsed.day < from || parsed.day > to) continue;
    const key = `${parsed.day}:${person.key}`;
    const prior = latest.get(key);
    if (!prior || message.sentAt > prior.sentAt) latest.set(key, { ...parsed, senderId: person.key,
      senderName: person.name, msgId: message.msgId, text: message.text, sentAt: message.sentAt });
  }
  const daily = [...latest.values()].sort((a, b) => b.day.localeCompare(a.day) || b.orders - a.orders);
  const byPerson = new Map<string, { senderId: string; senderName: string; orders: number; far: number; heavy: number; days: number }>();
  for (const row of daily) {
    const person = byPerson.get(row.senderId) ?? { senderId: row.senderId, senderName: row.senderName, orders: 0, far: 0, heavy: 0, days: 0 };
    person.senderName = row.senderName; person.orders += row.orders; person.far += row.far; person.heavy += row.heavy; person.days++;
    byPerson.set(row.senderId, person);
  }
  const monthly = [...byPerson.values()].sort((a, b) => b.orders - a.orders || b.far - a.far || b.heavy - a.heavy || a.senderName.localeCompare(b.senderName, "vi"));
  return { monthly, daily, review, totals: { orders: daily.reduce((n, x) => n + x.orders, 0), far: daily.reduce((n, x) => n + x.far, 0), heavy: daily.reduce((n, x) => n + x.heavy, 0) } };
}
