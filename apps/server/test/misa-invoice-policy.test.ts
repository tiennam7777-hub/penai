import { describe, expect, it } from "vitest";
import { calculateOrchidInvoiceLine } from "../src/misa-invoice-policy.js";

describe("Orchid invoice rules", () => {
  it("includes real shipping and pot charges at five percent without changing stems", () => {
    expect(calculateOrchidInvoiceLine({ kind: "standard", actualStemCount: 5,
      flowerAmount: 1_000_000, shippingFee: 100_000, tallPotFee: 100_000,
      requestedInvoicePreTax: 1_200_000 })).toMatchObject({
      itemCode: "HH00001", unitName: "Cây", quantity: 5, unitPrice: 240_000,
      vatRate: 5, vatAmount: 60_000, totalAfterVat: 1_260_000,
    });
  });

  it("uses one real driftwood pot at eight percent", () => {
    expect(calculateOrchidInvoiceLine({ kind: "driftwood", actualStemCount: 5,
      flowerAmount: 1_250_000, shippingFee: 0, tallPotFee: 0,
      requestedInvoicePreTax: 1_250_000 })).toMatchObject({
      itemCode: "HH00002", unitName: "Chậu", quantity: 1, unitPrice: 1_250_000,
      vatRate: 8, vatAmount: 100_000,
    });
  });

  it("rejects a higher invoice amount without a matching real sale", () => {
    expect(() => calculateOrchidInvoiceLine({ kind: "standard", actualStemCount: 5,
      flowerAmount: 1_000_000, shippingFee: 0, tallPotFee: 0,
      requestedInvoicePreTax: 1_800_000 })).toThrow("khớp");
  });

  it("does not invent stems to lower a unit price", () => {
    expect(() => calculateOrchidInvoiceLine({ kind: "standard", actualStemCount: 5,
      flowerAmount: 1_500_000, shippingFee: 0, tallPotFee: 0,
      requestedInvoicePreTax: 1_500_000 })).toThrow("250.000");
  });
});
