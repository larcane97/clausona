"""Writes assets/routing.gif or assets/extensions.gif: a tape's recording, with what proves each step outlined.

    vhs scripts/demo/routing.tape && python3 scripts/demo/outline.py routing
    vhs scripts/demo/extensions.tape && python3 scripts/demo/outline.py extensions

It does for routing.tape and extensions.tape what annotate.py does for demo.tape, with annotate.py's
own outline: the frames are the recording's own, and the only change is drawn over the frames where
a step's proof is on screen. After that screen has stood on its own for a moment, a rounded outline
fades in around the proof, with everything outside it dimmed a little so the eye goes there, and it
stays until the screen changes.

In the Extensions GIF it also captions the keys a viewer cannot see being pressed: the ones that open
a dialog, answer it, undo or switch the view. A cursor that moves shows its own arrow key. Each
caption is a keycap in the bottom-right corner, below the hint bar, where none of the screens draws
anything. It comes up on the recording's own frames 0.4s before the screen changes, so the cause
comes first, and goes 0.5s after. No frame is added, dropped or held, and the terminal's content is
not touched. Needs ffmpeg, Pillow and a monospace font (Menlo, or DejaVu Sans Mono).

The boxes and the places checked for each screen are pixel positions measured on one recording at
the tape's size. On a busy machine a take can differ: the script stops when a screen it looks for
shows a different number of times, is held too briefly, or changes in the 0.4s before a caption.
"""

import shutil
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

from annotate import ROOT, frame_rate, highlight, run, shows_status_panel

# How each outline arrives, as in annotate.py: the screen is shown untouched first, so it reads as
# the program's own, then the outline fades in and stays until the screen changes. MIN_HOLD_S (fade
# included) catches a screen the tape cut too short.
DELAY_S = 0.8
FADE_S = 0.3
MIN_HOLD_S = 1.8

# How each key caption comes and goes, around the first frame of the screen its key drew.
CAPTION_LEAD_S = 0.4
CAPTION_FADE_IN_S = 0.12
CAPTION_TRAIL_S = 0.5
CAPTION_FADE_OUT_S = 0.2

Box = tuple[int, int, int, int]
Shows = Callable[[Image.Image], bool]


@dataclass
class Highlight:
    label: str
    # The pixel box (left, top, right, bottom) the outline goes around.
    box: Box
    # Whether a frame shows the screen this outline belongs on. Each unbroken run of such frames is
    # one showing of it, and the outline goes on the `nth` of `runs` showings (counting from 0).
    shows: Shows
    runs: int = 1
    nth: int = 0


@dataclass
class Caption:
    # The key, as its keycap reads.
    key: str
    # Whether a frame shows the screen the key draws, counted as Highlight's: the caption goes on
    # the first frame of the `nth` of `runs` showings, and on the frames around it.
    shows: Shows
    runs: int = 1
    nth: int = 0


def count_pixels(frame: Image.Image, box: Box, close: Callable[[tuple[int, int, int]], bool]) -> int:
    return sum(1 for p in frame.crop(box).getdata() if close(p))


def any_text(frame: Image.Image, box: Box) -> bool:
    """Whether the box holds any of the terminal's foreground text (zinc-100, #f4f4f5)."""
    bright = [band.point(lambda v: 255 if v > 200 else 0) for band in frame.crop(box).split()]
    return ImageChops.multiply(ImageChops.multiply(bright[0], bright[1]), bright[2]).getbbox() is not None


def runs_of(flags: list[bool]) -> list[tuple[int, int]]:
    """The first and last index of each unbroken run of True."""
    runs: list[tuple[int, int]] = []
    for index, flag in enumerate(flags):
        if flag and (index == 0 or not flags[index - 1]):
            runs.append((index, index))
        elif flag:
            runs[-1] = (runs[-1][0], index)
    return runs


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


def prompt_waits_on_row(n: int) -> Shows:
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
# 1200x850 frames of a 102x35 terminal in Menlo 18: the Extensions screen's two-pane layout, with
# extensions-gif-rc.sh's seed. The sentry-cli boxes are on the Global table's fifth row, with the
# cursor on it; a different font or size, or another set or order of Global skills, moves them.
SENTRY_ROW: Box = (355, 347, 828, 372)
SENTRY_CURSOR: Box = (364, 355, 372, 365)  # the table's pink ✦, on this row
SENTRY_TAG: Box = (700, 350, 830, 369)  # where the row says `unused` (amber) or `off here` (grey)
SKILLS_TAB: Box = (925, 176, 996, 192)  # `Skills` in the top-right kind bar, pink while chosen
MCP_TAB: Box = (1026, 176, 1066, 192)  # `MCP` beside it
DIALOG_QUESTION: Box = (44, 216, 66, 240)  # the start of a dialog's bold question, where no pane draws
MATRIX_DOTS: Box = (300, 200, 1100, 500)  # the matrix's green "on" dots

