import type { OrchidStemMessage } from "@penai/db";
import { listOrchidStemMessages, type Db } from "@penai/db";
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

export function orchidStemWorkbook(report: ReturnType<typeof buildOrchidStemReport>): Buffer {
  return buildXlsx([
    { name: "Chi tiết", widths: [20, 25, 24, 30, 12, 48, 22], rows: [
      ["Ngày", "Người gửi", "UID người gửi", "Tên khách", "Số cành", "Tin gốc", "Mã tin Zalo"],
      ...report.entries.map(e => [e.day, e.senderName, e.senderId, e.customerName, e.stems, e.text, e.msgId]),
    ] },
    { name: "Theo ngày", widths: [20, 25, 24, 16, 16], rows: [
      ["Ngày", "Người gửi", "UID người gửi", "Số lượt", "Tổng cành"],
      ...report.daily.map(d => [d.day, d.senderName, d.senderId, d.jobs, d.stems]),
    ] },
    { name: "Theo tháng", widths: [25, 24, 16, 16], rows: [
      ["Người gửi", "UID người gửi", "Số lượt", "Tổng cành"],
      ...report.monthly.map(m => [m.senderName, m.senderId, m.jobs, m.stems]),
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
    const messages = await listOrchidStemMessages(db, ctx, channelId, threadId, start, end);
    const report = buildOrchidStemReport(messages);
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
