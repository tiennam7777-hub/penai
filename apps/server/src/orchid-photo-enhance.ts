import sharp from "sharp";

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 24_000_000;

/**
 * Chỉnh ảnh gốc bằng các phép ảnh xác định: sáng tự nhiên, nét nhẹ, nền ngoài
 * vùng trung tâm mờ vừa phải. Không sinh lại vật thể/chữ hay đổi bố cục.
 */
export async function enhanceOrchidPhoto(input: Buffer): Promise<Buffer> {
  if (!input.length || input.length > MAX_INPUT_BYTES) throw new Error("Ảnh phải nhỏ hơn 10 MB");
  const source = sharp(input, { limitInputPixels: MAX_PIXELS, failOn: "error" }).rotate();
  const original = await source.metadata();
  if (!original.width || !original.height || original.width * original.height > MAX_PIXELS) {
    throw new Error("Kích thước ảnh không được hỗ trợ");
  }

  // Giữ toàn bộ nội dung gốc. Vùng trung tâm rộng luôn dùng ảnh đã chỉnh nét;
  // chỉ phần rìa thường là hậu cảnh mới hòa dần vào bản làm mờ nhẹ.
  const adjusted = await source
    .resize({ width: 3200, height: 3200, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .modulate({ brightness: 1.065, saturation: 1.02 })
    .sharpen({ sigma: 0.8 })
    .png()
    .toBuffer();
  const info = await sharp(adjusted).metadata();
  const width = info.width!;
  const height = info.height!;
  const blurred = await sharp(adjusted).blur(1.8).png().toBuffer();
  const mask = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
    `<defs><radialGradient id="g" cx="50%" cy="50%" r="71%">` +
    `<stop offset="72%" stop-color="white" stop-opacity="1"/>` +
    `<stop offset="100%" stop-color="white" stop-opacity="0"/>` +
    `</radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`,
  );
  const foreground = await sharp(adjusted).ensureAlpha()
    .composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
  const composite = await sharp(blurred).composite([{ input: foreground, blend: "over" }])
    .png().toBuffer();
  for (const quality of [90, 82, 74]) {
    const result = await sharp(composite).jpeg({ quality, mozjpeg: true }).toBuffer();
    if (result.length <= MAX_INPUT_BYTES) return result;
  }
  throw new Error("Ảnh sau chỉnh vượt giới hạn gửi Zalo 10 MB");
}
