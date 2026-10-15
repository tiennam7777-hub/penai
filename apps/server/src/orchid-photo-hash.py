"""dHash ảnh lan bằng Pillow cho VPS CPU cũ (không dùng sharp native)."""
from __future__ import annotations

import io
import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageOps

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp"}
COUNT = re.compile(r"(?:^|[-_ ])(\d{1,2})[-_ ]canh(?:$|[-_ .])", re.I)
RANGE = re.compile(r"(?:^|[-_ ])(?:tren|hon|tu)[-_ ]\d{1,2}[-_ ]canh", re.I)


def exact_count(name: str) -> int | None:
    if RANGE.search(name):
        return None
    match = COUNT.search(name)
    if not match:
        return None
    count = int(match.group(1))
    return count if 1 <= count <= 99 else None


def hash_image(source: str | io.BytesIO) -> str:
    with Image.open(source) as original:
        original.draft("L", (36, 32))  # JPEG giải mã bản thu nhỏ thay vì ảnh nhiều megapixel
        image = ImageOps.exif_transpose(original).convert("L").resize((9, 8), Image.Resampling.LANCZOS)
        pixels = [image.getpixel((x, y)) for y in range(8) for x in range(9)]
    value = 0
    for y in range(8):
        for x in range(8):
            value = (value << 1) | int(pixels[y * 9 + x] > pixels[y * 9 + x + 1])
    return f"{value:016x}"


def index(shared: Path) -> list[tuple[int, str]]:
    rows: list[tuple[int, str]] = []

    def walk(directory: Path, inherited: int | None) -> None:
        for item in directory.iterdir():
            if item.is_symlink():
                continue
            if item.is_dir():
                walk(item, exact_count(item.name) or inherited)
            elif item.is_file() and item.suffix.lower() in IMAGE_EXT:
                count = inherited or exact_count(item.name)
                if not count:
                    continue
                try:
                    rows.append((count, hash_image(str(item))))
                except Exception:
                    pass

    walk(shared, None)
    return rows


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in {"hash", "index"}:
        raise SystemExit("usage: orchid-photo-hash.py hash <path|-> | index <shared>")
    if sys.argv[1] == "hash":
        source = io.BytesIO(sys.stdin.buffer.read()) if sys.argv[2] == "-" else sys.argv[2]
        print(hash_image(source))
    else:
        print(json.dumps(index(Path(sys.argv[2]))))
