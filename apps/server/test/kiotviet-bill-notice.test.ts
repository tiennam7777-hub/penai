import { describe, expect, it } from "vitest";
import { kiotVietBillNotice } from "../src/kiotviet-bill-notice.js";

describe("KiotViet bill group notice", () => {
  it("sends only the slip number and chat customer name for both actions", () => {
    expect(kiotVietBillNotice("create", "DH081864", "Anh Nam ca nhan"))
      .toBe("Đã lên Phiếu Đặt Hàng DH081864 cho Anh Nam ca nhan");
    expect(kiotVietBillNotice("update", "DH081864", "Anh Nam ca nhan"))
      .toBe("Đã cập nhật bill Đặt Hàng DH081864 cho Anh Nam ca nhan");
  });
});
