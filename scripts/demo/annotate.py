"""Writes assets/demo.gif: demo.tape's recording, with the account rows of each /status panel outlined.

    vhs scripts/demo/demo.tape          # from the repo root; records scripts/demo/.build/demo-raw.gif
    python3 scripts/demo/annotate.py    # needs ffmpeg and Pillow

The frames are the recording's own. The only change is drawn over the frames where Claude Code's
/status panel is up: after the panel has stood on its own for a moment, a rounded outline fades
in around the rows that name the account, with everything outside it dimmed a little so the eye
goes there. The terminal's content is not touched.
"""

import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "scripts/demo/.build/demo-raw.gif"
FRAMES = ROOT / "scripts/demo/.build/frames"
OUT = ROOT / "assets/demo.gif"

# ─── Where and when to highlight ──────────────────────────────────────────────────────────────
# Everything below depends on the recording: 1200x1000 frames of an 88x37 terminal in Menlo 20
# (demo.tape's settings), showing the /status panel of Claude Code 2.1.284's fullscreen renderer
# (the Dockerfile's pin). A different font, window size or Claude Code version moves the panel:
# re-measure these from a frame of .build/demo-raw.gif.
#
# When: not a list of timestamps. The waits demo.tape keeps off camera make the panels land at a
# slightly different time on every recording, so the frames are found by what is on them - the
# "Status" tab's lavender highlight, which is drawn only while /status is open. Each unbroken run
# of such frames is one panel, and the n-th run gets the n-th entry of HIGHLIGHTS. The script
# prints the time ranges it found, and stops if it finds a different number of panels.
STATUS_TAB = {"box": (190, 140, 285, 160), "rgb": (175, 184, 247), "tolerance": 18, "share": 0.5}

# What: in the order the panels appear, the pixel box (left, top, right, bottom) around the rows
# that prove the account. On the work account's panel those are Organization and Email; the
# personal account has no organization, so Email moves up into Organization's row.
# Rows are 24.6px apart with a 3px gap between their text, so a box's top edge sits in the gap
# under the row above (y 359-361) rather than across its letters.
HIGHLIGHTS = [
    ("claude:work - Organization + Email", (52, 359, 562, 417)),
    ("claude:personal - Email", (52, 359, 562, 393)),
]

OUTLINE_RGB = (251, 191, 36)  # amber-400: stands apart from the panel's lavender and grey
OUTLINE_WIDTH = 3
OUTLINE_RADIUS = 8
DIM = 0.55  # brightness outside the outline, once faded in

# How the highlight arrives: the panel is shown untouched first, so it reads as Claude Code's own
# screen, then the outline fades in (0 -> full opacity) while the rest dims (1.0 -> DIM), and it
# stays until the panel closes. demo.tape holds each panel 4 s so the highlighted part lasts at
# least MIN_HOLD_S.
DELAY_S = 0.8
FADE_S = 0.3
MIN_HOLD_S = 2.5


def run(*args: str) -> str:
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def frame_rate(path: Path) -> str:
    rate = run("ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate",
               "-of", "default=nw=1:nk=1", str(path)).strip()
    return rate or "25/1"


def shows_status_panel(frame: Image.Image) -> bool:
    left, top, right, bottom = STATUS_TAB["box"]
    target, tol = STATUS_TAB["rgb"], STATUS_TAB["tolerance"]
    pixels = frame.crop((left, top, right, bottom)).getdata()
    close = sum(1 for p in pixels if all(abs(p[i] - target[i]) <= tol for i in range(3)))
    return close >= STATUS_TAB["share"] * (right - left) * (bottom - top)


def highlight(frame: Image.Image, box: tuple[int, int, int, int], strength: float) -> Image.Image:
    """The frame with the highlight at `strength` (0 = none, 1 = full outline and dim)."""
    brightness = 1 - (1 - DIM) * strength
    dimmed = frame.point(lambda v: int(v * brightness))
    inside = Image.new("L", frame.size, 0)
    ImageDraw.Draw(inside).rounded_rectangle(box, radius=OUTLINE_RADIUS, fill=255)
    out = Image.composite(frame, dimmed, inside)
    outline = Image.new("L", frame.size, 0)
    ImageDraw.Draw(outline).rounded_rectangle(box, radius=OUTLINE_RADIUS, outline=255, width=OUTLINE_WIDTH)
    outline = outline.point(lambda v: int(v * strength))
    return Image.composite(Image.new("RGB", frame.size, OUTLINE_RGB), out, outline)


