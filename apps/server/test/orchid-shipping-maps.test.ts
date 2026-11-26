import { describe, expect, it, vi } from "vitest";
import { googleOrchidRoadRoute, ORCHID_SHIPPING_ORIGIN } from "../src/orchid-shipping-maps.js";

const good = { routes: [{ distanceMeters: 13400 }, { distanceMeters: 12990 }],
  geocodingResults: { origin: { type: ["street_address"] }, destination: { type: ["street_address"] } } };
describe("Orchids road route verification", () => {
  it("uses the shortest returned road route and the fixed shop origin, without rounding km across fee boundaries", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(good))) as unknown as typeof fetch;
    expect(await googleOrchidRoadRoute("private-key", "125 Đồng Văn Cống, TP.HCM", request)).toEqual({ destination: "125 Đồng Văn Cống, TP.HCM", distanceKm: 12.99 });
    const opts = (request as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(JSON.parse(opts.body).origin.address).toBe(ORCHID_SHIPPING_ORIGIN);
    expect(opts.headers["X-Goog-Api-Key"]).toBe("private-key");
    expect(JSON.parse(opts.body).routingPreference).toBe("TRAFFIC_UNAWARE");
  });
  it("does not quote an approximate geocode or a street centroid for a numbered house", async () => {
    for (const destination of [{ partialMatch: true }, { type: ["route"] }]) {
      const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...good,
        geocodingResults: { ...good.geocodingResults, destination } }))) as unknown as typeof fetch;
      await expect(googleOrchidRoadRoute("private-key", "125 Đồng Văn Cống, TP.HCM", request)).rejects.toThrow(/khớp|số nhà/);
    }
  });
  it("never exposes provider errors, request credentials, or guesses a distance on failure", async () => {
    const request = vi.fn().mockResolvedValue(new Response("private-key", { status: 403 })) as unknown as typeof fetch;
    await expect(googleOrchidRoadRoute("private-key", "125 Đồng Văn Cống, TP.HCM", request)).rejects.toThrow("Google Maps chưa cho phép");
    await expect(googleOrchidRoadRoute("private-key", "https://example.org/pin", request)).rejects.toThrow("địa chỉ");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
