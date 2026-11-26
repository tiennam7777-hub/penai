import { decryptSecret, type WorkspaceContext } from "@penai/shared";
import { getOrchidShippingMaps, reserveOrchidShippingMapRequest, type Db } from "@penai/db";

export const ORCHID_SHIPPING_ORIGIN = "42 Điện Biên Phủ, Phường Tân Định, Thành phố Hồ Chí Minh, Việt Nam";
export type OrchidRoadRoute = { destination: string; distanceKm: number };

/** Google geocodes the addresses inside Routes API; no key is sent to the model. */
export async function googleOrchidRoadRoute(apiKey: string, destination: string,
  request: typeof fetch = fetch): Promise<OrchidRoadRoute> {
  if (destination.length < 5 || destination.length > 400 || /https?:\/\//i.test(destination)) {
    throw new Error("Cần địa chỉ giao cụ thể hoặc tọa độ ghim vị trí, không dùng link chưa giải được điểm đến.");
  }
  const coordinates = destination.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  const latitude = Number(coordinates?.[1]), longitude = Number(coordinates?.[2]);
  if (coordinates && (latitude < 8 || latitude > 24 || longitude < 102 || longitude > 110)) {
    throw new Error("Ghim vị trí nằm ngoài khu vực Việt Nam; cần kiểm tra lại điểm giao.");
  }
  let response: Response;
  try {
    response = await request("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(12_000),
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "routes.distanceMeters,geocodingResults" },
      body: JSON.stringify({ origin: { address: ORCHID_SHIPPING_ORIGIN },
        destination: coordinates ? { location: { latLng: { latitude, longitude } } } : { address: destination },
        travelMode: "DRIVE", routingPreference: "TRAFFIC_UNAWARE", computeAlternativeRoutes: true,
        routeModifiers: { avoidHighways: true, avoidTolls: true, avoidFerries: true }, languageCode: "vi", regionCode: "vn" }),
    });
  } catch {
    throw new Error("Không kết nối được bản đồ trong thời gian cho phép; chưa xác định phí ship.");
  }
  if (!response.ok) throw new Error(response.status === 429
    ? "Bản đồ đã hết hạn mức; cần nhân viên kiểm tra phí ship."
    : "Google Maps chưa cho phép tra tuyến. Kiểm tra Routes API, thanh toán và giới hạn IP của khóa.");
  const data = await response.json() as {
    routes?: Array<{ distanceMeters?: number }>;
    geocodingResults?: { origin?: { partialMatch?: boolean; geocoderStatus?: { code?: number }; type?: string[] };
      destination?: { partialMatch?: boolean; geocoderStatus?: { code?: number }; type?: string[] } };
  };
  for (const point of [data.geocodingResults?.origin, ...(!coordinates ? [data.geocodingResults?.destination] : [])]) {
    if (!point || point.partialMatch || (point.geocoderStatus?.code ?? 0) !== 0) {
      throw new Error("Bản đồ chưa khớp chính xác địa chỉ; cần khách xác nhận số nhà, đường và phường hoặc gửi ghim vị trí.");
    }
  }
  const point = data.geocodingResults?.destination;
  if (!coordinates && /^\s*\d/.test(destination) && point?.type?.length &&
      !point.type.some(t => ["street_address", "premise", "subpremise", "establishment", "point_of_interest"].includes(t))) {
    throw new Error("Bản đồ chỉ tìm được khu vực/đường, chưa khớp số nhà; cần ghim vị trí chính xác.");
  }
  const distances = (data.routes ?? []).map(r => r.distanceMeters)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 500_000);
  if (!distances.length) throw new Error("Không tìm thấy tuyến đường bộ hợp lệ đến điểm giao.");
  return { destination, distanceKm: Math.min(...distances) / 1000 };
}

export async function resolveOrchidRoadRoute(db: Db, ctx: WorkspaceContext, destination: string) {
  const row = await getOrchidShippingMaps(db, ctx);
  if (!row) throw new Error("Chưa kết nối bản đồ tính ship; quản trị viên cần xác minh khóa ở mục Phí giao hàng.");
  if (!await reserveOrchidShippingMapRequest(db, ctx)) throw new Error("Đã đạt giới hạn tra bản đồ trong ngày; cần nhân viên kiểm tra phí ship.");
  return googleOrchidRoadRoute(decryptSecret(row.apiKeyEncrypted), destination);
}
