"""Writes assets/routing.gif or assets/extensions.gif: a tape's recording, with what proves each step outlined.

    vhs scripts/demo/routing.tape && python3 scripts/demo/outline.py routing
    vhs scripts/demo/extensions.tape && python3 scripts/demo/outline.py extensions

It does for routing.tape and extensions.tape what annotate.py does for demo.tape, with annotate.py's
own outline: the frames are the recording's own, and the only change is drawn over the frames where
a step's proof is on screen. After that screen has stood on its own for a moment, a rounded outline
fades in around the proof, with everything outside it dimmed a little so the eye goes there, and it
stays until the screen changes. The terminal's content is not touched. Needs ffmpeg and Pillow.
"""

import shutil
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageChops

from annotate import ROOT, frame_rate, highlight, run, shows_status_panel

# How each outline arrives, as in annotate.py: the screen is shown untouched first, so it reads as
# the program's own, then the outline fades in and stays until the screen changes. MIN_HOLD_S (fade
# included) catches a screen the tape cut too short.
DELAY_S = 0.8
FADE_S = 0.3
MIN_HOLD_S = 1.8

Box = tuple[int, int, int, int]


@dataclass
class Highlight:
    label: str
    # The pixel box (left, top, right, bottom) the outline goes around.
    box: Box
    # Whether a frame shows the screen this outline belongs on. Each unbroken run of such frames is
    # one showing of it, and the outline goes on the `nth` of `runs` showings (counting from 0).
    shows: Callable[[Image.Image], bool]
    runs: int = 1
    nth: int = 0


def count_pixels(frame: Image.Image, box: Box, close: Callable[[tuple[int, int, int]], bool]) -> int:
    return sum(1 for p in frame.crop(box).getdata() if close(p))


def any_text(frame: Image.Image, box: Box) -> bool:
    """Whether the box holds any of the terminal's foreground text (zinc-100, #f4f4f5)."""
    bright = [band.point(lambda v: 255 if v > 200 else 0) for band in frame.crop(box).split()]
    return ImageChops.multiply(ImageChops.multiply(bright[0], bright[1]), bright[2]).getbbox() is not None


# ─── routing.tape ──────────────────────────────────────────────────────────────────────────────
# 1200x760 frames of an 88x27 terminal in Menlo 20, where row n's text sits 24.68px below row n-1's
# (row 1 at y 66-90). The shell rows depend on routing.tape's commands and on `route explain`'s
# layout; the /status panel is Claude Code 2.1.284's, where demo.tape has it, so annotate.py finds
# it. A different font, size, Claude Code version or explain layout moves them: re-measure from a
# frame of .build/routing-raw.gif.


def shell_row(n: int) -> tuple[int, int]:
    """The top and bottom of shell row n's text (1-based)."""
    top = round(66 + (n - 1) * 24.68)
    return top, top + 22


def prompt_waits_on_row(n: int) -> Callable[[Image.Image], bool]:
    """Whether the shell's prompt is on row n with nothing typed after it yet.

    Ends a shell screen's outline at the first key of the next command: the pink cursor is not
    text, but the first letter typed is.
    """
    top, bottom = shell_row(n)
    return lambda frame: any_text(frame, (24, top, 40, bottom)) and not any_text(frame, (48, top, 1176, bottom))


ROUTING = [
    # `route explain main`: the three accounts, their 5H and 7D, and which is picked next and
    # which is over 80% (rows 15-17), while the prompt under them (row 19) waits for the next command.
    Highlight("route explain - the accounts and the pick", (38, 406, 906, 495), prompt_waits_on_row(19)),
    # The first run's /status: the work account's Organization and Email rows, as in annotate.py.
    Highlight("/status - claude:work's Organization + Email", (52, 359, 562, 417), shows_status_panel),
    # The end: both runs and their lines (rows 19-22), work then team, once the prompt is back.
    Highlight("both runs - claude:work, then claude:team", (14, 506, 800, 609), prompt_waits_on_row(23)),
]

# ─── extensions.tape ───────────────────────────────────────────────────────────────────────────
# 1200x850 frames of a 102x35 terminal in Menlo 18: the Extensions screen's two-pane layout. The
# boxes below are on the Global table's sixth row, sentry-cli, with the cursor on it; a different
# font or size, or another order of seed-extensions.mjs's Global skills, moves them.
SENTRY_ROW: Box = (355, 368, 828, 393)
SENTRY_CURSOR: Box = (364, 376, 372, 386)  # the table's pink ✦, on this row
SENTRY_TAG: Box = (700, 371, 830, 390)  # where the row says `unused` (amber) or `off here` (grey)


def is_cursor(p: tuple[int, int, int]) -> bool:
    return p[0] > 200 and p[1] < 110 and p[2] > 120


def is_amber(p: tuple[int, int, int]) -> bool:
    return p[0] > 150 and 100 < p[1] < 175 and p[2] < 90


def is_grey(p: tuple[int, int, int]) -> bool:
    return 70 < p[0] < 150 and max(p) - min(p) < 16


