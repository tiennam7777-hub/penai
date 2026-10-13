"""Conservative edits to the original flower photo; never generate or replace content."""

import io
import sys

from PIL import Image, ImageEnhance, ImageFilter, ImageOps


MAX_BYTES = 10 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 24_000_000


def foreground_mask(image: Image.Image) -> Image.Image:
    """Protect flowers, foliage, pot and bright printed signs, including gaps in a bouquet.

    Work on a smaller copy so large phone photos stay within the runtime budget. Color
    and brightness select likely subject pixels; dilation protects fine petal and stem
    edges. Uncertain pixels remain partly protected instead of being cut out.
    """
    sample = image.copy()
    sample.thumbnail((900, 900), Image.Resampling.LANCZOS)
    width, height = sample.size
    hsv = sample.convert("HSV")
    src = hsv.load()
    mask = Image.new("L", (width, height))
    dst = mask.load()
    for y in range(height):
        y_fraction = y / height
        for x in range(width):
            x_fraction = x / width
            h, s, v = src[x, y]
            # In product photos the object can span almost the full middle of
            # the frame. At the bottom, limit neutral bright pixels to the pot.
            in_flower_area = 0.025 < x_fraction < 0.975 and y_fraction < 0.82
            in_pot_area = 0.15 < x_fraction < 0.85 and y_fraction >= 0.55
            vivid_subject = s > 42 and v > 120 and (in_flower_area or in_pot_area)
            # Pale fence slats and bright walls are common behind orchids.
            # Keeping all bright pixels sharp would also protect that background.
            in_sign_area = 0.12 < x_fraction < 0.88 and y_fraction < 0.16
            bright_subject = v > 172 and s < 125 and (
                in_sign_area or in_pot_area
            )
            green_stem = (0.12 < x_fraction < 0.88 and y_fraction > 0.30
                          and 38 <= h <= 125 and s > 75 and v > 60)
            if vivid_subject or bright_subject or green_stem:
                dst[x, y] = 255
    radius = max(7, round(min(width, height) * 0.018))
    mask = mask.filter(ImageFilter.MaxFilter(radius * 2 + 1))
    mask = mask.filter(ImageFilter.GaussianBlur(max(2, radius // 3)))
    return mask.resize(image.size, Image.Resampling.BILINEAR)


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

    # Blur the actual background, including spaces between flower stems. The
    # foreground is copied from the original adjustment without reconstruction.
    mask = foreground_mask(adjusted)
    blur_radius = max(12, round(min(adjusted.size) * 0.018))
    # Blur a reduced copy, then resize it back. This has the same soft
    # background at phone resolution without spending a full minute on a
    # multi-megapixel Gaussian blur on the small VPS.
    scale = 4
    small_size = (max(1, adjusted.width // scale), max(1, adjusted.height // scale))
    background = adjusted.resize(small_size, Image.Resampling.LANCZOS)
    background = background.filter(ImageFilter.GaussianBlur(blur_radius / scale))
    background = background.resize(adjusted.size, Image.Resampling.BICUBIC)
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
