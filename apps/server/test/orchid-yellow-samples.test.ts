import { describe, expect, it } from "vitest";
import { orchidYellowSamplePath, requestedOrchidYellowSamples } from "../src/orchid-yellow-samples.js";

describe("orchid yellow photo samples", () => {
  it("sends both named files when the customer asks to compare yellow styles", () => {
    expect(requestedOrchidYellowSamples("Cho e hình vàng thấp và vàng cao"))
      .toEqual(["low", "high"]);
    expect(requestedOrchidYellowSamples("Cây thấp hay cây cao khác nhau thế nào", ["Hoa vàng nha"]))
      .toEqual(["low", "high"]);
    expect(orchidYellowSamplePath("/shared", "low").replaceAll("\\", "/"))
      .toBe("/shared/theo-mau/lan-vang-thap/lan-vang-thap.png");
    expect(orchidYellowSamplePath("/shared", "high").replaceAll("\\", "/"))
      .toBe("/shared/theo-mau/lan-vang-cao/vang-cao.jpg");
  });

  it("does not attach unrelated photos or extra styles", () => {
    expect(requestedOrchidYellowSamples("Cho em xem hình vàng thấp")).toEqual(["low"]);
    expect(requestedOrchidYellowSamples("Cây thấp hay cây cao khác nhau thế nào", ["Hoa trắng nha"]))
      .toEqual([]);
    expect(requestedOrchidYellowSamples("Hoa vàng nha")).toEqual([]);
  });
});
