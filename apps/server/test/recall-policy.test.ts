import { describe, expect, it } from "vitest";
import { isFreshCustomerRequest } from "../src/recall-policy.js";

describe("chờ khách hỏi lại sau khi thu hồi tin Agent", () => {
  it("bỏ qua xác nhận, sticker và câu kể không có yêu cầu", () => {
    for (const text of ["", "Dạ", "Dạ oke a", "Dạ không", "Ok anh", "Cảm ơn", "[Sticker]", "Em mới gửi khách", "Mẫu này đẹp"]) {
      expect(isFreshCustomerRequest(text)).toBe(false);
    }
  });
  it("mở lại cho câu hỏi hoặc yêu cầu mới", () => {
    for (const text of ["Mẫu này giá bao nhiêu?", "Dạ cho em hỏi giá mẫu này", "Anh gửi em mẫu mới", "Kiểm tra đơn giúp em", "Có mẫu khác không"]) {
      expect(isFreshCustomerRequest(text)).toBe(true);
    }
  });
});