# The keycap: zinc-800 with a zinc-500 edge and zinc-100 text, right-aligned in the corner under
# the hint bar. 24px text is 16px in the README's 800px-wide view.
CAPTION_RIGHT = 1164
CAPTION_BOTTOM = 826
CAPTION_TEXT_PX = 24
FONTS = [("/System/Library/Fonts/Menlo.ttc", 1), ("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", 0)]


def is_cursor(p: tuple[int, int, int]) -> bool:
    return p[0] > 200 and p[1] < 110 and p[2] > 120


def is_pink(p: tuple[int, int, int]) -> bool:
    return p[0] > 200 and p[1] < 120 and p[2] > 120


def is_amber(p: tuple[int, int, int]) -> bool:
    return p[0] > 150 and 100 < p[1] < 175 and p[2] < 90


def is_grey(p: tuple[int, int, int]) -> bool:
    return 70 < p[0] < 150 and max(p) - min(p) < 16


def is_green(p: tuple[int, int, int]) -> bool:
    return p[1] > 150 and p[0] < 80 and p[2] < 160


def sentry_row(tag: str) -> Shows:
    """Whether the cursor is on sentry-cli's row, and the row reads `unused` or `off here`."""

    def shows(frame: Image.Image) -> bool:
        if count_pixels(frame, SENTRY_CURSOR, is_cursor) < 5:
            return False
        amber = count_pixels(frame, SENTRY_TAG, is_amber)
        grey = count_pixels(frame, SENTRY_TAG, is_grey)
        return amber > 20 if tag == "unused" else (amber == 0 and grey > 20)

    return shows


def extensions_screen(frame: Image.Image) -> bool:
    """The Extensions screen, on Skills or MCP: the dashboard has no kind bar."""
    return count_pixels(frame, SKILLS_TAB, is_pink) + count_pixels(frame, MCP_TAB, is_pink) > 20


def dialog(frame: Image.Image) -> bool:
    return extensions_screen(frame) and count_pixels(frame, DIALOG_QUESTION, lambda p: min(p) > 200) > 40


def mcp_tab(frame: Image.Image) -> bool:
    return count_pixels(frame, MCP_TAB, is_pink) > 10


def matrix(frame: Image.Image) -> bool:
    return mcp_tab(frame) and count_pixels(frame, MATRIX_DOTS, is_green) > 50


EXTENSIONS = [
    # After y: the row reads `off here`.
    Highlight("sentry-cli - off here", SENTRY_ROW, sentry_row("off here")),
    # After the undo: `unused` again. The cursor first stood on the row before space; this is the
    # second time.
    Highlight("sentry-cli - back on", SENTRY_ROW, sentry_row("unused"), runs=2, nth=1),
]

EXTENSIONS_CAPTIONS = [
    Caption("enter", extensions_screen),  # on the dashboard's Extensions entry
    Caption("space", dialog, runs=2, nth=0),  # Turn off sentry-cli in this project?
    Caption("y", sentry_row("off here")),
    Caption("u", dialog, runs=2, nth=1),  # Undo: Turned off sentry-cli in this project?
    Caption("y", sentry_row("unused"), runs=2, nth=1),
    Caption("2", mcp_tab),  # the MCP servers, then (still on MCP) the matrix
    Caption("m", matrix),
]

GIFS = {"routing": (ROUTING, []), "extensions": (EXTENSIONS, EXTENSIONS_CAPTIONS)}


def load_font() -> ImageFont.FreeTypeFont:
    for path, index in FONTS:
        if Path(path).exists():
            return ImageFont.truetype(path, CAPTION_TEXT_PX, index=index)
    raise SystemExit(f"no font for the key captions; looked for {', '.join(path for path, _ in FONTS)}")


