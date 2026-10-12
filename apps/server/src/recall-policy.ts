/** Sau khi nhân viên thu hồi tin AI, chỉ câu hỏi hoặc yêu cầu mới của khách được mở lại AI. */
export function isFreshCustomerRequest(raw: string): boolean {
  const text = raw.trim().toLocaleLowerCase("vi")
    .replace(/^(?:(?:dạ|vâng|ừ|ok|oke|okay)\s*[,!.]?\s*)+/iu, "")
    .trim();
  if (!text || /^(?:ạ|anh|chị|em|nha|nhé|rồi|được|cảm ơn|thanks|thank you)[.!]*$/iu.test(text)) return false;
  if (/[?？]/u.test(text)) return true;
  if (text.split(/\s+/u).length > 1 && /(?:không|chưa)(?:[?.!]|$)/iu.test(text)) return true;
  if (/(?:^|\s)(?:gì|sao|bao nhiêu|mấy|nào|đâu|khi nào|được không|có không)(?=\s|[,.!]|$)/iu.test(text)) return true;
  return /^(?:(?:anh|chị|shop|bên anh|bên chị)\s+)?(?:cho|gửi|báo|kiểm tra|xem|tư vấn|làm|đổi|sửa|đặt|hỏi|muốn|cần|nhờ|giúp|xin|giá)(?=\s|[,.!]|$)/iu.test(text);
}
