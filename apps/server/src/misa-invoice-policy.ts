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
  // Use the shortest decimal unit price whose extended amount rounds to the
  // agreed whole-VND line amount.
  let unitPrice = amount / quantity;
  for (let digits = 0; digits <= 6; digits++) {
    const scale = 10 ** digits;
    const candidate = Math.round(unitPrice * scale) / scale;
    if (Math.round(candidate * quantity) === amount) {
      unitPrice = candidate;
      break;
    }
    if (digits === 6) throw new Error("Không thể biểu diễn đơn giá với độ chính xác MISA hỗ trợ");
  }
  const vatRate = driftwood ? 8 : 5;
  const vatAmount = Math.round(amount * vatRate / 100);
  return {
    itemCode: driftwood ? "HH00002" : "HH00001",
    itemName: "Hoa Lan Hồ Điệp",
    unitName: driftwood ? "Chậu" : "Cây",
    quantity, unitPrice, amountBeforeVat: amount,
    vatRate, vatAmount, totalAfterVat: amount + vatAmount,
  };
}
