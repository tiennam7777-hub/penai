import { describe, expect, it } from "vitest";
import { calculateOrchidShipping } from "../src/builtin/orchid-shipping.js";

const quote = (customerType: "retail" | "wholesale", stemCount: number, distanceKm: number) =>
  calculateOrchidShipping({ customerType, stemCount, distanceKm });

describe("Orchids World shipping", () => {
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