def sentry_row(tag: str) -> Callable[[Image.Image], bool]:
    """Whether the cursor is on sentry-cli's row, and the row reads `unused` or `off here`."""

    def shows(frame: Image.Image) -> bool:
        if count_pixels(frame, SENTRY_CURSOR, is_cursor) < 5:
            return False
        amber = count_pixels(frame, SENTRY_TAG, is_amber)
        grey = count_pixels(frame, SENTRY_TAG, is_grey)
        return amber > 20 if tag == "unused" else (amber == 0 and grey > 20)

    return shows


EXTENSIONS = [
    # After y: the row reads `off here`.
    Highlight("sentry-cli - off here", SENTRY_ROW, sentry_row("off here")),
    # After the undo: `unused` again. The cursor first stood on the row before space; this is the
    # second time.
    Highlight("sentry-cli - back on", SENTRY_ROW, sentry_row("unused"), runs=2, nth=1),
]

GIFS = {"routing": ROUTING, "extensions": EXTENSIONS}


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in GIFS:
        raise SystemExit(f"usage: python3 scripts/demo/outline.py {'|'.join(GIFS)}")
    name = sys.argv[1]
    raw = ROOT / f"scripts/demo/.build/{name}-raw.gif"
    frames_dir = ROOT / f"scripts/demo/.build/{name}-frames"
    out = ROOT / f"assets/{name}.gif"
    if not raw.exists():
        raise SystemExit(f"{raw.relative_to(ROOT)} is missing - run `vhs scripts/demo/{name}.tape` first.")

    shutil.rmtree(frames_dir, ignore_errors=True)
    frames_dir.mkdir(parents=True)
    rate = frame_rate(raw)
    # rgb24 throughout, as annotate.py does, so paletteuse never sees a frame in another format.
    run("ffmpeg", "-v", "error", "-i", str(raw), "-fps_mode", "passthrough", "-pix_fmt", "rgb24",
        str(frames_dir / "%05d.png"))
    paths = sorted(frames_dir.glob("*.png"))
    frames = [Image.open(p).convert("RGB") for p in paths]
    num, den = (int(n) for n in rate.split("/"))
    seconds = lambda index: index * den / num  # noqa: E731
    frames_for = lambda secs: round(secs * num / den)  # noqa: E731
    delay, fade = frames_for(DELAY_S), max(1, frames_for(FADE_S))

    for spot in GIFS[name]:
        flags = [spot.shows(frame) for frame in frames]
        runs: list[tuple[int, int]] = []
        for index, flag in enumerate(flags):
            if flag and (index == 0 or not flags[index - 1]):
                runs.append((index, index))
            elif flag:
                runs[-1] = (runs[-1][0], index)
        if len(runs) != spot.runs:
            raise SystemExit(f"{spot.label}: found its screen {len(runs)} times in the recording, expected {spot.runs}")
        first, last = runs[spot.nth]
        start = first + delay  # first frame the outline shows in, faintly
        full = start + fade - 1  # first frame at full strength
        held = seconds(last - start + 1)
        print(
            f"{spot.label}: frames {first + 1}-{last + 1} ({seconds(first):.2f}s-{seconds(last + 1):.2f}s), "
            f"outline fades in {seconds(start):.2f}s-{seconds(full + 1):.2f}s (frames {start + 1}-{full + 1}), "
            f"holds to {seconds(last + 1):.2f}s ({held:.2f}s)"
        )
        if held < MIN_HOLD_S:
            raise SystemExit(f"that outline is up for {held:.2f}s; hold the screen longer in {name}.tape (>= {MIN_HOLD_S}s)")
        for index in range(start, last + 1):
            strength = min(1.0, (index - start + 1) / fade)
            highlight(frames[index], spot.box, strength).save(paths[index])

    # One palette for the whole GIF, and no dithering, so text stays crisp.
    palette = frames_dir.parent / f"{name}-palette.png"
    pattern = str(frames_dir / "%05d.png")
    run("ffmpeg", "-v", "error", "-y", "-framerate", rate, "-i", pattern,
        "-vf", "palettegen=max_colors=256:stats_mode=full", str(palette))
    run("ffmpeg", "-v", "error", "-y", "-framerate", rate, "-i", pattern, "-i", str(palette),
        "-lavfi", "paletteuse=dither=none:diff_mode=rectangle", "-loop", "0", str(out))

    written = Image.open(out)
    frame_count, total_ms = 0, 0
    while True:
        frame_count += 1
        total_ms += written.info.get("duration", 0)
        try:
            written.seek(written.tell() + 1)
        except EOFError:
            break
    if abs(total_ms / 1000 - seconds(len(paths))) > 0.5:
        raise SystemExit(f"{out.name} plays for {total_ms / 1000:.2f}s, the recording for {seconds(len(paths)):.2f}s")
    print(f"wrote {out.relative_to(ROOT)} ({frame_count} frames, {total_ms / 1000:.2f}s, {out.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
