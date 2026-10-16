import { describe, expect, it } from "vitest";
import type { InboxMessageRow } from "@penai/db";
import { orchidCompanyPaymentContext } from "../src/orchid-payment-context.js";

const message = (direction: "in" | "out", text: string) => ({ direction, text }) as InboxMessageRow;

describe("orchid company payment context", () => {
  it("adds flower and shipping, then 5% VAT on their sum", () => {
    const context = orchidCompanyPaymentContext([
      message("in", "Cho em 10 cành tím giá bao nhiêu"),
      message("out", "Chậu tím 10 cành giá 2.000.000đ, chưa gồm VAT 5%. Phí ship 180.000đ."),
      message("in", "Ok cho e so tai khoan"),
    ]);
    expect(context).toContain("2.180.000đ tiền mặt");
    expect(context).toContain("2.289.000đ đã gồm VAT");
  });

  it("does not reuse a quote from before /new or add VAT twice", () => {
    expect(orchidCompanyPaymentContext([
      message("out", "Chậu 10 cành giá 2.000.000đ, chưa gồm VAT 5%."),
      message("in", "/new"),
      message("in", "Cho số tài khoản"),
    ])).toBe("");
    expect(orchidCompanyPaymentContext([
      message("out", "Chậu 10 cành giá 2.100.000đ, đã gồm VAT 5%."),
      message("in", "Cho số tài khoản"),
    ])).toBe("");
  });

  it("does not invent a total if shipping has not been quoted", () => {
    expect(orchidCompanyPaymentContext([
      message("out", "Chậu 10 cành giá 2.000.000đ, chưa gồm VAT 5%."),
      message("in", "Cho số tài khoản"),
    ])).toContain("chưa có phí ship chắc chắn");
  });
});