def main() -> None:
    if not RAW.exists():
        raise SystemExit(f"{RAW.relative_to(ROOT)} is missing - run `vhs scripts/demo/demo.tape` first.")

    shutil.rmtree(FRAMES, ignore_errors=True)
    FRAMES.mkdir(parents=True)
    rate = frame_rate(RAW)
    # rgb24 throughout: a frame in another pixel format than its neighbours (the highlighted ones
    # are saved as RGB) makes ffmpeg reconfigure paletteuse mid-stream, which it fails at.
    run("ffmpeg", "-v", "error", "-i", str(RAW), "-fps_mode", "passthrough", "-pix_fmt", "rgb24",
        str(FRAMES / "%05d.png"))
    paths = sorted(FRAMES.glob("*.png"))
    num, den = (int(n) for n in rate.split("/"))
    seconds = lambda index: index * den / num  # noqa: E731

    flags = [shows_status_panel(Image.open(p).convert("RGB")) for p in paths]
    runs: list[tuple[int, int]] = []
    for index, flag in enumerate(flags):
        if flag and (index == 0 or not flags[index - 1]):
            runs.append((index, index))
        elif flag:
            runs[-1] = (runs[-1][0], index)
    if len(runs) != len(HIGHLIGHTS):
        raise SystemExit(f"found {len(runs)} /status panels in the recording, expected {len(HIGHLIGHTS)}")

    frames_for = lambda secs: round(secs * num / den)  # noqa: E731
    delay, fade = frames_for(DELAY_S), max(1, frames_for(FADE_S))
    for (label, box), (first, last) in zip(HIGHLIGHTS, runs):
        start = first + delay  # first frame the highlight shows in, faintly
        full = start + fade - 1  # first frame at full strength
        held = seconds(last - start + 1)
        print(
            f"{label}: panel {seconds(first):.2f}s-{seconds(last + 1):.2f}s, highlight fades in "
            f"{seconds(start):.2f}s-{seconds(full + 1):.2f}s, holds to {seconds(last + 1):.2f}s ({held:.2f}s)"
        )
        if held < MIN_HOLD_S:
            raise SystemExit(f"that highlight is up for {held:.2f}s; hold the panel longer in demo.tape (>= {MIN_HOLD_S}s)")
        for index in range(start, last + 1):
            strength = min(1.0, (index - start + 1) / fade)
            highlight(Image.open(paths[index]).convert("RGB"), box, strength).save(paths[index])

    # One palette for the whole GIF, and no dithering, so text stays crisp.
    palette = FRAMES.parent / "palette.png"
    frames = str(FRAMES / "%05d.png")
    run("ffmpeg", "-v", "error", "-y", "-framerate", rate, "-i", frames,
        "-vf", "palettegen=max_colors=256:stats_mode=full", str(palette))
    run("ffmpeg", "-v", "error", "-y", "-framerate", rate, "-i", frames, "-i", str(palette),
        "-lavfi", "paletteuse=dither=none:diff_mode=rectangle", "-loop", "0", str(OUT))

    written = Image.open(OUT)
    count, total_ms = 0, 0
    while True:
        count += 1
        total_ms += written.info.get("duration", 0)
        try:
            written.seek(written.tell() + 1)
        except EOFError:
            break
    if abs(total_ms / 1000 - seconds(len(paths))) > 0.5:
        raise SystemExit(f"{OUT.name} plays for {total_ms / 1000:.2f}s, the recording for {seconds(len(paths)):.2f}s")
    print(f"wrote {OUT.relative_to(ROOT)} ({count} frames, {total_ms / 1000:.2f}s, {OUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
