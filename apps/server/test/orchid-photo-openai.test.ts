import { describe, expect, it, vi } from "vitest";
import { editOrchidPhotoWithOpenAI, type OrchidPhotoEditor } from "../src/orchid-photo-openai.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3WQAAAAASUVORK5CYII=", "base64");
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(128)]);

describe("OC2 OpenAI image editing", () => {
  it("sends the original image and agent instructions to the edit model", async () => {
    const generateImage = vi.fn(async (_req: Parameters<OrchidPhotoEditor["generateImage"]>[0]) => ({ data: jpeg, mime: "image/jpeg" }));
    const result = await editOrchidPhotoWithOpenAI(png, "Giữ nguyên chữ trên bảng", { generateImage }, "gpt-6-sol");
    expect(result.data).toBe(jpeg);
    expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({
      action: "edit", model: "gpt-6-sol", imageModel: "gpt-image-2.5-sunburst", quality: "high",
      outputFormat: "jpeg", size: "1024x1024",
      refImages: [`data:image/png;base64,${png.toString("base64")}`],
    }));
    expect(generateImage.mock.calls[0]![0].prompt).toContain("Giữ nguyên chữ trên bảng");
    expect(generateImage.mock.calls[0]![0].prompt).toContain("no patchy blur");
    expect(generateImage.mock.calls[0]![0].prompt).toContain("Do not redraw, retype, reconstruct");
    expect(generateImage.mock.calls[0]![0].prompt).toContain("only a gentle exposure or brightness adjustment is allowed");
  });

  it("rejects wrong output instead of sending the original or a failed edit", async () => {
    await expect(editOrchidPhotoWithOpenAI(png, "", {
      generateImage: async () => ({ data: png, mime: "image/png" }),
    }, "gpt-6-sol")).rejects.toThrow("JPG hợp lệ");
    const generateImage = vi.fn(async (_req: Parameters<OrchidPhotoEditor["generateImage"]>[0]) => ({ data: jpeg, mime: "image/jpeg" }));
    expect(() => editOrchidPhotoWithOpenAI(Buffer.alloc(20), "", { generateImage }, "gpt-6-sol")).toThrow();
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("runs at most two edits at once and releases a slot after failure", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const editor: OrchidPhotoEditor = { generateImage: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return { data: jpeg, mime: "image/jpeg" };
    } };
    const jobs = Array.from({ length: 3 }, () => editOrchidPhotoWithOpenAI(png, "", editor, "gpt-6-sol"));
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(peak).toBe(2);
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(peak).toBe(2);
    releases.splice(0).forEach((release) => release());
    await expect(Promise.all(jobs)).resolves.toHaveLength(3);
  });
});
