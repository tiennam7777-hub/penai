import type { InboxMessageRow } from "@penai/db";

export const ORCHID_SALES_AGENT_ID = "178559ba-3cf6-4624-bc93-bb84af2a9b7f";
export const ORCHID_SALES_CHANNEL_IDS = new Set([
  "cdf2a276-fa3d-4fe3-a46b-3ce1162a7678", // Hot 1
  "657116ed-7570-4f2e-8550-a3d323618724", // Hot 4
  "6bc2dc02-3d10-4737-931d-a37532bcabb2", // Hot 6
]);

/** Bỏ qua mã lệnh cũ đã lỡ gửi từ điện thoại; khách/AI nhắn sau lời hứa vẫn chặn. */
export function latestDelegableStaffRow(messages: InboxMessageRow[]): InboxMessageRow | null {
  let index = messages.length - 1;
  while (index >= 0 && messages[index]?.direction === "out" && messages[index]?.source === "app" &&
      /^[-/]ld$/i.test(messages[index]!.text.trim())) index--;
  const latest = messages[index];
  if (!latest || latest.direction !== "out" || !["web", "app", "mcp"].includes(latest.source) ||
      latest.removed || !latest.text.trim() || /^[-/]ld$/i.test(latest.text.trim())) return null;
  return latest;
}

export function latestDelegableStaffMessage(messages: InboxMessageRow[]): string | null {
  return latestDelegableStaffRow(messages)?.text.trim() ?? null;
}

export function expectsCurrentColorPhotos(message: string): boolean {
  const text = message.toLocaleLowerCase("vi");
  return /(?:gửi|gửi|gui)\b.*(?:màu|mau)/u.test(text) && /(?:đang có|hiện có|sẵn có|lựa|chọn)/u.test(text);
}

/** Đọc cả câu không dấu từ Zalo: "A gui e mau chau 8 canh nha". */
export function promisedPotStemCount(message: string): number | null {
  const text = message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase();
  if (!/\b(gui|cho xem)\b/.test(text) || !/\b(mau|hinh|anh)\b/.test(text) || !/\bchau\b/.test(text)) return null;
  const count = /\bchau\s+(\d{1,2})\s+canh\b/.exec(text)?.[1];
  return count ? Number(count) : null;
}
