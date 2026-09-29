"""Composes assets/social-preview.png, the 1280x640 GitHub social preview.

    vhs scripts/demo/social.tape                 # from the repo root; writes the terminal frame
    python3 scripts/demo/social-preview.py       # composes the card around it

The terminal frame is a real screenshot of `csn use work` and `csn list`, taken by social.tape in
the same throwaway container as the demo GIF, and placed at 1:1 so it stays pixel-crisp. Only the
name, the tagline and the backdrop are drawn here. Needs Pillow and macOS (Menlo, as in the frame).
"""

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
FRAME = ROOT / "scripts/demo/.build/social-frame.png"
OUT = ROOT / "assets/social-preview.png"

W, H = 1280, 640
# src/tui/theme.ts
BRAND = (99, 102, 241)  # indigo-500
BRAND_LIGHT = (129, 140, 248)  # indigo-400
ACCENT = (236, 72, 153)  # pink-500
TEXT = (244, 244, 245)  # zinc-100
SECONDARY = (161, 161, 170)  # zinc-400
DIM = (63, 63, 70)  # zinc-700
GROUND = (12, 12, 14)

MENLO = "/System/Library/Fonts/Menlo.ttc"


def font(size, bold=False):
    return ImageFont.truetype(MENLO, size, index=1 if bold else 0)


def glow(center, radius, colour, strength):
    """A soft light on the ground, so the card is not a flat slab."""
    layer = Image.new("RGB", (W, H), (0, 0, 0))
    ImageDraw.Draw(layer).ellipse(
        [center[0] - radius, center[1] - radius, center[0] + radius, center[1] + radius],
        fill=tuple(int(c * strength) for c in colour),
    )
    return layer.filter(ImageFilter.GaussianBlur(radius * 0.6))


def main():
    card = Image.new("RGB", (W, H), GROUND)
    card = ImageChops.add(card, glow((180, 90), 360, BRAND, 0.22))
    card = ImageChops.add(card, glow((1180, 620), 300, ACCENT, 0.10))
    draw = ImageDraw.Draw(card)

    frame = Image.open(FRAME).convert("RGB")
    fx = (W - frame.width) // 2
    fy = H - frame.height - 32

    # The wordmark, as the dashboard's header draws it: white on an indigo block, level with the
    # tagline beside it. Everything lines up with the terminal's left edge.
    tagline = font(30, bold=True)
    lines = ["Switch Claude Code & Codex", "accounts in one command."]
    line_gap = 42
    top = 50
    name = font(44, bold=True)
    label = " CLAUSONA "
    left, ttop, right, bottom = draw.textbbox((0, 0), label, font=name)
    pad_x, pad_y = 8, 12
    block_h = (bottom - ttop) + 2 * pad_y
    group_h = line_gap + 36
    by = top + (group_h - block_h) // 2
    block = [fx, by, fx + (right - left) + 2 * pad_x, by + block_h]
    draw.rectangle(block, fill=BRAND)
    draw.text((fx + pad_x - left, by + pad_y - ttop), label, font=name, fill=(255, 255, 255))

    tx = block[2] + 30
    for i, line in enumerate(lines):
        draw.text((tx, top + 18 + i * line_gap), line, font=tagline, fill=TEXT, anchor="lm")

    draw.text(
        (fx, top + group_h + 24),
        "plugins, MCP servers and settings stay shared  \u00b7  plan quota for every account",
        font=font(19),
        fill=SECONDARY,
    )

    # The real terminal frame, 1:1, on a soft shadow.
    shadow = Image.new("L", (W, H), 0)
    ImageDraw.Draw(shadow).rounded_rectangle(
        [fx + 6, fy + 16, fx + frame.width - 6, fy + frame.height + 10], radius=14, fill=150
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    card = Image.composite(Image.new("RGB", (W, H), (0, 0, 0)), card, shadow)

    mask = Image.new("L", frame.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, frame.width - 1, frame.height - 1], radius=10, fill=255)
    card.paste(frame, (fx, fy), mask)
    ImageDraw.Draw(card).rounded_rectangle(
        [fx, fy, fx + frame.width - 1, fy + frame.height - 1], radius=10, outline=DIM, width=1
    )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    card.save(OUT, optimize=True)
    print(f"wrote {OUT.relative_to(ROOT)} ({W}x{H})")


if __name__ == "__main__":
    main()
