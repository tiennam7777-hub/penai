import type { OrchidStemMessage } from "@penai/db";
import { listOrchidStemGroups, listOrchidStemMessages, listOrchidWorkPlanMessages, type Db } from "@penai/db";
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
  countHistory?: Array<{ msgId: string; stems: number; sentAt: string }>;
}

export function isOrchidStemGroupName(name: string): boolean {
  return ["Bao Cao Cam hoa 42 DBP", "Báo Cáo Cắm Hoa 188", "Báo Cáo Cắm Hoa Hà Nội"].includes(name);
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
  // A material/style note after the count does not change the stem quantity.
  const counted = annotated ? annotated[1]! : clean.replace(/\s+(?:(?:cắm|cam)\s+)?(?:lũa|lua)\s*$/iu, "");
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
  // "2 chậu 18 c" is 18 stems in two pots, not 2 × 18 stems.
  const pots = /^\d{1,2}\s*chậu\s+(\d{1,3})\s*(?:c|cành|canh|cây|cay)\s*$/iu.exec(clean);
  if (pots) {
    const stems = Number(pots[1]);
    return stems >= 1 && stems <= 200 ? stems : null;
  }
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
  if (originalPhoto) {
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
  const dateMatch = /^\s*(?:(?:bccv|báo cáo(?:\s+cv)?|bao cao(?:\s+cv)?)\s*[:.\-]?\s*(?:ngày\s+)?)?(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?/iu.exec(first);
  let day = orchidStemDay(sentAt);
  const previousDay = new Date(Date.parse(`${day}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10);
  if (dateMatch) {
    const year = Number(dateMatch[3] ?? day.slice(0, 4));
    const candidate = `${year}-${String(dateMatch[2]).padStart(2, "0")}-${String(dateMatch[1]).padStart(2, "0")}`;
    if (orchidStemDateBounds(candidate, candidate)) {
      // Staff sometimes copy yesterday's report header and leave the old month.
      // When the day number matches the send date, use that date for the new
      // completed-work report rather than moving it a whole month backward.
      const sameDayNumber = candidate.slice(8) === day.slice(8);
      const monthGap = Math.abs((year - Number(day.slice(0, 4))) * 12 + Number(dateMatch[2]) - Number(day.slice(5, 7)));
      if (!sameDayNumber || monthGap === 0 || monthGap > 1) day = candidate;
    }
  } else {
    if (/\b(?:báo cáo|bao cao|bccv)\b.{0,20}\b(?:hôm qua|hom qua)\b|\b(?:hôm qua|hom qua)\b.{0,20}\b(?:báo cáo|bao cao|bccv)\b/iu.test(lines.slice(0, 3).join(" "))) day = previousDay;
    // Reports just after midnight often end with "Kh 19/10", meaning work on 18/10.
    const plan = /\bkh(?:nm|cv)?\s*(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?/iu.exec(text);
    if (plan) {
      const year = Number(plan[3] ?? day.slice(0, 4));
      const planDay = `${year}-${String(plan[2]).padStart(2, "0")}-${String(plan[1]).padStart(2, "0")}`;
      if (orchidStemDateBounds(planDay, planDay)) {
        const prior = new Date(Date.parse(`${planDay}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10);
        // An evening report with a copied KH date still describes today's work.
        const hour = Number(orchidStemTime(sentAt).slice(0, 2));
        if ((day === planDay && hour < 12) || day === prior) day = prior;
      }
    }
  }
  const completed: string[] = [];
  for (const line of lines) {
    // The remainder is a plan for the following day, not completed work.
    if (completed.length && /^\s*\d{1,2}\/\d{1,2}(?:\/20\d{2})?\s*$/u.test(line)) break;
    if (/^\s*[-•]?\s*(?:kh(?:nm|cv)?(?=\b|\d)|kế hoạch|ke hoach)/iu.test(line)) break;
    completed.push(line);
  }
  const work = completed.join("\n").replace(/\b(?:căm|cam)(?=\s*\d)/giu, "cắm");
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

/** A delayed message may contain completed reports for several past days. */
export function parseOrchidWorkPlanCounts(text: string, sentAt: string): Array<{ day: string; stems: number }> {
  const headers = [...text.matchAll(/^\s*(?:[-•]\s*)?(?:kh\s*|(?:bccv|báo cáo(?:\s+cv)?)\s*)?(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?[^\n]*/gimu)];
  const boundary = headers.find(header => text.slice(0, header.index).trim());
  // Retain the first KH date as context for after-midnight reports, while
  // excluding counts under a subsequent BCCV header from the first report.
  const firstEnd = boundary ? boundary.index! + (/bccv|báo cáo/iu.test(boundary[0]) ? 0 : boundary[0].length) : text.length;
  const first = parseOrchidWorkPlanCount(text.slice(0, firstEnd), sentAt);
  const result = first ? [first] : [];
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i]!;
    // The first section was already read with its original date context.
    if (!text.slice(0, header.index).trim()) continue;
    const day = `${header[3] ?? orchidStemDay(sentAt).slice(0, 4)}-${header[2]!.padStart(2, "0")}-${header[1]!.padStart(2, "0")}`;
    const section = text.slice(header.index! + header[0].length, headers[i + 1]?.index ?? text.length);
    // Future/today KH sections and conditional plans must never become actuals.
    const actualHeader = /bccv|báo cáo/iu.test(header[0]);
    if (day > orchidStemDay(sentAt) || (day === orchidStemDay(sentAt) && !actualHeader) ||
        !orchidStemDateBounds(day, day) || /nếu|dự kiến|sẽ\s+cắm/iu.test(section)) continue;
    if (/\bkh\b/iu.test(header[0]) && !/tổng\s+cắm\s*\d/iu.test(section)) continue;
    const parsed = parseOrchidWorkPlanCount(`BCCV ${header[1]}/${header[2]}/${header[3] ?? day.slice(0, 4)}\n${section}`, sentAt);
    if (parsed && !result.some(row => row.day === parsed.day)) result.push(parsed);
  }
  return result;
}

