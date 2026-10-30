import type { OrchidStemMessage } from "@penai/db";
import { listOrchidStemMessages, listOrchidWorkPlanMessages, type Db } from "@penai/db";
import type { WorkspaceContext } from "@penai/shared";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { buildXlsx } from "./xlsx.js";
import { sharedDirFor } from "./library-paths.js";

export interface OrchidStemEntry extends OrchidStemMessage {
  customerName: string;
  stems: number;
  day: string;
  quotedPhotoMsgId?: string;
  quoteSentAt?: string;
  originalDayConfirmed?: boolean;
}

function stemCustomerName(prefix: string): string | null {
  const name = prefix
    .replace(/[\s,.:;()\-]+$/g, "")
    .replace(/(?:\s+|^)(?:cành|canh|cảnh|cây|cay)$/iu, "")
    .replace(/[\s,.:;()\-]+$/g, "")
    .replace(/^(?:cành|canh|cảnh|cây|cay)[\s,.:;()\-]+/iu, "")
    .trim();
  return /[\p{L}]/u.test(name) && name.length >= 2 && !/\d/.test(name) ? name : null;
}

/** Count a named pot with one quantity, or multiply its cành and vòi counts. */
export function parseOrchidStemText(text: string): { customerName: string; stems: number } | null {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean || /\b(?:ship|vat|giá|tổng|đồng|vnd|kpi)\b/i.test(clean)) return null;
  // The shop also writes "C Chi (8c) Lộc": a quantity in parentheses, then a short name/note.
  // Keep the original message for audit, but ignore that trailing note when reading the quantity.
  const annotated = /^(.+?\(\s*\d{1,3}\s*(?:c|f|cành|canh|cảnh|cây|cay|nhánh|nhanh)(?:\s+(?:[x×]\s*)?[1-9]\s*(?:v|vòi|voi))?\s*\))\s+([\p{L}]+(?:\s+[\p{L}]+){0,2})$/iu.exec(clean);
  const suffix = annotated?.[2] ?? "";
  if (suffix && /^(?:hủy|huỷ|đổi|sửa|xóa|xoá|hoàn|trả)(?:\s|$)/iu.test(suffix)) return null;
  const counted = annotated ? annotated[1]! : clean;
  // "3c 2v" and "Cảnh 5 2v" mean 3×2 and 5×2 stems, respectively.
  const multi = /(?<!\d)(\d{1,3})\s*(?:c|f|cành|canh|cảnh|cây|cay)?(?:\s+|\s*[x×]\s*)([1-9])\s*(?:v|vòi|voi)\s*\)?$/iu.exec(counted);
  if (multi) {
    const prefix = counted.slice(0, multi.index);
    if (multi.index > 0 && /[\p{L}]/u.test(counted[multi.index - 1]!)) return null;
    const customerName = stemCustomerName(prefix);
    const stems = Number(multi[1]) * Number(multi[2]);
    return customerName && stems >= 1 && stems <= 200 ? { customerName, stems } : null;
  }
  const matches = [...counted.matchAll(/(?<!\d)(\d{1,3})(?!\d)/g)];
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  const stems = Number(match[1]);
  if (stems < 1 || stems > 200) return null;
  if (match.index! > 0 && /[\p{L}]/u.test(counted[match.index! - 1]!)) return null;
  const after = counted.slice(match.index! + match[0].length).trim();
  if (after && !/^(?:c|f|cành|canh|cảnh|cây|cay|nhánh|nhanh|tầm|tam)?$/iu.test(after.replace(/[.)\s-]/g, ""))) return null;
  const customerName = stemCustomerName(counted.slice(0, match.index));
  if (!customerName) return null;
  return { customerName, stems };
}

function quantityOnly(text: string): number | null {
  const clean = text.replace(/[\s.()\-]+/g, " ").trim();
  const match = /^(?:(?:cành|canh|cảnh|cây|cay)\s+)?(\d{1,3})(?:\s*(?:c|f|cành|canh|cảnh|cây|cay|tam|tầm))?$/iu.exec(clean);
  const stems = match ? Number(match[1]) : 0;
  return stems >= 1 && stems <= 200 ? stems : null;
}

function quotedPhotoQuantity(text: string, photoSenderName: string): number | null {
  const clean = text.replace(/\s+/g, " ").trim();
  const names = new Set([photoSenderName, senderLabel(photoSenderName)]);
  for (const name of names) {
    const mention = `@${name}`;
    if (clean.toLocaleLowerCase("vi").startsWith(mention.toLocaleLowerCase("vi")) &&
        /^\s/.test(clean.slice(mention.length))) {
      return quantityOnly(clean.slice(mention.length));
    }
  }
  return quantityOnly(clean);
}

