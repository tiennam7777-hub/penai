import type { OrchidStemMessage } from "@penai/db";

export interface OrchidStemEntry extends OrchidStemMessage {
  customerName: string;
  stems: number;
  day: string;
}

/** Only a customer name followed by one plausible stem quantity is counted. */
export function parseOrchidStemText(text: string): { customerName: string; stems: number } | null {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean || /\b(?:ship|vat|giá|tổng|đồng|vnd|kpi)\b/i.test(clean)) return null;
  const matches = [...clean.matchAll(/(?<!\d)(\d{1,3})(?!\d)/g)];
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  const stems = Number(match[1]);
  if (stems < 1 || stems > 200) return null;
  const after = clean.slice(match.index! + match[0].length).trim();
  if (after && !/^(?:c|cành|canh|cảnh|cây|cay|nhánh|nhanh|tầm|tam)?$/iu.test(after.replace(/[.)\s-]/g, ""))) return null;
  const customerName = clean.slice(0, match.index).replace(/[\s,.:;()\-]+$/g, "").trim();
  if (!/[\p{L}]/u.test(customerName) || customerName.length < 2) return null;
  return { customerName, stems };
}

export function orchidStemDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

export function buildOrchidStemReport(messages: OrchidStemMessage[]) {
  const entries: OrchidStemEntry[] = [];
  const review: OrchidStemMessage[] = [];
  for (const message of messages) {
    const parsed = parseOrchidStemText(message.text);
    if (parsed) entries.push({ ...message, ...parsed, day: orchidStemDay(message.sentAt) });
    else if (/\d/.test(message.text)) review.push(message);
  }
  const daily = new Map<string, { day: string; senderId: string; senderName: string; stems: number; jobs: number }>();
  const monthly = new Map<string, { senderId: string; senderName: string; stems: number; jobs: number }>();
  for (const entry of entries) {
    const dailyKey = `${entry.day}:${entry.senderId}`;
    const d = daily.get(dailyKey) ?? { day: entry.day, senderId: entry.senderId, senderName: entry.senderName, stems: 0, jobs: 0 };
    d.senderName = entry.senderName; d.stems += entry.stems; d.jobs++; daily.set(dailyKey, d);
    const m = monthly.get(entry.senderId) ?? { senderId: entry.senderId, senderName: entry.senderName, stems: 0, jobs: 0 };
    m.senderName = entry.senderName; m.stems += entry.stems; m.jobs++; monthly.set(entry.senderId, m);
  }
  return { entries, review, daily: [...daily.values()], monthly: [...monthly.values()] };
}
