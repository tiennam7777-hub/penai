import { describe, expect, it, vi } from "vitest";
import { vietmapOrchidRoadRoute } from "../src/orchid-shipping-maps.js";
describe("VIETMAP road routes", () => {
 it("geocodes both addresses and uses road distance", async () => {
  const results = [[{ref_id:"origin",name:"42 Điện Biên Phủ",address:"Phường Đa Kao, Quận 1"}],{lat:10.79,lng:106.70},[{ref_id:"dest",name:"125 Đồng Văn Cống"}],{lat:10.78,lng:106.75},{code:"OK",paths:[{distance:12990}]}];
  const f=vi.fn(async () => new Response(JSON.stringify(results.shift()))) as unknown as typeof fetch;
  expect(await vietmapOrchidRoadRoute("secret", "125 Đồng Văn Cống, TP.HCM", f)).toEqual({destination:"125 Đồng Văn Cống, TP.HCM",distanceKm:12.99});
 });
 it("uses the road when the exact house is unavailable", async () => {
  const results = [[{ref_id:"a",name:"42 Điện Biên Phủ",address:"Phường Đa Kao, Quận 1"}],{lat:10.79,lng:106.70},[{ref_id:"b",name:"Đồng Văn Cống"}],{lat:10.78,lng:106.75},{code:"OK",paths:[{distance:13000}]}];
  const f=vi.fn(async () => new Response(JSON.stringify(results.shift()))) as unknown as typeof fetch;
  expect(await vietmapOrchidRoadRoute("secret","125 Đồng Văn Cống, TP.HCM",f)).toMatchObject({distanceKm:13});
 });
 it("accepts nearby buildings within 1 km for a street and residential area", async () => {
  const results = [[{ref_id:"a",name:"42 Điện Biên Phủ",address:"Phường Đa Kao, Quận 1"}],{lat:10.79,lng:106.70},
   [{ref_id:"b",name:"Đường D1, Vinhomes Grand Park"},{ref_id:"c",name:"Tòa Daisy, Vinhomes Grand Park"}],
   {lat:10.84,lng:106.83},{lat:10.845,lng:106.835},{code:"OK",paths:[{distance:24800}]}];
  const f=vi.fn(async () => new Response(JSON.stringify(results.shift()))) as unknown as typeof fetch;
  expect(await vietmapOrchidRoadRoute("secret","Đường D1, khu Vinhomes quận 9",f)).toMatchObject({distanceKm:24.8});
  const routeCall = (f as any).mock.calls.at(-1)[0] as string;
  expect(new URL(routeCall).searchParams.getAll("point")).toEqual(["10.79,106.7","10.84,106.83"]);
 });
 it("asks only for the area when search results are far apart", async () => {
  const results = [[{ref_id:"a",name:"42 Điện Biên Phủ",address:"Phường Đa Kao, Quận 1"}],{lat:10.79,lng:106.70},
   [{ref_id:"b",name:"Đường D1"},{ref_id:"c",name:"Đường D1"}],{lat:10.84,lng:106.83},{lat:10.76,lng:106.69}];
  const f=vi.fn(async () => new Response(JSON.stringify(results.shift()))) as unknown as typeof fetch;
  await expect(vietmapOrchidRoadRoute("secret","Đường D1, TP.HCM",f)).rejects.toThrow(/chỉ cần làm rõ tên khu hoặc quận/);
 });
 it("still requires the correct shop origin", async () => {
  const f=vi.fn(async () => new Response(JSON.stringify([{ref_id:"wrong",name:"42 Điện Biên Phủ",address:"Phường 15, Bình Thạnh"}]))) as unknown as typeof fetch;
  await expect(vietmapOrchidRoadRoute("secret","Đường D1, khu Vinhomes quận 9",f)).rejects.toThrow(/Địa chỉ cửa hàng/);
 });
});