function senderLabel(name: string): string {
  // Zalo currently reports the Hot 6 account as “… S”; shop calls this account “… VI”.
  return name === "Lan Hồ Điệp Orchids World S" ? "Lan Hồ Điệp Orchids World VI" : name;
}

export function orchidStemDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

export function orchidStemTime(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

/** A late quoted count must also refresh the saved file for the photo's month. */
export function orchidStemRefreshMonths(quoteAt: string,
  originalPhoto?: { contentType: string; text: string; sentAt: string } | null): string[] {
  const months = new Set([orchidStemDay(quoteAt).slice(0, 7)]);
  if (originalPhoto?.contentType === "photo" && !/\d/.test(originalPhoto.text)) {
    months.add(orchidStemDay(originalPhoto.sentAt).slice(0, 7));
  }
  return [...months];
}

/** Inclusive local calendar dates, converted to a half-open UTC interval. */
export function orchidStemDateBounds(from: string, to: string): { start: Date; end: Date } | null {
  const valid = (value: string) => {
    if (!/^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    return new Date(Date.UTC(year!, month! - 1, day!)).toISOString().slice(0, 10) === value;
  };
  if (!valid(from) || !valid(to) || from > to) return null;
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return {
    start: new Date(Date.UTC(fy!, fm! - 1, fd!) - 7 * 3600_000),
    end: new Date(Date.UTC(ty!, tm! - 1, td! + 1) - 7 * 3600_000),
  };
}

/** Only completed flower-work totals, never tomorrow's plan or generic sales quantities. */
export function parseOrchidWorkPlanCount(text: string, sentAt: string): { day: string; stems: number } | null {
  const lines = text.replace(/\r/g, "").split("\n");
  if (!/(?:bccv|báo cáo|bao cao|\b\d{1,2}\/\d{1,2}\b)/iu.test(lines.slice(0, 3).join(" "))) return null;
  const first = lines[0] + (/^\s*\d{1,2}\/\d{1,2}(?:\/20\d{2})?\s*$/u.test(lines[1] ?? "") ? ` ${lines[1]}` : "");
  const dateMatch = /(?:^|\b)(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?/u.exec(first);
  let day = orchidStemDay(sentAt);
  if (dateMatch) {
    const year = Number(dateMatch[3] ?? day.slice(0, 4));
    const candidate = `${year}-${String(dateMatch[2]).padStart(2, "0")}-${String(dateMatch[1]).padStart(2, "0")}`;
    if (orchidStemDateBounds(candidate, candidate)) day = candidate;
  }
  const completed: string[] = [];
  for (const line of lines) {
    // The remainder is a plan for the following day, not completed work.
    if (completed.length && /^\s*\d{1,2}\/\d{1,2}(?:\/20\d{2})?\s*$/u.test(line)) break;
    if (/^\s*[-•]?\s*(?:kh(?:nm|cv)?(?=\b|\d)|kế hoạch|ke hoach)/iu.test(line)) break;
    completed.push(line);
  }
  const work = completed.join("\n");
  const counts: number[] = [];
  const patterns = [
    /(?:tổng\s*)?cắm\s*\d{1,3}\s*(?:đơn|đ|₫)\s*\(?\s*(\d{1,4})\s*(?:cây|cành|c\b)/giu,
    /(?:tổng\s*)?cắm\s*(\d{1,4})\s*(?:cây|cành|c\b)/giu,
    /(?:^|\n)\s*[-•]?\s*cắm\s*(\d{1,4})(?=\s*(?:\n|$))/giu,
  ];
  for (const pattern of patterns) for (const match of work.matchAll(pattern)) {
    const value = Number(match[1]);
    if (value >= 1 && value <= 1000) counts.push(value);
  }
  return counts.length && new Set(counts).size === 1 ? { day, stems: counts[0]! } : null;
}

export function addOrchidWorkPlanCounts(report: ReturnType<typeof buildOrchidStemReport>,
  messages: OrchidStemMessage[]) {
  const byDaySender = new Map<string, { stems: number; sentAt: string }>();
  for (const message of messages) {
    const parsed = parseOrchidWorkPlanCount(message.text, message.sentAt);
    if (!parsed) continue;
    const key = `${parsed.day}:${message.senderId}`;
    const prior = byDaySender.get(key);
    // A later complete report is a correction; repeated copies do not add twice.
    if (!prior || message.sentAt > prior.sentAt) byDaySender.set(key, { stems: parsed.stems, sentAt: message.sentAt });
  }
  const daily = report.daily.map(row => ({ ...row,
    nvbc: byDaySender.get(`${row.day}:${row.senderId}`)?.stems ?? null }));
  const monthly = report.monthly.map(row => {
    const days = daily.filter(d => d.senderName === row.senderName);
    const reported = days.filter(d => d.nvbc !== null);
    return { ...row, nvbc: reported.length ? reported.reduce((sum, d) => sum + d.nvbc!, 0) : null,
      nvbcDays: reported.length, countedDays: days.length };
  });
  return { ...report, daily, monthly };
}

export function buildOrchidStemReport(messages: OrchidStemMessage[]) {
  const entries: OrchidStemEntry[] = [];
  const review: OrchidStemMessage[] = [];
  const latestCustomer = new Map<string, { name: string; at: number }>();
  const photos = new Map(messages.filter(m => m.contentType === "photo").map(m => [m.msgId, m]));
  const photosByCliId = new Map(messages.filter(m => m.contentType === "photo" && m.cliMsgId)
    .map(m => [`${m.senderId}:${m.cliMsgId}`, m]));
  const photoQuotes = new Map<string, Array<{ photo: OrchidStemMessage; quote: OrchidStemMessage; stems: number }>>();
  for (const message of messages) {
    const photo = (message.quotedMsgId && message.quotedMsgId !== "0" ? photos.get(message.quotedMsgId) : undefined)
      ?? (message.quoteOwnerId && message.quotedCliMsgId
        ? photosByCliId.get(`${message.quoteOwnerId}:${message.quotedCliMsgId}`) : undefined);
    if (photo) {
      // A quote identifies the exact photo. Attribute the count to its original
      // sender, even when a colleague posts the correction with an @mention.
      const ownerMatchesPhoto = message.quoteOwnerId
        ? message.quoteOwnerId === photo.senderId
        : photo.senderId === message.senderId;
      const stems = quotedPhotoQuantity(message.text, photo.senderName);
      if (ownerMatchesPhoto && stems && !/\d/.test(photo.text)) {
        const candidates = photoQuotes.get(photo.msgId) ?? [];
        candidates.push({ photo, quote: message, stems });
        photoQuotes.set(photo.msgId, candidates);
        continue; // Count this quote only through its original photo.
      }
    }
    if (message.inRange === false) continue;
    // An unnumbered photo is not a report or a customer-name hint. It becomes
    // one report only when a later quote identifies that photo and gives a count.
    if (message.contentType === "photo" && !/\d/.test(message.text)) continue;
    const senderName = senderLabel(message.senderName);
    const source = { ...message, senderName };
    let parsed = parseOrchidStemText(message.text);
    if (!parsed) {
      const stems = quantityOnly(message.text);
      const prior = latestCustomer.get(senderName);
      if (stems && prior && new Date(message.sentAt).getTime() - prior.at <= 5 * 60_000) {
        parsed = { customerName: prior.name, stems };
      }
    }
    if (parsed) {
      const confirmedDay = /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(message.originalPhotoDay ?? "")
        ? message.originalPhotoDay : undefined;
      entries.push({ ...source, ...parsed, day: confirmedDay ?? orchidStemDay(message.sentAt),
        ...(confirmedDay ? { quoteSentAt: message.sentAt, originalDayConfirmed: true } : {}) });
    }
    else if (/\d/.test(message.text)) review.push(source);
    else {
      const name = message.text.replace(/\s+/g, " ").trim();
      if (name.length >= 2 && name.length <= 80 && /[\p{L}]/u.test(name) &&
          !/^(?:hi|ok|dạ|vâng|cảm ơn|xong)$/iu.test(name)) {
        latestCustomer.set(senderName, { name, at: new Date(message.sentAt).getTime() });
      }
    }
  }
  for (const candidates of photoQuotes.values()) {
    const { photo } = candidates[0]!;
    if (photo.inRange === false) continue;
    if (new Set(candidates.map(x => x.stems)).size !== 1) {
      review.push(...candidates.map(x => x.quote));
      continue;
    }
    const { quote, stems } = candidates[0]!;
    entries.push({ ...photo, senderName: senderLabel(photo.senderName), msgId: quote.msgId, text: quote.text,
      customerName: "Ảnh báo cáo", stems, day: orchidStemDay(photo.sentAt),
      quotedPhotoMsgId: photo.msgId, quoteSentAt: quote.sentAt });
  }
  const daily = new Map<string, { day: string; senderId: string; senderName: string; stems: number; jobs: number }>();
  const monthly = new Map<string, { senderId: string; senderName: string; stems: number; jobs: number }>();
  for (const entry of entries) {
    const dailyKey = `${entry.day}:${entry.senderName}`;
    const d = daily.get(dailyKey) ?? { day: entry.day, senderId: entry.senderId, senderName: entry.senderName, stems: 0, jobs: 0 };
    d.senderName = entry.senderName; d.stems += entry.stems; d.jobs++; daily.set(dailyKey, d);
    const m = monthly.get(entry.senderName) ?? { senderId: entry.senderId, senderName: entry.senderName, stems: 0, jobs: 0 };
    m.senderName = entry.senderName; m.stems += entry.stems; m.jobs++; monthly.set(entry.senderName, m);
  }
  return { entries, review, daily: [...daily.values()], monthly: [...monthly.values()] };
}

export function filterOrchidStemReport(report: ReturnType<typeof addOrchidWorkPlanCounts>, sender: string) {
  if (!sender) return report;
  return {
    entries: report.entries.filter(x => x.senderName === sender),
    review: report.review.filter(x => x.senderName === sender),
    daily: report.daily.filter(x => x.senderName === sender),
    monthly: report.monthly.filter(x => x.senderName === sender),
  };
}

export function orchidStemWorkbook(report: ReturnType<typeof addOrchidWorkPlanCounts>,
  filter?: { from: string; to: string; sender: string }): Buffer {
  return buildXlsx([
    ...(filter ? [{ name: "Bộ lọc", widths: [24, 36], rows: [
      ["Điều kiện", "Giá trị"], ["Từ ngày", filter.from], ["Đến ngày", filter.to],
      ["Nhân viên", filter.sender || "Tất cả"],
    ] }] : []),
    { name: "Chi tiết", widths: [20, 12, 25, 24, 30, 12, 48, 22, 22, 20, 34], rows: [
      ["Ngày", "Giờ gửi ảnh/tin gốc", "Người gửi", "UID người gửi", "Tên khách", "Số cành tính", "Tin gốc", "Mã tin Zalo", "Mã ảnh trích dẫn", "Giờ báo lại", "Ghi chú ngày tính"],
      ...report.entries.map(e => [e.day, e.originalDayConfirmed ? "" : orchidStemTime(e.sentAt),
        e.senderName, e.senderId, e.customerName, e.stems, e.text, e.msgId, e.quotedPhotoMsgId ?? "",
        e.quoteSentAt ? new Date(e.quoteSentAt) : "", e.originalDayConfirmed ? "Chủ shop xác nhận ngày ảnh gốc" : ""]),
    ] },
    { name: "Theo ngày", widths: [20, 25, 24, 16, 16, 16], rows: [
      ["Ngày", "Người gửi", "UID người gửi", "Số lượt", "Tổng cành tính", "NVBC"],
      ...report.daily.map(d => [d.day, d.senderName, d.senderId, d.jobs, d.stems, d.nvbc ?? ""]),
    ] },
    { name: "Theo nhân viên", widths: [25, 24, 16, 16, 16, 20], rows: [
      ["Người gửi", "UID người gửi", "Số lượt", "Tổng cành tính", "NVBC", "Ngày có NVBC"],
      ...report.monthly.map(m => [m.senderName, m.senderId, m.jobs, m.stems, m.nvbc ?? "", `${m.nvbcDays}/${m.countedDays}`]),
    ] },
    { name: "Cần kiểm tra", widths: [22, 25, 24, 50, 22], rows: [
      ["Thời điểm", "Người gửi", "UID người gửi", "Tin chưa cộng", "Mã tin Zalo"],
      ...report.review.map(m => [new Date(m.sentAt), m.senderName, m.senderId, m.text, m.msgId]),
    ] },
  ]);
}

const refreshes = new Map<string, Promise<string>>();
/** Persist the current month as a single Excel file in the visible shared library. */
export function refreshOrchidStemFile(db: Db, ctx: WorkspaceContext, channelId: string,
  threadId: string, month: string, dataDir: string): Promise<string> {
  const key = `${ctx.workspaceId}:${channelId}:${month}`;
  const prior = refreshes.get(key) ?? Promise.resolve("");
  const next = prior.catch(() => "").then(async () => {
    const [year, mon] = month.split("-").map(Number);
    if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Tháng không hợp lệ");
    const start = new Date(Date.UTC(year!, mon! - 1, 1) - 7 * 3600_000);
    const end = new Date(Date.UTC(year!, mon!, 1) - 7 * 3600_000);
    const [messages, plans] = await Promise.all([
      listOrchidStemMessages(db, ctx, channelId, threadId, start, end),
      listOrchidWorkPlanMessages(db, ctx, channelId, start, new Date(end.getTime() + 8 * 3600_000)),
    ]);
    const report = addOrchidWorkPlanCounts(buildOrchidStemReport(messages), plans);
    const dir = join(sharedDirFor(dataDir, ctx.workspaceId), "bao-cao-cam-hoa");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `bao-cao-cam-hoa-${month}.xlsx`);
    const temp = join(dir, `.bao-cao-${randomBytes(8).toString("hex")}.tmp`);
    await writeFile(temp, orchidStemWorkbook(report));
    await rename(temp, file);
    return file;
  });
  refreshes.set(key, next);
  void next.finally(() => { if (refreshes.get(key) === next) refreshes.delete(key); }).catch(() => {});
  return next;
}
