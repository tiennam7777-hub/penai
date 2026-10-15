import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { matchNumberedPhoto, stemCountForPhoto, stemCountInName, stemCountInPath } from "../src/orchid-photo-count.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function pixels(invert = false): Buffer {
  const result = Buffer.alloc(64 * 64 * 3);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const at = (y * 64 + x) * 3;
    const value = invert ? 255 - x * 4 : x * 4;
    result[at] = value;
    result[at + 1] = (x + y) * 2;
    result[at + 2] = 80;
  }
  return result;
}

describe("số cành của ảnh thư viện", () => {
  it("chỉ nhận thư mục số cành chính xác, không coi trên 35 cành là 35", () => {
    expect(stemCountInName("chau-ghep-lua-10-canh")).toBe(10);
    expect(stemCountInName("chau-lan-tren-35-canh")).toBeNull();
    expect(stemCountInPath("shared/so-canh/chau-lan-16-canh/mau-5-canh.jpg")).toBe(16);
    expect(stemCountInPath("users/customer/mau-5-canh.jpg")).toBe(5);
  });

  it("nhận ảnh bị đổi tên và nén lại, không nhận ảnh khác", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchid-count-")); roots.push(root);
    const shared = join(root, "shared");
    const ten = join(shared, "lan-ho-diep-ghep-lua", "chau-ghep-lua-10-canh");
    const sixteen = join(shared, "so-canh", "chau-lan-16-canh");
    await mkdir(ten, { recursive: true }); await mkdir(sixteen, { recursive: true });
    const source = await sharp(pixels(), { raw: { width: 64, height: 64, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    const other = await sharp(pixels(true), { raw: { width: 64, height: 64, channels: 3 } }).jpeg().toBuffer();
    await writeFile(join(ten, "mau-10-canh.jpg"), source);
    await writeFile(join(sixteen, "mau-16-canh.jpg"), other);
    const renamed = join(root, "anh-zalo.jpg");
    await writeFile(renamed, await sharp(source).resize(48, 48).jpeg({ quality: 65 }).toBuffer());
    expect(await stemCountForPhoto(shared, renamed)).toBe(10);
    expect(await matchNumberedPhoto(shared, other)).toBe(16);
    expect(await matchNumberedPhoto(shared, Buffer.from("not an image"))).toBeNull();
  });
});
