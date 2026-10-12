import { describe, expect, it } from "vitest";
import { hasPersonalAddressMismatch, requiresPersonalAddressGuard } from "../src/persona-reply-guard.js";

describe("giữ đúng vai anh nói với em", () => {
  it("chặn các câu đảo vai trong hội thoại thực tế", () => {
    expect(requiresPersonalAddressGuard("anh", "em")).toBe(true);
    for (const text of [
      "Dạ em.",
      "Dạ, có phản hồi từ khách em báo anh nhé.",
      "Dạ mấy hình đó là mẫu tham khảo, bên em sẽ ghép chậu.",
      "Em sẽ kiểm tra hoa rồi báo anh.",
      "😊 Dạ em.",
      "Em cảm ơn anh.",
    ]) {
      expect(hasPersonalAddressMismatch(text, "anh", "em")).toBe(true);
    }
  });

  it("giữ câu đúng vai và không áp luật này cho hồ sơ khác", () => {
    expect(hasPersonalAddressMismatch("Ừ em, khách chọn mẫu nào thì báo anh nhé.", "anh", "em")).toBe(false);
    expect(hasPersonalAddressMismatch("Anh kiểm tra hoa rồi báo em.", "anh", "em")).toBe(false);
    expect(hasPersonalAddressMismatch("Anh làm màu đó cho em. Chậu 8 cành giá 1.600.000đ. Em gửi Anh địa chỉ giao nhé.", "anh", "em")).toBe(false);
    expect(hasPersonalAddressMismatch("Dạ, em sẽ kiểm tra.", "em", "anh")).toBe(false);
  });
});
