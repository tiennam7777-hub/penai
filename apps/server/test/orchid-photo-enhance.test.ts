import { describe, expect, it } from "vitest";
import { enhanceOrchidPhoto } from "../src/orchid-photo-enhance.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3WQAAAAASUVORK5CYII=", "base64");

describe("OC1 photo enhancement", () => {
  it.skipIf(process.platform === "win32")("edits source pixels and returns JPEG", async () => {
    const edited = await enhanceOrchidPhoto(png);
    expect(edited.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(edited.equals(png)).toBe(false);
  });

  it("rejects corrupt or oversized input", async () => {
    await expect(enhanceOrchidPhoto(Buffer.alloc(10 * 1024 * 1024 + 1))).rejects.toThrow("10 MB");
  });
});
