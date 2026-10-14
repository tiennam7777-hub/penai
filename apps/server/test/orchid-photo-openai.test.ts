import { describe, expect, it, vi } from "vitest";
import { editOrchidPhotoWithOpenAI, type OrchidPhotoEditor } from "../src/orchid-photo-openai.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3WQAAAAASUVORK5CYII=", "base64");
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(128)]);

describe("OC2 OpenAI image editing", () => {
  it("sends the original image and agent instructions to the edit model", async () => {
    const generateImage = vi.fn(async (_req: Parameters<OrchidPhotoEditor["generateImage"]>[0]) => ({ data: jpeg, mime: "image/jpeg" }));
    const result = await editOrchidPhotoWithOpenAI(png, "Giữ nguyên chữ trên bảng", { generateImage });
    expect(result.data).toBe(jpeg);
    expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({
      action: "edit", imageModel: "gpt-image-2.5-sunburst", quality: "high",
      outputFormat: "jpeg", size: "1024x1024",
      refImages: [`data:image/png;base64,${png.toString("base64")}`],
    }));
    expect(generateImage.mock.calls[0]![0].prompt).toContain("Giữ nguyên chữ trên bảng");
    expect(generateImage.mock.calls[0]![0].prompt).toContain("no patchy blur");
  });

  it("rejects wrong output instead of sending the original or a failed edit", async () => {
    await expect(editOrchidPhotoWithOpenAI(png, "", {
      generateImage: async () => ({ data: png, mime: "image/png" }),
    })).rejects.toThrow("JPG hợp lệ");
    const generateImage = vi.fn(async (_req: Parameters<OrchidPhotoEditor["generateImage"]>[0]) => ({ data: jpeg, mime: "image/jpeg" }));
    expect(() => editOrchidPhotoWithOpenAI(Buffer.alloc(20), "", { generateImage })).toThrow();
    expect(generateImage).not.toHaveBeenCalled();
  });
});
