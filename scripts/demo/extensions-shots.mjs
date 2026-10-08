// Records the Extensions screen at several terminal sizes as PNG screenshots, for review.
//   pnpm build && node scripts/demo/extensions-shots.mjs [140 100 72 60 80x24]
// An entry is `<cols>`, a terminal that many columns wide and 900px tall, or `<cols>x<rows>`.
// Needs vhs and Docker, like demo.tape; everything runs in the throwaway demo container.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const entries = process.argv.slice(2);
const SIZES = (entries.length ? entries : ["140", "100", "72", "60", "80x24"]).map((entry) => {
  const match = /^(\d+)(?:x(\d+))?$/.exec(entry);
  if (!match) {
    console.error(`extensions-shots.mjs: "${entry}" is not <cols> or <cols>x<rows>.`);
    process.exit(1);
  }
  return { columns: Number(match[1]), rows: match[2] ? Number(match[2]) : undefined };
});
// vhs 0.10 draws Menlo 16 in a 10 by 19 px cell, and the terminal gets the frame less the padding
// and another 25 px across and 10 px down: measured with `tput cols` and `tput lines` (Step 4).
// Half a cell more each way, so a pixel either side still gives the same count.
const CHAR_PX = 10;
const LINE_PX = 19;
const PAD = 20;
const FRAME_X = 25;
const FRAME_Y = 10;
const EDGE_X = FRAME_X + CHAR_PX / 2;
const EDGE_Y = FRAME_Y + LINE_PX / 2;
const DEFAULT_HEIGHT = 900;
const build = path.join("scripts", "demo", ".build");
mkdirSync(build, { recursive: true });

/**
 * The keys to each shot. `listMode` is a size where the detail has no pane of its own - under 64
 * columns or 28 rows, as the screen's pickLayout has it: there enter opens a row's detail and esc
 * closes it, while anywhere else esc on the list would leave the screen.
 */
const steps = (listMode) => [
  ["01-skills", []],
  ["02-detail-duplicate", ["Type /", "Type eli5", "Enter", "Down"]],
  ["03-filter-cleanup", ["Escape", "Type f", "Type f"]],
  ["04-filter-duplicates", ["Type f"]],
  ["05-mcp", ["Type f", "Type f", "Tab"]],
  // github, under the User group's header and docs: its env holds a token, shown by name only.
  ["05b-mcp-detail", ["Down", "Down", ...(listMode ? ["Enter"] : [])]],
  ["06-mcp-matrix", [...(listMode ? ["Escape"] : []), "Type m"]],
  ["07-hooks", ["Escape", "Tab"]],
  ["08-project-picker", ["Type p"]],
  ["09-plugin-search", ["Escape", "Tab", "Type /", "Type superpowers", "Enter"]],
  ["10-warnings", ["Escape", "Type w"]],
  ["11-narrow-enter", ["Escape", "Down", "Enter"]],
];

for (const { columns, rows } of SIZES) {
  const size = rows ? `${columns}x${rows}` : `${columns}`;
  const width = Math.round(columns * CHAR_PX + 2 * PAD + EDGE_X);
  const height = rows ? Math.round(rows * LINE_PX + 2 * PAD + EDGE_Y) : DEFAULT_HEIGHT;
  const lineCount = rows ?? Math.floor((DEFAULT_HEIGHT - 2 * PAD - FRAME_Y) / LINE_PX);
  const listMode = columns < 64 || lineCount < 28;
  const lines = [
    `Output ${build}/ext-${size}.gif`,
    "Require docker",
    'Set Shell "bash"',
    "Set FontSize 16",
    'Set FontFamily "Menlo"',
    `Set Width ${width}`,
    `Set Height ${height}`,
    `Set Padding ${PAD}`,
    "Set TypingSpeed 20ms",
    'Set Theme { "name": "clausona", "background": "#18181b", "foreground": "#f4f4f5", "cursor": "#ec4899", "selection": "#3f3f46", "black": "#18181b", "red": "#ef4444", "green": "#10b981", "yellow": "#f59e0b", "blue": "#6366f1", "magenta": "#ec4899", "cyan": "#22d3ee", "white": "#e4e4e7", "brightBlack": "#71717a", "brightRed": "#f87171", "brightGreen": "#34d399", "brightYellow": "#fbbf24", "brightBlue": "#818cf8", "brightMagenta": "#f472b6", "brightCyan": "#67e8f9", "brightWhite": "#f4f4f5" }',
    "Hide",
    'Type `docker build -q -t clausona-demo scripts/demo >/dev/null && docker run --rm -it --network none -e HOME=/Users/alex -e TZ=UTC -e TERM=xterm-256color -e COLORTERM=truecolor -w /Users/alex -v "$PWD/dist:/opt/clausona:ro" -v "$PWD/scripts/demo:/opt/demo:ro" clausona-demo bash --rcfile /opt/demo/extensions-rc.sh -i`',
    "Enter",
    "Wait+Screen@300s /^\\$\\s*$/",
    'Type "tput cols; tput lines"',
    "Enter",
    "Sleep 500ms",
    "Show",
    // vhs saves a screenshot from the next frame it records, and it records none while hidden.
    `Screenshot ${build}/ext-${size}-00-cols.png`,
    "Sleep 200ms",
    "Hide",
    'Type "clear; csn"',
    "Enter",
    "Wait+Screen@60s /Extensions/",
    // The dashboard draws its rows a moment before it takes keys: sent at once, they can be lost.
    "Sleep 1s",
    "Down",
    "Down",
    "Enter",
    "Wait+Screen@60s /Skills \\d+/",
    "Sleep 500ms",
    "Show",
  ];
  for (const [name, keys] of steps(listMode)) {
    for (const key of keys) lines.push(key.startsWith("Type ") ? `Type "${key.slice(5)}"` : key, "Sleep 300ms");
    // The sleep after the screenshot lets that next frame come before the next step's first key.
    lines.push("Sleep 400ms", `Screenshot ${build}/ext-${size}-${name}.png`, "Sleep 200ms");
  }
  const tape = path.join(build, `ext-${size}.tape`);
  writeFileSync(tape, `${lines.join("\n")}\n`);
  execFileSync("vhs", [tape], { stdio: "inherit" });
}
