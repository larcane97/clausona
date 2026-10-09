// Records the Extensions screen at several terminal sizes as PNG screenshots, for review.
//   pnpm build && node scripts/demo/extensions-shots.mjs [140 100 72 60 80x24]
// An entry is `<cols>`, a terminal that many columns wide and 900px tall, or `<cols>x<rows>`.
// Needs vhs and Docker, like demo.tape; everything runs in the throwaway demo container.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
// The folder of seed-extensions.mjs's never-used skill, which the tape mounts into the container
// (see the comment there).
mkdirSync(path.join(build, "db-migrate"), { recursive: true });
/** The width from which the screen sets the scope list and the table side by side (screen-model.ts). */
const TWO_PANES_FROM = 100;

/**
 * The keys to each shot, and a regexp the screen matches once they have landed: the tape waits
 * for it, so a shot that misses its screen stops the run instead of saving the wrong one. Esc
 * steps out one level - details, table, scope list - and once more leaves the screen, so no
 * step presses one too many. Under 100 columns the screen shows one pane at a time, and there
 * a scope's table shows only on → (`open`), where two panes show it beside the list: a step
 * whose two-pane shot shows a table goes in, and the next one comes back out on ← (`back`).
 */
const steps = (onePane) => {
  const open = onePane ? ["Right"] : [];
  const back = onePane ? ["Left"] : [];
  const intoTable = onePane ? [] : ["Right"];
  return [
    ["01-loaded", [], "Loaded here\\s+\\d+"],
    ["02-global", ["Down", "Down", ...open], "GLOBAL — "],
    // Past Cloud, Plugins and Other projects to Not used in 90 days, the last scope.
    ["03-unused", [...back, "Down", "Down", "Down", "Down", ...open], "NOT USED IN 90 DAYS — "],
    // db-migrate, the never-used project skill, is the first row.
    ["04-details", [...intoTable, "Enter"], "PROJECT › db-migrate"],
    ["05-codex", ["Escape", "Escape", "Tab", ...open], "LOADED HERE — what Codex"],
    ["06-claude-mcp", ["Tab", "Type 2", ...open], "LOADED HERE — what Claude Code loads[\\s\\S]*docs-search"],
    // github, the second row: off in the work account here.
    ["07-mcp-details", [...intoTable, "Down", "Enter"], "GLOBAL › github"],
    ["08-matrix", ["Escape", "Type m"], "SERVER"],
    ["09-hooks", ["Escape", "Type 3", ...open], "LOADED HERE — what Claude Code runs"],
    // Past Project, Global and Plugins to Other projects, the last scope, then web, its one row.
    ["10-other-projects", [...back, "Down", "Down", "Down", "Down", "Right", "Enter"], "OTHER PROJECTS › web"],
    // 1 for Skills: the search is in the table on screen, and Hooks has no eli.
    ["11-search", ["Escape", "Escape", "Type 1", "Type /", "Type eli", "Enter"], "(?m)\\Weli *$"],
    ["12-picker", ["Escape", "Type p"], "Show the inventory as seen from:"],
  ];
};

for (const { columns, rows } of SIZES) {
  const size = rows ? `${columns}x${rows}` : `${columns}`;
  const width = Math.round(columns * CHAR_PX + 2 * PAD + EDGE_X);
  const height = rows ? Math.round(rows * LINE_PX + 2 * PAD + EDGE_Y) : DEFAULT_HEIGHT;
  const lineCount = rows ?? Math.floor((DEFAULT_HEIGHT - 2 * PAD - FRAME_Y) / LINE_PX);
  // This size's shots from an earlier run go first, so the folder holds this run's alone.
  for (const file of readdirSync(build)) {
    if (file.startsWith(`ext-${size}-`) && file.endsWith(".png")) rmSync(path.join(build, file));
  }
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
    'Type `docker build -q -t clausona-demo scripts/demo >/dev/null && docker run --rm -it --network none -e HOME=/Users/alex -e TZ=UTC -e TERM=xterm-256color -e COLORTERM=truecolor -w /Users/alex -v "$PWD/dist:/opt/clausona:ro" -v "$PWD/scripts/demo:/opt/demo:ro" -v "$PWD/scripts/demo/.build/db-migrate:/Users/alex/app/.claude/skills/db-migrate" clausona-demo bash --rcfile /opt/demo/extensions-rc.sh -i`',
    "Enter",
    "Wait+Screen@300s /^\\$\\s*$/",
    'Type "tput cols; tput lines"',
    "Enter",
    // The terminal is the size asked for, or the run stops here.
    `Wait+Screen@10s /(?m)^${columns}\\n${lineCount}$/`,
    'Type "clear; csn"',
    "Enter",
    "Wait+Screen@60s /Extensions/",
    // The dashboard draws its rows a moment before it takes keys: sent at once, they can be lost.
    "Sleep 1s",
    "Down",
    "Down",
    "Enter",
    "Wait+Screen@60s /Loaded here\\s+\\d+/",
    "Sleep 500ms",
    "Show",
  ];
  for (const [name, keys, screen] of steps(columns < TWO_PANES_FROM)) {
    for (const key of keys) lines.push(key.startsWith("Type ") ? `Type "${key.slice(5)}"` : key, "Sleep 300ms");
    // vhs saves a screenshot from the next frame it records; the sleep after it lets that frame
    // come before the next step's first key.
    lines.push(
      `Wait+Screen@15s /${screen}/`,
      "Sleep 400ms",
      `Screenshot ${build}/ext-${size}-${name}.png`,
      "Sleep 200ms",
    );
  }
  const tape = path.join(build, `ext-${size}.tape`);
  writeFileSync(tape, `${lines.join("\n")}\n`);
  execFileSync("vhs", [tape], { stdio: "inherit" });
}
