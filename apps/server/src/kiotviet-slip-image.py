"""Render a readable image of a KiotViet order slip from confirmed API fields."""
import json
import sys
import textwrap
from PIL import Image, ImageDraw, ImageFont

data = json.load(sys.stdin)
path = sys.argv[1]
font_path = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
font = ImageFont.truetype(font_path, 25)
title = ImageFont.truetype(font_path, 38)
small = ImageFont.truetype(font_path, 20)
lines = [
    ("PHIẾU ĐẶT HÀNG KIOTVIET", title),
    (f"Mã: {data['code']}   |   Chi nhánh: 42 Điện Biên Phủ", font),
    (f"Khách hàng: {data['customer']}", font),
]
for detail in data["details"]:
    lines.append((f"{detail['code']} - {detail['name']}: {detail['quantity']:g} × {detail['price']:,.0f}đ", font))
lines.extend([
    (f"Tạm tính: {data['total']:,.0f}đ (chưa thu tiền)", font),
    ("", font),
    ("GHI CHÚ ĐƠN HÀNG", font),
])
for segment in data["description"].split(". "):
    for part in textwrap.wrap(segment.strip(), width=65, break_long_words=False):
        lines.append((part, small))
lines.extend([
    ("", font),
    (f"Đối tác giao: {data['partner']}   |   Hẹn giao: {data.get('delivery') or 'Khách báo sau'}", small),
    ("Ảnh tóm tắt dữ liệu phiếu đặt hàng đã lưu trên KiotViet; không phải hóa đơn.", small),
])
height = 80 + sum((54 if f == title else 41 if f == font else 31) for _, f in lines)
im = Image.new("RGB", (1250, height), "white")
draw = ImageDraw.Draw(im)
y = 32
for content, face in lines:
    draw.text((45, y), content, fill="#17324D", font=face)
    y += 54 if face == title else 41 if face == font else 31
draw.rectangle((16, 16, 1233, height - 17), outline="#2372CE", width=3)
im.save(path, "PNG")
