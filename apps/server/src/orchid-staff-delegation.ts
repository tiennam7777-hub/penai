import type { InboxMessageRow } from "@penai/db";

export const ORCHID_SALES_AGENT_ID = "178559ba-3cf6-4624-bc93-bb84af2a9b7f";
export const ORCHID_SALES_CHANNEL_IDS = new Set([
  "cdf2a276-fa3d-4fe3-a46b-3ce1162a7678", // Hot 1
  "657116ed-7570-4f2e-8550-a3d323618724", // Hot 4
  "6bc2dc02-3d10-4737-931d-a37532bcabb2", // Hot 6
]);

/** -ld chỉ nhận việc từ tin nhân viên cuối cùng, trước khi khách/AI nhắn thêm. */
export function latestDelegableStaffMessage(messages: InboxMessageRow[]): string | null {
  const latest = messages.at(-1);
  if (!latest || latest.direction !== "out" || !["web", "app", "mcp"].includes(latest.source) ||
      latest.removed || !latest.text.trim() || latest.text.trim().toLowerCase() === "-ld") return null;
  return latest.text.trim();
}

export function expectsCurrentColorPhotos(message: string): boolean {
  const text = message.toLocaleLowerCase("vi");
  return /(?:gửi|gửi|gui)\b.*(?:màu|mau)/u.test(text) && /(?:đang có|hiện có|sẵn có|lựa|chọn)/u.test(text);
}
