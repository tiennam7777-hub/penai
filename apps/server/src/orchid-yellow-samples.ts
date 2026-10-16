import { join } from "node:path";

const SAMPLE_FILES = {
  low: ["theo-mau", "lan-vang-thap", "lan-vang-thap.png"],
  high: ["theo-mau", "lan-vang-cao", "vang-cao.jpg"],
} as const;

function plain(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase();
}

/** Chỉ kích hoạt khi khách xin hình hoặc hỏi so sánh hai dáng lan vàng. */
export function requestedOrchidYellowSamples(text: string, recentCustomerTexts: string[] = []): Array<"low" | "high"> {
  const current = plain(text);
  const hasYellow = /\bvang\b/.test(current) || recentCustomerTexts.slice(-5).some((item) => /\bvang\b/.test(plain(item)));
  if (!hasYellow) return [];
  const low = /\b(?:thap|lun)\b/.test(current);
  const high = /\bcao\b/.test(current);
  if (!low && !high) return [];
  const asksForPhoto = /\b(?:hinh|anh|xem|mau)\b/.test(current);
  const asksComparison = low && high && /(?:khac\s*nhau|so\s*sanh|nen\s*chon|the\s*nao)/.test(current);
  if (!asksForPhoto && !asksComparison) return [];
  return [...(low ? ["low" as const] : []), ...(high ? ["high" as const] : [])];
}

export function orchidYellowSamplePath(sharedDir: string, kind: "low" | "high"): string {
  return join(sharedDir, ...SAMPLE_FILES[kind]);
}
