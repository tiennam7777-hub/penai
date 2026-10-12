/** Chặn các câu chắc chắn đảo vai khi hồ sơ đặt AI xưng anh/chị với người được gọi là em. */
export function requiresPersonalAddressGuard(selfAddress: string | null | undefined, addressAs: string | null | undefined): boolean {
  const self = selfAddress?.trim().toLocaleLowerCase("vi") ?? "";
  const other = addressAs?.trim().toLocaleLowerCase("vi") ?? "";
  return /^(anh|chị)(?:\s|$)/u.test(self) && /^em(?:\s|$)/u.test(other);
}

export function hasPersonalAddressMismatch(text: string, selfAddress: string | null | undefined, addressAs: string | null | undefined): boolean {
  if (!requiresPersonalAddressGuard(selfAddress, addressAs)) return false;
  const reply = text.trim();
  return /^[\s\p{P}\p{S}]*(?:dạ|vâng)(?:\s|[,.:;!?]|$)/iu.test(reply) ||
    /\b(?:bên|tụi|chúng)\s+em\b/iu.test(reply) ||
    // Chỉ chặn khi cả câu mở đầu bằng vai "em". Trong câu đúng vai
    // "Anh báo em. Em gửi Anh địa chỉ nhé", "Em gửi" là lời nhờ khách,
    // không phải AI tự xưng em.
    /^[\s\p{P}\p{S}]*(?:em|e)\s+(?:sẽ|xin|đã|đang|vừa|gửi|báo|kiểm\s+tra|làm|hỗ\s+trợ|giúp|cảm\s+ơn|xác\s+nhận|nhận|thấy|nghĩ|hiểu|hỏi|chờ)(?=\s|[,.:;!?]|$)/iu.test(reply);
}
