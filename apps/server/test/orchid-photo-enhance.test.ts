import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { enhanceOrchidPhoto } from "../src/orchid-photo-enhance.js";

describe("OC1 photo enhancement", () => {
  it("edits the original pixels and keeps its dimensions", async () => {
    const width = 320;
    const height = 240;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      const flower = x > 90 && x < 230 && y > 40 && y < 200;
      pixels[offset] = flower ? 180 : (x % 8 < 4 ? 100 : 130);
      pixels[offset + 1] = flower ? 45 : (x % 8 < 4 ? 100 : 130);
      pixels[offset + 2] = flower ? 100 : (x % 8 < 4 ? 100 : 130);
    }
    const original = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
    const edited = await enhanceOrchidPhoto(original);
    const info = await sharp(edited).metadata();
    expect(info.format).toBe("jpeg");
    expect([info.width, info.height]).toEqual([width, height]);
    expect(edited.equals(original)).toBe(false);
    const center = await sharp(edited).extract({ left: 150, top: 100, width: 1, height: 1 }).raw().toBuffer();
    expect(center[0]).toBeGreaterThan(170);
    expect(center[0]).toBeGreaterThan(center[1]!);
  });

  it("rejects corrupt or oversized input", async () => {
    await expect(enhanceOrchidPhoto(Buffer.from("invalid"))).rejects.toThrow();
    await expect(enhanceOrchidPhoto(Buffer.alloc(10 * 1024 * 1024 + 1))).rejects.toThrow("10 MB");
  });
});
