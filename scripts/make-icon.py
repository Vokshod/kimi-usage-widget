# Generates assets/icon.ico (multi-size) for the Kimi Usage Widget.
# Motif: the widget's own two progress bars — purple SESSION bar over a
# green "today" bar on the dark rounded tile. Run: python scripts/make-icon.py
from PIL import Image, ImageDraw

TILE = (26, 26, 33)        # --bg
BORDER = (255, 255, 255, 26)  # --border
ACCENT = (155, 123, 255)   # --accent (session bar)
TODAY = (76, 175, 125)     # --ok (today/month bar)
MASTER = 1024

SIZES = [16, 24, 32, 48, 64, 128, 256]


def draw_master() -> Image.Image:
    img = Image.new("RGBA", (MASTER, MASTER), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    m = MASTER

    # rounded tile with 1px-equivalent border
    pad = int(m * 0.03)
    d.rounded_rectangle(
        [pad, pad, m - pad, m - pad],
        radius=int(m * 0.22),
        fill=TILE,
        outline=BORDER,
        width=max(2, m // 512),
    )

    # two bars, rounded caps (radius = half height), centered group
    bar_h = int(m * 0.115)
    gap = int(m * 0.10)
    cx = m // 2
    top_y = int(m * 0.5) - gap // 2 - bar_h // 2
    bot_y = int(m * 0.5) + gap // 2 + bar_h // 2

    def bar(y, frac, color):
        w = int(m * 0.64 * frac)
        x0 = int(m * 0.18)
        d.rounded_rectangle([x0, y, x0 + w, y + bar_h], radius=bar_h // 2, fill=color)

    bar(top_y, 1.0, ACCENT)   # session bar, longest
    bar(bot_y, 0.62, TODAY)   # today bar, shorter
    return img


def main():
    master = draw_master()
    master.save("assets/icon-preview.png")
    # PIL rescales the source into every listed size and embeds all frames
    master.save(
        "assets/icon.ico",
        format="ICO",
        sizes=[(s, s) for s in SIZES],
    )
    print(f"assets/icon.ico written ({len(SIZES)} sizes)")


if __name__ == "__main__":
    import os
    os.makedirs("assets", exist_ok=True)
    main()
