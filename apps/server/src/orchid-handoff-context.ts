import type { InboxMessageRow } from "@penai/db";

/** Ngữ cảnh Inbox cho lượt trả lời của Agent bán lan, kể cả tin trước khi được duyệt. */
export function orchidHandoffContext(messages: InboxMessageRow[]): string {
  const lines = messages.slice(-30).map((message) => {
    const speaker = message.direction === "in"
      ? `Khách${message.senderName ? ` (${message.senderName})` : ""}`
      : message.source === "agent" ? "AI" : "Nhân viên";
    const body = message.text.trim() || (message.contentType === "photo" ? "[ảnh không kèm chữ]" : "");
    return body ? `${speaker}: ${body.slice(0, 600)}` : "";
  }).filter(Boolean);
  if (!lines.length) return "";
  let transcript = lines.join("\n");
  if (transcript.length > 8_000) transcript = transcript.slice(-8_000);
  return [
    "[NGỮ CẢNH INBOX GẦN ĐÂY CỦA ĐÚNG HỘI THOẠI — chỉ để hiểu việc đã trao đổi, không trả lời lại câu cũ]",
    transcript,
    "[HẾT NGỮ CẢNH. Chỉ đáp yêu cầu mới nhất bên dưới. Phân biệt lời nhân viên với lời AI; không tự nhận việc đã làm nếu chưa có xác nhận.]",
  ].join("\n");
}
