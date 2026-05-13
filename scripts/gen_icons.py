"""
PWA 아이콘 PNG 생성 스크립트.
icons/icon.svg와 같은 디자인을 Pillow로 다시 그려서 PNG로 저장.

사용:
  python scripts/gen_icons.py
"""
import os
from PIL import Image, ImageDraw

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "icons")
os.makedirs(OUT_DIR, exist_ok=True)

# 컬러 (style.css 액센트와 동일 톤)
BG_TOP = (91, 140, 255)      # --me
BG_BOT = (199, 157, 255)     # --partner
ICON_FILL = (247, 248, 252)  # --text

def vert_gradient(size):
    img = Image.new("RGBA", (size, size), 0)
    px = img.load()
    for y in range(size):
        t = y / max(size - 1, 1)
        r = int(BG_TOP[0] * (1 - t) + BG_BOT[0] * t)
        g = int(BG_TOP[1] * (1 - t) + BG_BOT[1] * t)
        b = int(BG_TOP[2] * (1 - t) + BG_BOT[2] * t)
        for x in range(size):
            px[x, y] = (r, g, b, 255)
    return img

def rounded_mask(size, radius_ratio=0.22):
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    r = int(size * radius_ratio)
    draw.rounded_rectangle([(0, 0), (size - 1, size - 1)], radius=r, fill=255)
    return mask

def draw_mic(img):
    """가운데 마이크 아이콘 그리기"""
    w, h = img.size
    cx, cy = w // 2, h // 2
    draw = ImageDraw.Draw(img)

    # 마이크 본체 (둥근 사각형)
    body_w = int(w * 0.18)
    body_h = int(h * 0.30)
    body_top = cy - int(h * 0.22)
    body_left = cx - body_w // 2
    body_right = cx + body_w // 2
    body_bot = body_top + body_h
    draw.rounded_rectangle(
        [(body_left, body_top), (body_right, body_bot)],
        radius=body_w // 2,
        fill=ICON_FILL,
    )

    # 하단 받침 (U자 아치) — 두꺼운 스트로크로 그려서 표현
    arch_w = int(w * 0.30)
    arch_h = int(h * 0.12)
    arch_top = cy - int(h * 0.02)
    arch_left = cx - arch_w // 2
    stroke = max(int(w * 0.025), 4)
    draw.arc(
        [(arch_left, arch_top), (arch_left + arch_w, arch_top + 2 * arch_h)],
        start=0, end=180,
        fill=ICON_FILL, width=stroke,
    )

    # 받침에서 내려오는 세로 막대
    stem_top = arch_top + arch_h
    stem_bot = stem_top + int(h * 0.07)
    draw.rectangle(
        [(cx - stroke // 2, stem_top), (cx + stroke // 2 - 1, stem_bot)],
        fill=ICON_FILL,
    )

    # 받침 가장 아래 — 가로 막대
    base_w = int(w * 0.16)
    draw.rectangle(
        [(cx - base_w // 2, stem_bot - stroke // 2),
         (cx + base_w // 2, stem_bot + stroke // 2)],
        fill=ICON_FILL,
    )

def make_icon(size, out_path):
    bg = vert_gradient(size)
    mask = rounded_mask(size)
    rounded = Image.new("RGBA", (size, size), 0)
    rounded.paste(bg, (0, 0), mask)
    draw_mic(rounded)
    rounded.save(out_path, "PNG", optimize=True)
    print(f"  saved: {out_path}")

if __name__ == "__main__":
    for size in (192, 512, 1024):
        path = os.path.join(OUT_DIR, f"icon-{size}.png")
        make_icon(size, path)
    # 애플 터치용 (둥근 모서리 없이 정사각 — iOS가 자체적으로 둥글림)
    apple = Image.new("RGBA", (180, 180), 0)
    bg = vert_gradient(180)
    apple.paste(bg, (0, 0))
    draw_mic(apple)
    apple_path = os.path.join(OUT_DIR, "apple-touch-icon.png")
    apple.save(apple_path, "PNG", optimize=True)
    print(f"  saved: {apple_path}")
    print("Done.")
