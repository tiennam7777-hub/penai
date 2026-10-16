import { z } from "zod";
import type { ToolHandler } from "../registry.js";

const schema = z.object({
  customerType: z.enum(["retail", "wholesale"]).describe("Loại khách: retail = khách lẻ, wholesale = khách sỉ."),
  stemCount: z.number().int().min(1).describe("Số cành trong một chậu cần giao."),
  distanceKm: z.number().positive().max(500).describe("Số km đi đường bộ từ 42 Điện Biên Phủ, P. Tân Định, TP.HCM đến điểm giao; phải lấy từ tuyến đường đã xác định, không dùng khoảng cách đường chim bay."),
});

export type OrchidShippingInput = z.infer<typeof schema>;

export type OrchidShippingQuote =
  | { kind: "manual"; reason: string }
  | { kind: "quote"; feeVnd: number; rawVnd: number; vehicle: "xe máy" | "xe hơi" | "xe bán tải"; free: boolean };

/** Quy tắc phí ship riêng của Orchids World; làm tròn xuống có lợi cho khách. */
export function calculateOrchidShipping(input: OrchidShippingInput): OrchidShippingQuote {
  const { customerType, stemCount, distanceKm } = schema.parse(input);
  if (customerType === "retail" && stemCount < 3) {
    return { kind: "manual", reason: "Chưa có quy tắc phí ship khách lẻ cho chậu 1–2 cành; chuyển nhân viên báo giá." };
  }
  let rawVnd: number;
  let vehicle: "xe máy" | "xe hơi" | "xe bán tải";
  if (customerType === "retail") {
    if (stemCount > 35) {
      vehicle = "xe hơi";
      rawVnd = Math.max(distanceKm * 25_000, 200_000);
    } else if (distanceKm < 8) {
      return { kind: "quote", feeVnd: 0, rawVnd: 0, vehicle: "xe máy", free: true };
    } else {
      vehicle = "xe máy";
      rawVnd = distanceKm * 7_500 + (stemCount >= 16 ? 20_000 : 0);
    }
  } else if (stemCount > 35) {
    vehicle = "xe bán tải";
    rawVnd = Math.max(distanceKm * 25_000, 250_000);
  } else if (stemCount >= 16) {
    vehicle = "xe máy";
    rawVnd = Math.max(distanceKm * 8_000 + 40_000, 100_000);
  } else {
    vehicle = "xe máy";
    rawVnd = Math.max(distanceKm * 8_000, 20_000);
  }
  const step = customerType === "retail" ? 10_000 : 5_000;
  return { kind: "quote", feeVnd: Math.floor(rawVnd / step) * step, rawVnd, vehicle, free: false };
}

export const orchidShippingTool: ToolHandler<typeof schema> = {
  name: "orchid_shipping_quote",
  description: "Tính phí giao chậu lan Orchids World từ 42 Điện Biên Phủ theo loại khách, số cành và số km đường bộ đã xác định. Không tự tra đường hoặc đoán km.",
  schema,
  async execute(args) {
    const quote = calculateOrchidShipping(args);
    if (quote.kind === "manual") return quote.reason;
    const money = (value: number) => new Intl.NumberFormat("vi-VN").format(value) + "đ";
    return `Phí ship là ${money(quote.feeVnd)}. (${args.distanceKm} km; ${args.stemCount} cành; ${args.customerType === "retail" ? "khách lẻ" : "khách sỉ"}; ${quote.vehicle}${quote.free ? "; miễn phí theo bán kính" : ""}).`;
  },
};
