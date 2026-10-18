/** Values here describe goods and charges actually agreed with the customer. */
export interface OrchidInvoiceSale {
  kind: "standard" | "driftwood";
  actualStemCount: number;
  flowerAmount: number;
  shippingFee: number;
  tallPotFee: number;
  requestedInvoicePreTax: number;
}

export interface OrchidInvoiceLine {
  itemCode: "HH00001" | "HH00002";
  itemName: "Hoa Lan Hồ Điệp";
  unitName: "Cây" | "Chậu";
  quantity: number;
  unitPrice: number;
  amountBeforeVat: number;
  vatRate: 5 | 8;
  vatAmount: number;
  totalAfterVat: number;
}

/** Never change stems or invoice value merely to fit a desired tax amount. */
export function calculateOrchidInvoiceLine(sale: OrchidInvoiceSale): OrchidInvoiceLine {
  const money = [sale.flowerAmount, sale.shippingFee, sale.tallPotFee, sale.requestedInvoicePreTax];
  if (!Number.isSafeInteger(sale.actualStemCount) || sale.actualStemCount < 1 ||
      money.some((x) => !Number.isSafeInteger(x) || x < 0) || sale.flowerAmount < 1) {
    throw new Error("Thiếu số cành hoặc số tiền thực tế đã chốt");
  }
  const amount = sale.flowerAmount + sale.shippingFee + sale.tallPotFee;
  if (!Number.isSafeInteger(amount) || amount !== sale.requestedInvoicePreTax) {
    throw new Error("Giá trị hóa đơn phải khớp hàng hóa và các khoản thực tế đã bán; không tự tăng hoặc giảm số tiền");
  }
  const driftwood = sale.kind === "driftwood";
  const quantity = driftwood ? 1 : sale.actualStemCount;
  if (!driftwood && amount / quantity > 250_000) {
    throw new Error("Đơn giá vượt 250.000đ/cành; cần nhân viên/kế toán kiểm tra cách ghi đúng hàng đã bán");
  }
  if (amount % quantity !== 0) {
    throw new Error("Không chia được đơn giá nguyên đồng theo số cành thực tế; cần kiểm tra cách ghi hóa đơn");
  }
  const vatRate = driftwood ? 8 : 5;
  const vatAmount = Math.round(amount * vatRate / 100);
  return {
    itemCode: driftwood ? "HH00002" : "HH00001",
    itemName: "Hoa Lan Hồ Điệp",
    unitName: driftwood ? "Chậu" : "Cây",
    quantity, unitPrice: amount / quantity, amountBeforeVat: amount,
    vatRate, vatAmount, totalAfterVat: amount + vatAmount,
  };
}
