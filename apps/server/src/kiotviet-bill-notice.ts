export function kiotVietBillNotice(action: "create" | "update", code: string, customer: string): string {
  const name = customer.replace(/[\r\n]+/g, " ").trim();
  return `${action === "create" ? "Đã lên Phiếu Đặt Hàng" : "Đã cập nhật bill Đặt Hàng"} ${code} cho ${name}`;
}
