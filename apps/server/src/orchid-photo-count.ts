import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import sharp from "sharp";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const CACHE_MS = 5 * 60_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

type KnownPhoto = { count: number; hash: bigint };
const indexes = new Map<string, { builtAt: number; photos: KnownPhoto[] }>();
const building = new Map<string, Promise<KnownPhoto[]>>();

/** Chỉ nhận số cành ghi rõ trong tên file/thư mục, không lấy số giá hay mã hàng. */
export function stemCountInName(value: string): number | null {
  if (/(?:^|[-_ ])(?:tren|hon|tu)[-_ ]\d{1,2}[-_ ]canh/i.test(basename(value))) return null;
  const match = basename(value).match(/(?:^|[-_ ])(\d{1,2})[-_ ]canh(?=$|[-_ .])/i);
  const count = match ? Number(match[1]) : 0;
  return count >= 1 && count <= 99 ? count : null;
}

export function stemCountInPath(path: string): number | null {
  const parts = path.split(/[\\/]/);
  for (const part of parts.slice(0, -1).reverse()) {
    const count = stemCountInName(part);
    if (count) return count;
  }
  return stemCountInName(parts.at(-1) ?? "");
}

/** dHash chịu được nén JPEG và thay đổi kích thước nhẹ của Zalo. */
export async function photoDifferenceHash(input: Buffer | string): Promise<bigint> {
  const pixels = await sharp(input).rotate().resize(9, 8, { fit: "fill" })
    .grayscale().removeAlpha().raw().toBuffer();
  let hash = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      hash = (hash << 1n) | (pixels[y * 9 + x]! > pixels[y * 9 + x + 1]! ? 1n : 0n);
    }
  }
  return hash;
}

function distance(a: bigint, b: bigint): number {
  let bits = a ^ b;
  let n = 0;
  while (bits) { bits &= bits - 1n; n++; }
  return n;
}

async function scanNumberedPhotos(sharedDir: string): Promise<KnownPhoto[]> {
  const photos: KnownPhoto[] = [];
  async function walk(dir: string, inheritedCount: number | null): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // tên tương thích cũ không được nhân đôi chỉ mục
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path, stemCountInName(entry.name) ?? inheritedCount);
      } else if (entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        const count = inheritedCount ?? stemCountInName(entry.name);
        if (!count) continue;
        try { photos.push({ count, hash: await photoDifferenceHash(path) }); } catch { /* ảnh hỏng */ }
      }
    }
  }
  await walk(sharedDir, null);
  return photos;
}

async function knownPhotos(sharedDir: string): Promise<KnownPhoto[]> {
  const dir = resolve(sharedDir);
  const cached = indexes.get(dir);
  if (cached && Date.now() - cached.builtAt < CACHE_MS) return cached.photos;
  let pending = building.get(dir);
  if (!pending) {
    pending = scanNumberedPhotos(dir).then((photos) => {
      indexes.set(dir, { builtAt: Date.now(), photos });
      return photos;
    }).finally(() => building.delete(dir));
    building.set(dir, pending);
  }
  return pending;
}

/** Trả null nếu ảnh giống ảnh thuộc nhiều nhóm số cành khác nhau. */
export async function matchNumberedPhoto(
  sharedDir: string,
  input: Buffer | string,
): Promise<number | null> {
  let hash: bigint;
  try { hash = await photoDifferenceHash(input); } catch { return null; }
  const byCount = new Map<number, number>();
  for (const photo of await knownPhotos(sharedDir)) {
    const d = distance(hash, photo.hash);
    byCount.set(photo.count, Math.min(d, byCount.get(photo.count) ?? 65));
  }
  const ranked = [...byCount].sort((a, b) => a[1] - b[1]);
  const first = ranked[0];
  if (!first || first[1] > 5) return null;
  if (ranked[1] && ranked[1][1] - first[1] < 4) return null;
  return first[0];
}

export async function stemCountForPhoto(
  sharedDir: string,
  input: Buffer | string,
): Promise<number | null> {
  if (typeof input === "string") {
    const shared = resolve(sharedDir);
    const path = resolve(input);
    if (path.startsWith(`${shared}${sep}`)) {
      const named = stemCountInPath(path.slice(shared.length + 1));
      if (named) return named;
    }
  }
  try {
    const bytes = typeof input === "string" ? await readFile(input) : input;
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;
    return await matchNumberedPhoto(sharedDir, bytes);
  } catch { return null; }
}
