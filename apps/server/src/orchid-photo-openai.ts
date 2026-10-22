/** OC2 edits the submitted photo with OpenAI's image model, never with local filters. */

const MAX_BYTES = 10 * 1024 * 1024;

export interface OrchidPhotoEditor {
  generateImage(req: {
    prompt: string;
    model: string;
    size: string;
    refImages: string[];
    action: "edit";
    imageModel: string;
    outputFormat: "jpeg";
    outputCompression: number;
    quality: "high";
  }): Promise<{ data: Buffer; mime: string }>;
}

const REQUIRED_EDIT = `Edit the supplied original photograph, not a newly imagined orchid arrangement.
Produce a natural, professional product photograph: bright, balanced studio-like light; crisp orchids, foliage and pot; smooth, strong, even background defocus with no patchy blur, halos or rough cutout edges.
Treat the entire sign, including its border, background, logos, lettering and every tiny detail, as a protected part of the original photograph. Keep its exact position, size, shape, colors, layout, strokes, spelling, punctuation and even faint or unreadable marks. Do not redraw, retype, reconstruct, sharpen, blur, denoise, repaint, inpaint or replace any part of the sign. Do not guess or improve any letters. On the sign, only a gentle exposure or brightness adjustment is allowed; preserve all other visual details exactly as photographed.
Keep the original framing and the exact flowers, stems, buds, leaves, colors, pot shape, decorations and other small details. Do not add, remove or rearrange any part of the orchid arrangement or change its price or text.
If a chair or stool is visible under or behind the pot, remove that distracting support cleanly while keeping the pot in the same position and giving it a believable neutral surface. Do not add unrelated objects, new text, logos or watermarks. The result must remain a realistic photo of the same physical product.`;

function inputInfo(input: Buffer): { mime: string; width: number; height: number } {
  if (input.length < 30 || input.length > MAX_BYTES) throw new Error("Ảnh gốc phải nhỏ hơn 10 MB");
  if (input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mime: "image/png", width: input.readUInt32BE(16), height: input.readUInt32BE(20) };
  }
  if (input[0] === 0xff && input[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < input.length) {
      if (input[offset] !== 0xff) break;
      const marker = input[offset + 1]!;
      offset += 2;
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = input.readUInt16BE(offset);
      if (length < 2 || offset + length > input.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { mime: "image/jpeg", width: input.readUInt16BE(offset + 5), height: input.readUInt16BE(offset + 3) };
      }
      offset += length;
    }
  }
  if (input.toString("ascii", 0, 4) === "RIFF" && input.toString("ascii", 8, 12) === "WEBP") {
    const chunk = input.toString("ascii", 12, 16);
    if (chunk === "VP8X" && input.length >= 30) {
      return {
        mime: "image/webp",
        width: 1 + input.readUIntLE(24, 3),
        height: 1 + input.readUIntLE(27, 3),
      };
    }
    if (chunk === "VP8L" && input.length >= 25 && input[20] === 0x2f) {
      return {
        mime: "image/webp",
        width: 1 + (input[21]! | ((input[22]! & 0x3f) << 8)),
        height: 1 + ((input[22]! >> 6) | (input[23]! << 2) | ((input[24]! & 0x0f) << 10)),
      };
    }
    if (chunk === "VP8 " && input.length >= 30 && input[23] === 0x9d && input[24] === 0x01 && input[25] === 0x2a) {
      return {
        mime: "image/webp",
        width: input.readUInt16LE(26) & 0x3fff,
        height: input.readUInt16LE(28) & 0x3fff,
      };
    }
  }
  throw new Error("OC2 chỉ hỗ trợ ảnh JPG, PNG hoặc WebP hợp lệ");
}

// Keep two image edits in flight. A single slow provider request must not hold
// every OC2 group and direct-photo command behind it.
const MAX_CONCURRENT_EDITS = 2;
let activeEdits = 0;
const waitingEdits: Array<() => void> = [];

async function withEditSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeEdits >= MAX_CONCURRENT_EDITS) {
    await new Promise<void>((resolve) => waitingEdits.push(resolve));
  } else activeEdits++;
  try {
    return await task();
  } finally {
    const next = waitingEdits.shift();
    if (next) next();
    else activeEdits--;
  }
}

export function editOrchidPhotoWithOpenAI(
  input: Buffer,
  agentPrompt: string,
  editor: OrchidPhotoEditor,
  carrierModel: string,
  backgroundBlur: "strong" | "moderate" = "strong",
): Promise<{ data: Buffer; mime: "image/jpeg" }> {
  const source = inputInfo(input);
  if (!source.width || !source.height || source.width * source.height > 24_000_000) {
    throw new Error("Kích thước ảnh không được hỗ trợ");
  }
  const ratio = source.width / source.height;
  const size = ratio < 0.84 ? "1024x1536" : ratio > 1.2 ? "1536x1024" : "1024x1024";
  return withEditSlot(async () => {
    const result = await editor.generateImage({
      prompt: `${agentPrompt.trim()}\n\n${backgroundBlur === "moderate"
        ? REQUIRED_EDIT.replace("smooth, strong, even background defocus", "smooth, moderate, natural background defocus")
        : REQUIRED_EDIT}`,
      model: carrierModel,
      size,
      refImages: [`data:${source.mime};base64,${input.toString("base64")}`],
      action: "edit",
      imageModel: "gpt-image-2.5-sunburst",
      outputFormat: "jpeg",
      outputCompression: 88,
      quality: "high",
    });
    if (result.mime !== "image/jpeg" || result.data.length > MAX_BYTES ||
      result.data.length < 128 || result.data[0] !== 0xff || result.data[1] !== 0xd8) {
      throw new Error("OpenAI chưa trả ảnh JPG hợp lệ dưới 10 MB");
    }
    return { data: result.data, mime: "image/jpeg" as const };
  });
}
