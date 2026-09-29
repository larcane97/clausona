"""Writes assets/demo.gif: demo.tape's recording, with the account rows of each /status panel outlined.

    vhs scripts/demo/demo.tape          # from the repo root; records scripts/demo/.build/demo-raw.gif
    python3 scripts/demo/annotate.py    # needs ffmpeg and Pillow

The frames are the recording's own. The only change is drawn over the frames where Claude Code's
/status panel is up: a rounded outline around the rows that name the account, with everything
outside it dimmed a little so the eye goes there. The terminal's content is not touched.
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
DIM = 0.55  # brightness outside the outline
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


def highlight(frame: Image.Image, box: tuple[int, int, int, int]) -> Image.Image:
    dimmed = frame.point(lambda v: int(v * DIM))
    mask = Image.new("L", frame.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=OUTLINE_RADIUS, fill=255)
    out = Image.composite(frame, dimmed, mask)
    ImageDraw.Draw(out).rounded_rectangle(box, radius=OUTLINE_RADIUS, outline=OUTLINE_RGB, width=OUTLINE_WIDTH)
    return out


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

    for (label, box), (first, last) in zip(HIGHLIGHTS, runs):
        held = seconds(last - first + 1)
        print(f"{label}: {seconds(first):.2f}s-{seconds(last + 1):.2f}s ({held:.2f}s)")
        if held < MIN_HOLD_S:
            raise SystemExit(f"that panel is up for {held:.2f}s; demo.tape should hold it at least {MIN_HOLD_S}s")
        for path in paths[first : last + 1]:
            highlight(Image.open(path).convert("RGB"), box).save(path)

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
