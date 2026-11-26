import { z } from "zod";
import type { ToolHandler } from "../registry.js";

const schema = z.object({
  customerType: z.enum(["retail", "wholesale"]).describe("Loại khách: retail = khách lẻ, wholesale = khách sỉ."),
  stemCount: z.number().int().min(1).describe("Số cành trong một chậu cần giao."),
  distanceKm: z.number().positive().max(500).optional().describe("Chỉ truyền nếu số km đường bộ đã được xác minh; nếu chưa biết, truyền destination để hệ thống tự tra bản đồ."),
  destination: z.string().trim().min(5).max(400).optional().describe("Địa chỉ giao cụ thể khách đã cho. Truyền địa chỉ để tự tra số km đường bộ và tính ship; không tự đoán km."),
});

export type OrchidShippingInput = z.infer<typeof schema>;
export type OrchidShippingPolicy = { retailPerKm: number; wholesalePerKm: number; wholesaleExtra: number };
const DEFAULT_POLICY: OrchidShippingPolicy = { retailPerKm: 7500, wholesalePerKm: 8000, wholesaleExtra: 20000 };

/** Read the owning Agent's current tariff rather than a stale hard-coded copy. */
export function orchidShippingPolicyFromPrompt(prompt: string): OrchidShippingPolicy {
  const text = prompt.slice(prompt.lastIndexOf("QUY TẮC PHÍ SHIP ORCHIDS WORLD ("));
  const amount = (value?: string) => Number(value?.replace(/[.,\s]/g, ""));
  const retail = text.match(/chậu 3[–-]15 cành tính\s+([\d.,]+)đ\/km/i);
  const wholesale = text.match(/Chậu 1[–-]15 cành tính\s+([\d.,]+)đ\/km/i);
  const extra = text.slice(text.indexOf("Khách sỉ:")).match(/Chậu 16[–-]35 cành tính\s+[\d.,]+đ\/km\s*\+\s*([\d.,]+)đ/i);
  const checked = (n: number, fallback: number) => Number.isFinite(n) && n >= 1000 && n <= 100000 ? n : fallback;
  return { retailPerKm: checked(amount(retail?.[1]), DEFAULT_POLICY.retailPerKm),
    wholesalePerKm: checked(amount(wholesale?.[1]), DEFAULT_POLICY.wholesalePerKm),
    wholesaleExtra: checked(amount(extra?.[1]), DEFAULT_POLICY.wholesaleExtra) };
}

export type OrchidShippingQuote =
  | { kind: "manual"; reason: string }
  | { kind: "quote"; feeVnd: number; rawVnd: number; vehicle: "xe máy" | "xe hơi" | "xe bán tải"; free: boolean };

/** Quy tắc phí ship riêng của Orchids World; làm tròn xuống có lợi cho khách. */
export function calculateOrchidShipping(input: OrchidShippingInput, policy = DEFAULT_POLICY): OrchidShippingQuote {
  const { customerType, stemCount, distanceKm } = schema.parse(input);
  if (distanceKm === undefined) throw new Error("Cần số km đường bộ đã xác minh hoặc tra bản đồ bằng địa chỉ giao.");
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
      rawVnd = distanceKm * policy.retailPerKm + (stemCount >= 16 ? 20_000 : 0);
    }
  } else if (stemCount > 35) {
    vehicle = "xe bán tải";
    rawVnd = Math.max(distanceKm * 25_000, 250_000);
  } else if (stemCount >= 16) {
    vehicle = "xe máy";
    rawVnd = Math.max(distanceKm * policy.wholesalePerKm + policy.wholesaleExtra, 100_000);
  } else {
    vehicle = "xe máy";
    rawVnd = Math.max(distanceKm * policy.wholesalePerKm, 20_000);
  }
  const step = customerType === "retail" ? 10_000 : 5_000;
  return { kind: "quote", feeVnd: Math.floor(rawVnd / step) * step, rawVnd, vehicle, free: false };
}

export const orchidShippingTool: ToolHandler<typeof schema> = {
  name: "orchid_shipping_quote",
  description: "Tra tuyến đường bộ và tính phí giao chậu lan Orchids World từ 42 Điện Biên Phủ. Nếu đã có địa chỉ, truyền destination để tự tra bản đồ, không cần biết trước km. Báo ngay phí cùng giá chậu khi có địa chỉ và số cành.",
  schema,
  async execute(args, ctx) {
    if (ctx.orchidShippingQuote) return ctx.orchidShippingQuote(args);
    if (args.destination) throw new Error("Ngữ cảnh này chưa kết nối bản đồ tính ship.");
    const quote = calculateOrchidShipping(args);
    if (quote.kind === "manual") return quote.reason;
    const money = (value: number) => new Intl.NumberFormat("vi-VN").format(value) + "đ";
    return `Phí ship là ${money(quote.feeVnd)}. (${args.distanceKm} km; ${args.stemCount} cành; ${args.customerType === "retail" ? "khách lẻ" : "khách sỉ"}; ${quote.vehicle}${quote.free ? "; miễn phí theo bán kính" : ""}).`;
  },
};