def keycap(frame: Image.Image, key: str, strength: float, font: ImageFont.FreeTypeFont) -> Image.Image:
    """The frame with `key`'s keycap in the corner at `strength` (0 = none, 1 = fully drawn)."""
    left, top, right, bottom = font.getbbox(key)
    text_w, text_h = right - left, bottom - top
    width = max(56, text_w + 32)
    height = text_h + 20
    x1, y1 = CAPTION_RIGHT, CAPTION_BOTTOM
    x0, y0 = x1 - width, y1 - height
    layer = Image.new("RGBA", frame.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    alpha = round(255 * strength)
    # A darker base under the cap, so it reads as a key and not a label.
    draw.rounded_rectangle((x0, y0 + 4, x1, y1), radius=9, fill=(9, 9, 11, alpha))
    draw.rounded_rectangle(
        (x0, y0, x1, y1 - 4), radius=9, fill=(39, 39, 42, alpha), outline=(113, 113, 122, alpha), width=2
    )
    text_at = (x0 + (width - text_w) / 2 - left, y0 + (height - 4 - text_h) / 2 - top)
    draw.text(text_at, key, font=font, fill=(244, 244, 245, alpha))
    return Image.alpha_composite(frame.convert("RGBA"), layer).convert("RGB")


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in GIFS:
        raise SystemExit(f"usage: python3 scripts/demo/outline.py {'|'.join(GIFS)}")
    name = sys.argv[1]
    spots, captions = GIFS[name]
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
    edited: dict[int, Image.Image] = {}
    num, den = (int(n) for n in rate.split("/"))
    seconds = lambda index: index * den / num  # noqa: E731
    frames_for = lambda secs: round(secs * num / den)  # noqa: E731
    delay, fade = frames_for(DELAY_S), max(1, frames_for(FADE_S))

    def showing(label: str, shows: Shows, expected: int, nth: int) -> tuple[int, int]:
        runs = runs_of([shows(frame) for frame in frames])
        if len(runs) != expected:
            raise SystemExit(f"{label}: found its screen {len(runs)} times in the recording, expected {expected}")
        return runs[nth]

    for spot in spots:
        first, last = showing(spot.label, spot.shows, spot.runs, spot.nth)
        start = first + delay  # first frame the outline shows in, faintly
        full = start + fade - 1  # first frame at full strength
        held = seconds(last - start + 1)
        print(
            f"{spot.label}: frames {first + 1}-{last + 1} ({seconds(first):.2f}s-{seconds(last + 1):.2f}s), "
            f"outline fades in {seconds(start):.2f}s-{seconds(full + 1):.2f}s (frames {start + 1}-{full + 1}), "
            f"holds to {seconds(last + 1):.2f}s ({held:.2f}s)"
        )
        if held < MIN_HOLD_S:
            raise SystemExit(
                f"that outline is up for {held:.2f}s; hold the screen longer in {name}.tape (>= {MIN_HOLD_S}s)"
            )
        for index in range(start, last + 1):
            strength = min(1.0, (index - start + 1) / fade)
            edited[index] = highlight(frames[index], spot.box, strength)

    if captions:
        font = load_font()
        lead, fade_in = frames_for(CAPTION_LEAD_S), max(1, frames_for(CAPTION_FADE_IN_S))
        trail, fade_out = frames_for(CAPTION_TRAIL_S), max(1, frames_for(CAPTION_FADE_OUT_S))
        for caption in captions:
            change, _ = showing(f"key {caption.key}", caption.shows, caption.runs, caption.nth)
            first, last = change - lead, change + trail - 1
            # The lead-in must be the screen the key was pressed on, unchanged: a caption over another
            # change would put the cause in the wrong place.
            if first < 1 or any(frames[i].tobytes() != frames[change - 1].tobytes() for i in range(first, change)):
                raise SystemExit(
                    f"key {caption.key}: the screen changes within {CAPTION_LEAD_S}s before frame {change + 1}"
                )
            print(
                f"key {caption.key}: screen changes at frame {change + 1} ({seconds(change):.2f}s), "
                f"caption frames {first + 1}-{last + 1} ({seconds(first):.2f}s-{seconds(last + 1):.2f}s)"
            )
            for index in range(first, last + 1):
                strength = min(1.0, (index - first + 1) / fade_in, (last - index + 1) / fade_out)
                edited[index] = keycap(edited.get(index, frames[index]), caption.key, strength, font)

    for index, frame in edited.items():
        frame.save(paths[index])

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
