import { describe, expect, it } from "vitest";
import type { InboxMessageRow } from "@penai/db";
import { orchidCompanyPaymentContext } from "../src/orchid-payment-context.js";

const message = (direction: "in" | "out", text: string) => ({ direction, text }) as InboxMessageRow;

describe("orchid company payment context", () => {
  it("uses the latest flower quote and adds 5% VAT without shipping", () => {
    const context = orchidCompanyPaymentContext([
      message("in", "Cho em 10 cành tím giá bao nhiêu"),
      message("out", "Chậu tím 10 cành giá 2.000.000đ, chưa gồm VAT 5%. Phí ship 180.000đ."),
      message("in", "Ok cho e so tai khoan"),
    ]);
    expect(context).toContain("2.100.000đ luôn VAT");
    expect(context).toContain("không cộng phí ship");
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
});