export function addOrchidWorkPlanCounts(report: ReturnType<typeof buildOrchidStemReport>,
  messages: OrchidStemMessage[], from?: string, to?: string) {
  const byDaySender = new Map<string, { stems: number; sentAt: string; message: OrchidStemMessage }>();
  const nvbcReview: Array<OrchidStemMessage & { day: string; stems: number; previousStems: number; previousMsgId: string }> = [];
  const lastReport = new Map<string, { day: string; sentAt: string }>();
  const seen = new Set<string>();
  for (const message of [...messages].sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt))) {
    const identity = `${message.senderId}:${message.msgId}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const parsedRows = parseOrchidWorkPlanCounts(message.text, message.sentAt);
    if (parsedRows[0] && message.workReportDay && orchidStemDateBounds(message.workReportDay, message.workReportDay)) {
      parsedRows[0].day = message.workReportDay;
    }
    const anchor = lastReport.get(message.senderId);
    // A standalone supplement only modifies this sender's recent actual report.
    if (!parsedRows.length && /^\s*(?:bs\b|bổ\s+(?:sung|xung))/iu.test(message.text) && anchor &&
        Date.parse(message.sentAt) - Date.parse(anchor.sentAt) <= 24 * 3600_000) {
      const total = /tổng\s*(?:cắm\s*)?(\d{1,4})\s*(?:cây|cành|c\b)/iu.exec(message.text);
      const extra = /(?:thêm|cắm)\s*(?:\d+\s*(?:đơn|₫|đ)\s*[,:(]?\s*)?(\d{1,4})\s*(?:cây|cành|c\b)/iu.exec(message.text);
      const prior = byDaySender.get(`${anchor.day}:${message.senderId}`);
      const stems = total ? Number(total[1]) : extra && prior ? prior.stems + Number(extra[1]) : 0;
      if (stems >= 1 && stems <= 1000) parsedRows.push({ day: anchor.day, stems });
    }
    for (const parsed of parsedRows) {
      lastReport.set(message.senderId, { day: parsed.day, sentAt: message.sentAt });
      if ((from && parsed.day < from) || (to && parsed.day > to)) continue;
      const key = `${parsed.day}:${message.senderId}`;
      const prior = byDaySender.get(key);
      // A different report arriving over a day later with the same header may
      // have a copied date. Preserve the existing latest-report rule, but make
      // the collision visible instead of silently hiding the earlier report.
      if (prior && prior.stems !== parsed.stems && Date.parse(message.sentAt) - Date.parse(prior.sentAt) > 24 * 3600_000) {
        nvbcReview.push({ ...message, day: parsed.day, stems: parsed.stems,
          previousStems: prior.stems, previousMsgId: prior.message.msgId });
      }
      // A later complete report is a correction; repeated copies do not add twice.
      if (!prior || Date.parse(message.sentAt) > Date.parse(prior.sentAt)) byDaySender.set(key, { stems: parsed.stems, sentAt: message.sentAt, message });
    }
  }
  const daily = report.daily.map(row => ({ ...row,
    nvbc: byDaySender.get(`${row.day}:${row.senderId}`)?.stems ?? null }));
  const names = new Map(report.monthly.map(row => [row.senderId, row.senderName]));
  const existing = new Set(daily.map(row => `${row.day}:${row.senderId}`));
  for (const [key, value] of byDaySender) {
    if (existing.has(key)) continue;
    const [day, senderId] = key.split(":");
    const senderName = names.get(senderId!);
    if (senderName) daily.push({ day: day!, senderId: senderId!, senderName,
      stems: 0, jobs: 0, nvbc: value.stems });
  }
  const monthly = report.monthly.map(row => {
    const days = daily.filter(d => d.senderId === row.senderId);
    const reported = days.filter(d => d.nvbc !== null);
    return { ...row, nvbc: reported.length ? reported.reduce((sum, d) => sum + d.nvbc!, 0) : null,
      nvbcDays: reported.length, countedDays: days.length };
  });
  const included = new Set(report.monthly.map(row => row.senderId));
  const nvbcSources = [...byDaySender].filter(([, value]) => included.has(value.message.senderId))
    .map(([key, value]) => ({ ...value.message, day: key.slice(0, 10), stems: value.stems }));
  return { ...report, daily: daily.sort((a, b) => a.day.localeCompare(b.day) || a.senderName.localeCompare(b.senderName, "vi")), monthly,
    nvbcSources, nvbcReview: nvbcReview.filter(row => included.has(row.senderId)) };
}

export function buildOrchidStemReport(messages: OrchidStemMessage[]) {
  const entries: OrchidStemEntry[] = [];
  const review: OrchidStemMessage[] = [];
  const latestCustomer = new Map<string, { name: string; at: number }>();
  const photos = new Map(messages.filter(m => m.contentType === "photo").map(m => [m.msgId, m]));
  const photosByCliId = new Map(messages.filter(m => m.contentType === "photo" && m.cliMsgId)
    .map(m => [`${m.senderId}:${m.cliMsgId}`, m]));
  const textById = new Map(messages.filter(m => m.contentType !== "photo").map(m => [m.msgId, m]));
  const textByCliId = new Map(messages.filter(m => m.contentType !== "photo" && m.cliMsgId)
    .map(m => [`${m.senderId}:${m.cliMsgId}`, m]));
  const textCorrections = new Map<string, OrchidStemMessage[]>();
  const correctionIds = new Set<string>();
  for (const message of messages) {
    const original = (message.quotedMsgId && message.quotedMsgId !== "0" ? textById.get(message.quotedMsgId) : undefined)
      ?? (message.quoteOwnerId && message.quotedCliMsgId
        ? textByCliId.get(`${message.quoteOwnerId}:${message.quotedCliMsgId}`) : undefined);
    if (original && original.msgId !== message.msgId && original.senderId === message.senderId &&
        parseOrchidStemText(original.text) && parseOrchidStemText(message.text)) {
      textCorrections.set(original.msgId, [...(textCorrections.get(original.msgId) ?? []), message]);
      correctionIds.add(message.msgId);
    }
  }
  const photoQuotes = new Map<string, Array<{ photo: OrchidStemMessage; quote: OrchidStemMessage; stems: number; customerName?: string }>>();
  for (const message of messages) {
    if (correctionIds.has(message.msgId)) continue;
    const photo = (message.quotedMsgId && message.quotedMsgId !== "0" ? photos.get(message.quotedMsgId) : undefined)
      ?? (message.quoteOwnerId && message.quotedCliMsgId
        ? photosByCliId.get(`${message.quoteOwnerId}:${message.quotedCliMsgId}`) : undefined);
    if (photo) {
      // A quote identifies the exact photo. Attribute the count to its original
      // sender, even when a colleague posts the correction with an @mention.
      const ownerMatchesPhoto = message.quoteOwnerId
        ? message.quoteOwnerId === photo.senderId
        : photo.senderId === message.senderId;
      const namedQuote = parseOrchidStemText(message.text);
      const stems = quotedPhotoQuantity(message.text, photo.senderName) ?? namedQuote?.stems;
      if (ownerMatchesPhoto && stems) {
        const candidates = photoQuotes.get(photo.msgId) ?? [];
        candidates.push({ photo, quote: message, stems, ...(namedQuote ? { customerName: namedQuote.customerName } : {}) });
        photoQuotes.set(photo.msgId, candidates);
        continue; // Count this quote only through its original photo.
      }
    }
    if (!photo && (message.quotedMsgId || message.quotedCliMsgId) && !message.originalPhotoDay) {
      // The quoted photo may have been recalled. Never turn its orphaned
      // caption into a new report on the quote's later day.
      continue;
    }
    if (message.inRange === false) continue;
    // An unnumbered photo is not a report or a customer-name hint. It becomes
    // one report only when a later quote identifies that photo and gives a count.
    if (message.contentType === "photo" && (!/\d/.test(message.text) || photoQuotes.has(message.msgId))) continue;
    const senderName = senderLabel(message.senderName);
    const source = { ...message, senderName };
    const correction = textCorrections.get(message.msgId)?.sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.msgId.localeCompare(b.msgId)).at(-1);
    let parsed = parseOrchidStemText(correction?.text ?? message.text);
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
    else if (/\d/.test(message.text) && message.text.length <= 100 &&
      !/\b(?:sinh nhật|thông báo|bc cam|báo cáo|chuyển tiếp)\b/iu.test(message.text)) review.push(source);
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
    const ordered = candidates.sort((a, b) => a.quote.sentAt.localeCompare(b.quote.sentAt) || a.quote.msgId.localeCompare(b.quote.msgId));
    const { quote, stems } = ordered.at(-1)!;
    const original = parseOrchidStemText(photo.text);
    const customerName = original?.customerName ?? ordered.findLast(x => x.customerName)?.customerName;
    const countHistory = [...(original ? [{ msgId: photo.msgId, stems: original.stems, sentAt: photo.sentAt }] : []),
      ...ordered.map(x => ({ msgId: x.quote.msgId, stems: x.stems, sentAt: x.quote.sentAt }))];
    entries.push({ ...photo, senderName: senderLabel(photo.senderName), msgId: quote.msgId, text: quote.text,
      customerName: customerName ?? stemCustomerName(photo.text) ?? "Chưa ghi tên khách", stems, day: orchidStemDay(photo.sentAt),
      quotedPhotoMsgId: photo.msgId, quoteSentAt: quote.sentAt, countHistory });
  }
  // A photo with a caption and its later correction represent one job.
  const correctedPhotos = new Set(photoQuotes.keys());
  const uniqueEntries = entries.filter(e => !(e.contentType === "photo" && !e.quotedPhotoMsgId && correctedPhotos.has(e.msgId)));
  const countedPhotoIds = new Set(uniqueEntries.filter(e => e.contentType === "photo")
    .map(e => e.quotedPhotoMsgId ?? e.msgId));
  const unnumberedPhotos = messages.filter(m => m.contentType === "photo" && m.inRange !== false &&
    !countedPhotoIds.has(m.msgId)).length;
  const daily = new Map<string, { day: string; senderId: string; senderName: string; stems: number; jobs: number }>();
  const monthly = new Map<string, { senderId: string; senderName: string; stems: number; jobs: number }>();
  for (const entry of uniqueEntries) {
    const dailyKey = `${entry.day}:${entry.senderName}`;
    const d = daily.get(dailyKey) ?? { day: entry.day, senderId: entry.senderId, senderName: entry.senderName, stems: 0, jobs: 0 };
    d.senderName = entry.senderName; d.stems += entry.stems; d.jobs++; daily.set(dailyKey, d);
    const m = monthly.get(entry.senderName) ?? { senderId: entry.senderId, senderName: entry.senderName, stems: 0, jobs: 0 };
    m.senderName = entry.senderName; m.stems += entry.stems; m.jobs++; monthly.set(entry.senderName, m);
  }
  return { entries: uniqueEntries, review, daily: [...daily.values()], monthly: [...monthly.values()], unnumberedPhotos };
}

export function combineOrchidStemReports(reports: Array<ReturnType<typeof buildOrchidStemReport>>) {
  const entries = reports.flatMap(r => r.entries);
  const review = reports.flatMap(r => r.review);
  const daily = new Map<string, (typeof reports)[number]["daily"][number]>();
  const monthly = new Map<string, (typeof reports)[number]["monthly"][number]>();
  for (const report of reports) {
    for (const row of report.daily) {
      const key = `${row.day}:${row.senderId}`;
      const prior = daily.get(key);
      daily.set(key, prior ? { ...prior, stems: prior.stems + row.stems, jobs: prior.jobs + row.jobs } : { ...row });
    }
    for (const row of report.monthly) {
      const prior = monthly.get(row.senderId);
      monthly.set(row.senderId, prior ? { ...prior, stems: prior.stems + row.stems, jobs: prior.jobs + row.jobs } : { ...row });
    }
  }
  return { entries, review, daily: [...daily.values()], monthly: [...monthly.values()],
    unnumberedPhotos: reports.reduce((sum, r) => sum + r.unnumberedPhotos, 0) };
}

export function filterOrchidStemReport(report: ReturnType<typeof addOrchidWorkPlanCounts>, sender: string) {
  if (!sender) return report;
  return {
    ...report,
    entries: report.entries.filter(x => x.senderName === sender),
    review: report.review.filter(x => x.senderName === sender),
    daily: report.daily.filter(x => x.senderName === sender),
    monthly: report.monthly.filter(x => x.senderName === sender),
    nvbcSources: report.nvbcSources.filter(x => x.senderName === sender),
    nvbcReview: report.nvbcReview.filter(x => x.senderName === sender),
  };
}

export function orchidStemWorkbook(report: ReturnType<typeof addOrchidWorkPlanCounts>,
  filter?: { from: string; to: string; sender: string; group?: string }): Buffer {
  return buildXlsx([
    ...(filter ? [{ name: "Bộ lọc", widths: [24, 36], rows: [
      ["Điều kiện", "Giá trị"], ["Từ ngày", filter.from], ["Đến ngày", filter.to],
      ["Nhân viên", filter.sender || "Tất cả"], ["Nhóm báo cáo", filter.group || "Tất cả"],
    ] }] : []),
    { name: "Chi tiết", widths: [20, 12, 25, 24, 30, 12, 48, 22, 22, 20, 34, 70, 25], rows: [
      ["Ngày", "Giờ gửi ảnh/tin gốc", "Người gửi", "UID người gửi", "Tên khách", "Số cành tính", "Tin gốc", "Mã tin Zalo", "Mã ảnh trích dẫn", "Giờ báo lại", "Ghi chú ngày tính", "Lịch sử báo và sửa số cành", "Nhóm báo cáo"],
      ...report.entries.map(e => [e.day, e.originalDayConfirmed ? "" : orchidStemTime(e.sentAt),
        e.senderName, e.senderId, e.customerName, e.stems, e.text, e.msgId, e.quotedPhotoMsgId ?? "",
        e.quoteSentAt ? new Date(e.quoteSentAt) : "", e.originalDayConfirmed ? "Chủ shop xác nhận ngày ảnh gốc" : "",
        (e.countHistory ?? []).map((h, i) => `${i + 1}. ${h.stems} cành · ${new Date(h.sentAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })} · tin ${h.msgId}`).join("; "), e.reportGroup ?? ""]),
    ] },
    { name: "Theo ngày", widths: [20, 25, 24, 16, 16, 16], rows: [
      ["Ngày", "Người gửi", "UID người gửi", "Số lượt", "Tổng cành tính", "NVBC"],
      ...report.daily.map(d => [d.day, d.senderName, d.senderId, d.jobs, d.stems, d.nvbc ?? ""]),
    ] },
    { name: "Theo nhân viên", widths: [25, 24, 16, 16, 16, 20], rows: [
      ["Người gửi", "UID người gửi", "Số lượt", "Tổng cành tính", "NVBC", "Ngày có NVBC"],
      ...report.monthly.map(m => [m.senderName, m.senderId, m.jobs, m.stems, m.nvbc ?? "", m.nvbcDays]),
    ] },
    { name: "Nguồn NVBC", widths: [18, 25, 16, 60, 24], rows: [
      ["Ngày công việc", "Người gửi", "NVBC", "Tin gốc đã tính", "Mã tin Zalo"],
      ...report.nvbcSources.map(m => [m.day, m.senderName, m.stems, m.text, m.msgId]),
    ] },
    { name: "NVBC cần đối chiếu", widths: [18, 25, 16, 16, 24, 24, 60], rows: [
      ["Ngày bị trùng", "Người gửi", "Báo cáo trước", "Báo cáo muộn", "Mã tin trước", "Mã tin muộn", "Nội dung tin muộn"],
      ...report.nvbcReview.map(m => [m.day, m.senderName, m.previousStems, m.stems, m.previousMsgId, m.msgId, m.text]),
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
  const key = `${ctx.workspaceId}:${month}`;
  const prior = refreshes.get(key) ?? Promise.resolve("");
  const next = prior.catch(() => "").then(async () => {
    const [year, mon] = month.split("-").map(Number);
    if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Tháng không hợp lệ");
    const start = new Date(Date.UTC(year!, mon! - 1, 1) - 7 * 3600_000);
    const end = new Date(Date.UTC(year!, mon!, 1) - 7 * 3600_000);
    const groups = await listOrchidStemGroups(db, ctx);
    const [reports, plans] = await Promise.all([
      Promise.all(groups.map(async group => buildOrchidStemReport((await listOrchidStemMessages(
        db, ctx, group.channelId, group.threadId, start, end)).map(m => ({ ...m, reportGroup: group.key }))))),
      listOrchidWorkPlanMessages(db, ctx, channelId, start, new Date(end.getTime() + 24 * 3600_000)),
    ]);
    const report = addOrchidWorkPlanCounts(combineOrchidStemReports(reports), plans,
      `${month}-01`, new Date(Date.UTC(year!, mon!, 0)).toISOString().slice(0, 10));
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
