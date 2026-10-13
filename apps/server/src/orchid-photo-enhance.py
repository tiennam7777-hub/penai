"""Conservative edits to the original flower photo; never generate or replace content."""

import io
import sys

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps


MAX_BYTES = 10 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 24_000_000


def main() -> None:
    original_bytes = sys.stdin.buffer.read(MAX_BYTES + 1)
    if not original_bytes or len(original_bytes) > MAX_BYTES:
        raise ValueError("Ảnh phải nhỏ hơn 10 MB")
    with Image.open(io.BytesIO(original_bytes)) as original:
        if original.format not in {"JPEG", "PNG", "WEBP", "GIF"}:
            raise ValueError("Chỉ hỗ trợ ảnh JPG, PNG, WebP hoặc GIF")
        if original.width * original.height > Image.MAX_IMAGE_PIXELS:
            raise ValueError("Kích thước ảnh không được hỗ trợ")
        image = ImageOps.exif_transpose(original).convert("RGB")
    image.thumbnail((3200, 3200), Image.Resampling.LANCZOS)

    # Giữ bố cục và toàn bộ chi tiết gốc; chỉ chỉnh sáng, màu và độ nét nhẹ.
    adjusted = ImageEnhance.Brightness(image).enhance(1.065)
    adjusted = ImageEnhance.Color(adjusted).enhance(1.02)
    adjusted = ImageEnhance.Sharpness(adjusted).enhance(1.15)

    # Bảo vệ vùng chủ thể rộng ở giữa. Chỉ hòa nền rìa vào bản mờ nhẹ;
    # không sử dụng mô hình tạo ảnh hoặc thêm vật thể/chữ mới.
    width, height = adjusted.size
    mask = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((int(width * 0.06), int(height * 0.06),
                  int(width * 0.94), int(height * 0.94)), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(max(2, int(min(width, height) * 0.035))))
    background = adjusted.filter(ImageFilter.GaussianBlur(1.8))
    result = Image.composite(adjusted, background, mask)
    for quality in (90, 82, 74):
        output = io.BytesIO()
        result.save(output, format="JPEG", quality=quality, optimize=True)
        if output.tell() <= MAX_BYTES:
            sys.stdout.buffer.write(output.getvalue())
            return
    raise ValueError("Ảnh sau chỉnh vượt giới hạn gửi Zalo 10 MB")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"photo_edit_failed: {exc}", file=sys.stderr)
        sys.exit(1)
