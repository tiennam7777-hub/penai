import type { OrchidStemMessage } from "@penai/db";
import { listOrchidQualityMessages, type Db } from "@penai/db";
import type { WorkspaceContext } from "@penai/shared";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { orchidStemDay } from "./orchid-stem-report.js";
import { sharedDirFor } from "./library-paths.js";
import { buildXlsx } from "./xlsx.js";

export const qualitySearchText = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/giu, "d").toLowerCase();
type Counts = { total: number | null; bad: number; twoBranch: number; unknown: number };
export function parseOrchidQuality(text: string) {
  const original = text.normalize("NFC").trim();
  const n = qualitySearchText(original);
  const customerStart = /\b(?:chau|don|done|khach|shop)\b/u.exec(n);
  // Parentheses containing names (rather than a count/type) delimit the order description.
  const nameParen = [...n.matchAll(/\(([^()]*)\)/gu)].find(m => {
    const rest = m[1]!.replace(/\b\d+\s*(?:canh|cay|c|voi|v|nhanh)?\b/gu, "")
      .replace(/\b(?:xau|hu|het|ht|chay|thui|nu|goc|hoa|tot)\b/gu, "");
    return /[a-z]/u.test(rest);
  });
  const firstCount = /\b\d{1,3}\s*(?:canh|cay|c)(?![a-z])/u.exec(n);
  const prefixCustomer = customerStart && /^(?:shop|khach)$/u.test(customerStart[0]) &&
    firstCount && customerStart.index < firstCount.index ? original.slice(0, firstCount.index).trim() : "";
  const cut = prefixCustomer ? n.length : Math.min(customerStart?.index ?? n.length, nameParen?.index ?? n.length);
  const scope = n.slice(0, cut);
  let quantities = [...scope.matchAll(/\b(\d{1,3})\s*(?:canh|cay|c)(?![a-z])|\b(\d{1,3})\s*(?=xau\b)/gu)];
  let conflict = false;
  if (quantities.length > 1 && /^\s*\(/u.test(scope.slice(quantities[0]!.index! + quantities[0]![0].length))) {
    // "5c (2c 2v, 3c hết nụ)": the leading number is a subtotal.
    const sum = quantities.slice(1).reduce((s, m) => s + Number(m[1] || m[2]), 0);
    if (sum === Number(quantities[0]![1] || quantities[0]![2])) quantities = quantities.slice(1);
    else conflict = true;
  }
  const counts: Counts = { total: null, bad: 0, twoBranch: 0, unknown: 0 };
  if (quantities.length && !conflict) {
    counts.total = 0;
    quantities.forEach((m, i) => {
      const amount = Number(m[1] || m[2]);
      const tail = scope.slice(m.index! + m[0].length, quantities[i + 1]?.index ?? scope.length);
      counts.total! += amount;
      const two = /\b2\s*(?:v|voi|nhanh)\b/u.test(tail);
      const bad = /\b(?:xau|hu|het\s*nu|ht\s*nu|chay\s*nu|thui)\b/u.test(tail);
      if (two && !bad) counts.twoBranch += amount;
      else if (bad && !two) counts.bad += amount;
      else counts.unknown += amount;
    });
  }
  let customer = prefixCustomer || original.slice(cut).replace(/^[\s(,.;]+|[\s),.;]+$/gu, "").trim();
  if (!customer && quantities.length === 1) {
    const m = quantities[0]!;
    const trailing = original.slice(m.index! + m[0].length);
    const rest = qualitySearchText(trailing).replace(/\b2\s*(?:v|voi|nhanh)\b/gu, "")
      .replace(/\b(?:xau|hu|het|ht|chay|thui|nu|goc|hoa|tot|xanh|tao|vang|hong)\b/gu, "")
      .replace(/^[\s(),.;]+|[\s(),.;]+$/gu, "").trim();
    if (/[a-z]/u.test(rest)) {
      // Keep the original spelling of a trailing customer name.
      const offset = qualitySearchText(trailing).indexOf(rest);
      if (offset >= 0) customer = trailing.slice(offset).replace(/[\s),.;]+$/gu, "");
    }
  }
  const customerText = qualitySearchText(customer);
  const pot = /\bchau\s*(\d{1,3})\b/u.exec(customerText) ?? /\b(\d{1,3})\s*(?:canh|c)\b/u.exec(customerText);
  return { ...counts, customerName: customer || "Chưa ghi khách", potStems: pot ? Number(pot[1]) : null,
    note: [conflict ? "Tổng và chi tiết không khớp" : counts.total === null ? "Chưa rõ số lượng" : "",
      counts.unknown ? "Chưa rõ loại" : "", !customer ? "Chưa ghi khách" : ""].filter(Boolean).join("; ") };
}

