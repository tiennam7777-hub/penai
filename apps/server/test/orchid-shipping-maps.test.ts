import { describe, expect, it, vi } from "vitest";
import { vietmapOrchidRoadRoute } from "../src/orchid-shipping-maps.js";
describe("VIETMAP road routes", () => {
 it("geocodes both addresses and uses road distance", async () => {
  const results = [[{ref_id:"origin",name:"42 Điện Biên Phủ"}],{lat:10.79,lng:106.70},[{ref_id:"dest",name:"125 Đồng Văn Cống"}],{lat:10.78,lng:106.75},{code:"OK",paths:[{distance:12990}]}];
  const f=vi.fn(async () => new Response(JSON.stringify(results.shift()))) as unknown as typeof fetch;
  expect(await vietmapOrchidRoadRoute("secret", "125 Đồng Văn Cống, TP.HCM", f)).toEqual({destination:"125 Đồng Văn Cống, TP.HCM",distanceKm:12.99});
 });
 it("rejects ambiguous house numbers", async () => {
  const results = [[{ref_id:"a",name:"42 Điện Biên Phủ"}],{lat:10.79,lng:106.70},[{ref_id:"b",name:"Đồng Văn Cống"}]];
  const f=vi.fn(async () => new Response(JSON.stringify(results.shift()))) as unknown as typeof fetch;
  await expect(vietmapOrchidRoadRoute("secret","125 Đồng Văn Cống, TP.HCM",f)).rejects.toThrow(/khớp/);
 });
});
