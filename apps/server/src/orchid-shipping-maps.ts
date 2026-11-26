import { decryptSecret, type WorkspaceContext } from "@penai/shared";
import { getOrchidShippingMaps, reserveOrchidShippingMapRequest, type Db } from "@penai/db";
export const ORCHID_SHIPPING_ORIGIN = "42 Điện Biên Phủ, Phường Đa Kao, Quận 1, Thành phố Hồ Chí Minh";
export type OrchidRoadRoute = { destination: string; distanceKm: number };
const normalize = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d").toLowerCase();
export async function vietmapOrchidRoadRoute(apiKey: string, destination: string, request: typeof fetch = fetch): Promise<OrchidRoadRoute> {
  if (destination.length < 5 || destination.length > 400 || /https?:\/\//i.test(destination)) throw new Error("Cần địa chỉ giao cụ thể hoặc tọa độ vị trí.");
  async function get(path: string, params: URLSearchParams): Promise<any> {
    params.set("apikey", apiKey);
    try {
      const r = await request(`https://maps.vietmap.vn/api/${path}?${params}`, { redirect: "error", signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error("provider error");
      return await r.json();
    } catch { throw new Error("Không tra được VIETMAP; kiểm tra khóa, hạn mức hoặc kết nối."); }
  }
  async function locate(address: string): Promise<[number,number]> {
    const result = await get("search/v4", new URLSearchParams({ text: address, display_type: "2" }));
    if (!Array.isArray(result) || result.length === 0) throw new Error("Không tìm thấy địa chỉ chính xác; cần khách gửi đầy đủ số nhà hoặc ghim vị trí.");
    const house = address.match(/^\s*(\d+[\w/-]*)\s+/)?.[1];
    let candidates = result.filter((r: any) => typeof r.ref_id === "string" && (!house || new RegExp(`(^|\\D)${house.replace(/[^\d]/g, "")}(?!\\d)`).test(normalize(String(r.name ?? "") + " " + String(r.display ?? "")))));
    if (address === ORCHID_SHIPPING_ORIGIN) candidates = candidates.filter((r: any) => /da kao/.test(normalize(String(r.address ?? ""))));
    if (candidates.length !== 1) throw new Error("Địa chỉ chưa khớp duy nhất; cần khách xác nhận hoặc gửi ghim vị trí.");
    const place = await get("place/v4", new URLSearchParams({refid: candidates[0].ref_id}));
    const lat = Number(place.lat), lng = Number(place.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 8 || lat > 24 || lng < 102 || lng > 110) throw new Error("Không xác định được tọa độ địa chỉ.");
    return [lat,lng];
  }
  const origin = await locate(ORCHID_SHIPPING_ORIGIN);
  const coord = destination.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  const target: [number,number] = coord ? [Number(coord[1]),Number(coord[2])] : await locate(destination);
  if (target[0] < 8 || target[0] > 24 || target[1] < 102 || target[1] > 110) throw new Error("Vị trí giao không hợp lệ.");
  const params = new URLSearchParams(); params.append("point",origin.join(",")); params.append("point",target.join(",")); params.set("vehicle","motorcycle"); params.set("points_encoded","true");
  const route = await get("route/v4",params);
  const meters = Number(route?.paths?.[0]?.distance);
  if (route?.code !== "OK" || !Number.isFinite(meters) || meters <= 0 || meters > 500000) throw new Error("Không tìm thấy tuyến đường bộ hợp lệ.");
  return {destination,distanceKm:meters/1000};
}
export async function resolveOrchidRoadRoute(db: Db, ctx: WorkspaceContext, destination: string) {
  const row = await getOrchidShippingMaps(db, ctx);
  if (!row) throw new Error("Chưa kết nối VIETMAP tính ship.");
  if (!await reserveOrchidShippingMapRequest(db, ctx)) throw new Error("Đã đạt giới hạn tra bản đồ trong ngày.");
  return vietmapOrchidRoadRoute(decryptSecret(row.apiKeyEncrypted), destination);
}