export function buildOrchidQualityReport(messages: OrchidStemMessage[], from: string, to: string, search = "", sender = "") {
  const unique = new Map<string, OrchidStemMessage>();
  for (const message of messages) unique.set(message.msgId, message);
  // Explicit quoted corrections replace their source, keeping its date and customer.
  const replacements = new Map<string, OrchidStemMessage>();
  for (const message of [...unique.values()].sort((a, b) => a.sentAt.localeCompare(b.sentAt))) {
    if (!message.text.trim() || !/\b(?:sua|dinh chinh|bao lai)\b/u.test(qualitySearchText(message.text))) continue;
    const target = unique.get(message.quotedMsgId ?? "") ?? [...unique.values()].find(x =>
      !!message.quotedCliMsgId && x.cliMsgId === message.quotedCliMsgId);
    if (target && parseOrchidQuality(message.text).total !== null) replacements.set(target.msgId, message);
  }
  const correctionIds = new Set([...replacements.values()].map(x => x.msgId));
  const rows = [...unique.values()].filter(m => !correctionIds.has(m.msgId) && m.text.trim()).map(m => {
    const correction = replacements.get(m.msgId);
    const parsed = parseOrchidQuality(correction?.text ?? m.text);
    const original = parseOrchidQuality(m.text);
    if (correction && parsed.customerName === "Chưa ghi khách") {
      parsed.customerName = original.customerName; parsed.potStems = original.potStems;
      parsed.note = parsed.note.replace(/;?\s*Chưa ghi khách/u, "");
    }
    return { ...m, ...parsed, day: orchidStemDay(m.sentAt), text: correction ? `${m.text}\n[Sửa] ${correction.text}` : m.text };
  }).filter(m => m.day >= from && m.day <= to);
  const q = qualitySearchText(search.trim());
  const senders = [...new Set(rows.map(r => r.senderName))].sort((a, b) => a.localeCompare(b, "vi"));
  const entries = rows.filter(r => (!sender || r.senderName === sender) && (!q || qualitySearchText([r.customerName, r.senderName, r.text, r.total,
    r.potStems, r.bad, r.twoBranch, r.note].join(" ")).includes(q)))
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt) || b.msgId.localeCompare(a.msgId));
  const totals = { total: 0, bad: 0, twoBranch: 0, unknown: 0, reports: entries.length, review: 0 };
  const people = new Map<string, { senderName: string; total: number; bad: number; twoBranch: number; unknown: number; reports: number; review: number }>();
  for (const r of entries) {
    totals.total += r.total ?? 0; totals.bad += r.bad; totals.twoBranch += r.twoBranch;
    totals.unknown += r.unknown; if (r.note) totals.review++;
    const person = people.get(r.senderName) ?? { senderName: r.senderName, total: 0, bad: 0, twoBranch: 0, unknown: 0, reports: 0, review: 0 };
    person.total += r.total ?? 0; person.bad += r.bad; person.twoBranch += r.twoBranch;
    person.unknown += r.unknown; person.reports++; if (r.note) person.review++;
    people.set(r.senderName, person);
  }
  const monthly = [...people.values()].sort((a, b) => b.bad - a.bad || b.twoBranch - a.twoBranch || a.senderName.localeCompare(b.senderName, "vi"));
  return { entries, totals, monthly, senders, sender, uncaptionedMedia: [...unique.values()].filter(m => m.inRange !== false &&
    !m.text.trim() && ["photo", "video"].includes(m.contentType ?? "")).length };
}

