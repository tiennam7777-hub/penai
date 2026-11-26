import { describe, expect, it } from "vitest";
import { calculateOrchidShipping, orchidShippingPolicyFromPrompt, orchidShippingTool } from "../src/builtin/orchid-shipping.js";
import type { ToolContext } from "../src/registry.js";

const quote = (customerType: "retail" | "wholesale", stemCount: number, distanceKm: number) =>
  calculateOrchidShipping({ customerType, stemCount, distanceKm });

describe("Orchids World shipping", () => {
  it("uses the current owning prompt's tariff, including a different wholesale surcharge", () => {
    const policy = orchidShippingPolicyFromPrompt("QUY TẮC PHÍ SHIP ORCHIDS WORLD (abc): Khách lẻ, chậu 3–15 cành tính 7.000đ/km; chậu 16–35 cành tính 7.000đ/km + 20.000đ. Khách sỉ: Chậu 1–15 cành tính 7.500đ/km. Chậu 16–35 cành tính 7.500đ/km + 40.000đ.");
    expect(policy).toEqual({ retailPerKm: 7000, wholesalePerKm: 7500, wholesaleExtra: 40000 });
    expect(calculateOrchidShipping({ customerType: "retail", stemCount: 5, distanceKm: 14 }, policy)).toMatchObject({ feeVnd: 90000 });
    expect(calculateOrchidShipping({ customerType: "wholesale", stemCount: 16, distanceKm: 14 }, policy)).toMatchObject({ feeVnd: 145000 });
  });
  it("accepts an address without invented km and forwards to the credential-owning runtime", async () => {
    const args = orchidShippingTool.schema.parse({ customerType: "retail", stemCount: 7, destination: "31 Đống Đa, Bình Thạnh" });
    const result = await orchidShippingTool.execute(args, { orchidShippingQuote: async input => {
      expect(input.distanceKm).toBeUndefined(); expect(input.destination).toContain("31 Đống Đa"); return "Phí ship 0đ";
    } } as ToolContext);
    expect(result).toBe("Phí ship 0đ");
  });
  it("gives retail pots from 3 to 35 stems free delivery strictly below 8 km", () => {
    expect(quote("retail", 3, 7.9)).toMatchObject({ kind: "quote", feeVnd: 0 });
    expect(quote("retail", 16, 7.9)).toMatchObject({ kind: "quote", feeVnd: 0 });
    expect(quote("retail", 15, 8)).toMatchObject({ kind: "quote", feeVnd: 60_000 });
  });

  it("rounds retail motorcycle fees down to a whole ten thousand", () => {
    expect(quote("retail", 5, 14)).toMatchObject({ kind: "quote", rawVnd: 105_000, feeVnd: 100_000 });
    expect(quote("retail", 16, 14)).toMatchObject({ kind: "quote", rawVnd: 125_000, feeVnd: 120_000 });
    expect(quote("retail", 35, 14)).toMatchObject({ kind: "quote", feeVnd: 120_000 });
  });

  it("uses a car above 35 stems with a 200k minimum", () => {
    expect(quote("retail", 36, 2)).toMatchObject({ kind: "quote", feeVnd: 200_000, vehicle: "xe hơi" });
    expect(quote("retail", 36, 14)).toMatchObject({ kind: "quote", feeVnd: 350_000 });
  });

  it("charges wholesale delivery inside 8 km and applies each minimum", () => {
    expect(quote("wholesale", 5, 1)).toMatchObject({ kind: "quote", feeVnd: 20_000 });
    expect(quote("wholesale", 5, 8)).toMatchObject({ kind: "quote", rawVnd: 64_000, feeVnd: 60_000 });
    expect(quote("wholesale", 15, 24.3)).toMatchObject({ kind: "quote", rawVnd: 194_400, feeVnd: 190_000 });
    expect(quote("wholesale", 16, 2)).toMatchObject({ kind: "quote", feeVnd: 100_000 });
    expect(quote("wholesale", 16, 14)).toMatchObject({ kind: "quote", rawVnd: 132_000, feeVnd: 130_000 });
    expect(quote("wholesale", 36, 2)).toMatchObject({ kind: "quote", feeVnd: 250_000, vehicle: "xe bán tải" });
    expect(quote("wholesale", 36, 14)).toMatchObject({ kind: "quote", feeVnd: 350_000 });
  });

  it("leaves retail pots below 3 stems for a person to quote", () => {
    expect(quote("retail", 2, 14)).toMatchObject({ kind: "manual" });
  });
});