export function orchidQualityWorkbook(report: ReturnType<typeof buildOrchidQualityReport>, month: string, search = "") {
  return buildXlsx([
    { name: "Tổng hợp tháng", widths: [38, 65], rows: [["Chỉ tiêu", "Giá trị"], ["Tháng", month],
      ["Nhóm nguồn", "Di Hoa Xau - Nhet Cay 2 nhanh"], ["Tìm kiếm", search || "Tất cả"],
      ["Nhân viên", report.sender || "Tất cả nhân viên"],
      ["Tổng cây/cành đã ghi số", report.totals.total], ["Hoa xấu", report.totals.bad],
      ["Cây 2 nhánh", report.totals.twoBranch], ["Chưa rõ loại", report.totals.unknown],
      ["Tin cần kiểm tra", report.totals.review], ["Ảnh/video không chú thích (không tự đếm)", report.uncaptionedMedia],
      ["Cách tính", "Theo ngày gửi tại Việt Nam; gộp mọi nhân viên, không chia chi nhánh. Số cành chậu khách không cộng vào số cây đã dùng. Không suy số từ ảnh."] ] },
    { name: "Chi tiết", widths: [22, 27, 40, 16, 16, 16, 16, 16, 35, 75, 24], rows: [
      ["Ngày giờ", "Nhân viên", "Chậu / khách", "Số cành chậu", "Cây/cành đã dùng", "Hoa xấu", "Cây 2 nhánh", "Chưa rõ loại", "Cần kiểm tra", "Tin gốc", "Mã tin"],
      ...report.entries.map(r => [new Date(r.sentAt), r.senderName, r.customerName, r.potStems,
        r.total, r.bad, r.twoBranch, r.unknown, r.note, r.text, r.msgId]),
    ] },
    { name: "Theo nhân viên", widths: [30, 18, 18, 18, 18, 18, 24], rows: [
      ["Nhân viên", "Hoa xấu", "Cây 2 nhánh", "Chưa rõ loại", "Tổng cây/cành", "Số tin", "Tin cần kiểm tra"],
      ...report.monthly.map(r => [r.senderName, r.bad, r.twoBranch, r.unknown, r.total, r.reports, r.review]),
    ] },
  ]);
}

export async function saveOrchidQualityWorkbook(dataDir: string, workspaceId: string, month: string, bytes: Buffer) {
  const dir = join(sharedDirFor(dataDir, workspaceId), "di-hoa-xau-cay-2-nhanh");
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  await writeFile(temp, bytes);
  await rename(temp, join(dir, `di-hoa-xau-cay-2-nhanh-${month}.xlsx`));
}

const refreshes = new Map<string, Promise<void>>();
export function refreshOrchidQualityFile(db: Db, ctx: WorkspaceContext, month: string, dataDir: string): Promise<void> {
  const key = `${ctx.workspaceId}:${month}`;
  const next = (refreshes.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Tháng không hợp lệ");
    const [year, mon] = month.split("-").map(Number);
    const from = month + "-01", to = new Date(Date.UTC(year!, mon!, 0)).toISOString().slice(0, 10);
    const source = await listOrchidQualityMessages(db, ctx,
      new Date(`${from}T00:00:00+07:00`), new Date(Date.UTC(year!, mon!, 1) - 7 * 3600_000));
    if (!source.found) return;
    await saveOrchidQualityWorkbook(dataDir, ctx.workspaceId, month,
      orchidQualityWorkbook(buildOrchidQualityReport(source.messages, from, to), month));
  });
  refreshes.set(key, next);
  void next.finally(() => { if (refreshes.get(key) === next) refreshes.delete(key); }).catch(() => {});
  return next;
}
