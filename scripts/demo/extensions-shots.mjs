// Records the Extensions screen at several terminal sizes as PNG screenshots, for review.
//   pnpm build && node scripts/demo/extensions-shots.mjs [140 100 72 60 80x24]
// An entry is `<cols>`, a terminal that many columns wide and 900px tall, or `<cols>x<rows>`.
// Needs vhs and Docker, like demo.tape; everything runs in the throwaway demo container.
//
// To try the writes by hand, or for an agent to test them: the same container without the
// db-migrate mount, so every unused skill can be deleted (run after `pnpm build`).
//   docker run --rm -it --network none -e HOME=/Users/alex -e TZ=UTC -w /Users/alex/app -v "$PWD/dist:/opt/clausona:ro" -v "$PWD/scripts/demo:/opt/demo:ro" clausona-demo bash --rcfile /opt/demo/extensions-rc.sh -i
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
 * The action keys - space, d, x - work on the table's rows, so for them both layouts go into
 * the table (`table`) and back out to the scopes (`scopes`). A `Wait <regexp>` among the keys
 * waits for that screen before the keys after it.
 */
const steps = (onePane) => {
  const open = onePane ? ["Right"] : [];
  const back = onePane ? ["Left"] : [];
  const intoTable = onePane ? [] : ["Right"];
  const table = ["Right"];
  const scopes = ["Left"];
  const down = (n) => Array.from({ length: n }, () => "Down");
  return [
    // The project row on top names the project everything is seen from.
    ["01-loaded", [], "▾ app \\(here\\)[\\s\\S]*Loaded\\s+\\d+"],
    // The project's own skills: its eli5 is hidden by the Global one.
    ["02a-project", ["Down", ...open], "hidden by Global copy"],
    ["02-global", [...back, "Down", ...open], "GLOBAL — "],
    // Past Cloud and Plugins to Not used in 90 days, the last scope.
    ["03-unused", [...back, "Down", "Down", "Down", ...open], "NOT USED IN 90 DAYS — "],
    // db-migrate, the never-used project skill, is the first row.
    ["04-details", [...intoTable, "Enter"], "PROJECT › db-migrate"],
    ["05-codex", ["Escape", "Escape", "Tab", ...open], "LOADED — what Codex"],
    ["06-claude-mcp", ["Tab", "Type 2", ...open], "LOADED — what Claude Code loads[\\s\\S]*docs-search"],
    // github, the third row, after docs-search and figma: off in the work account here.
    ["07-mcp-details", [...intoTable, "Down", "Down", "Enter"], "GLOBAL › github"],
    ["08-matrix", ["Escape", "Type m"], "SERVER"],
    ["09-hooks", ["Escape", "Type 3", ...open], "LOADED — what Claude Code runs"],
    // The project list, in the scope list's place: app first, then web, then No project.
    ["10-projects", [...back, "Type p"], "PROJECT\\s+hooks"],
    // web picked: every scope is seen from it - the subtitle and the row say so - back on Loaded.
    // \x2F for the slash, which would end the tape's /regexp/.
    ["10b-web", ["Down", "Enter"], "~\\x2Fweb[\\s\\S]*▾ web[\\s\\S]*▸ Loaded"],
    // 1 for Skills: the search is in the table on screen, and Hooks has no eli.
    ["11-search", ["Type 1", "Type /", "Type eli", "Enter"], "(?m)\\Weli *$"],
    // The list again, seen from web: web first, and app still (here).
    ["12-projects-from-web", ["Escape", "Type p"], "PROJECT\\s+skills[\\s\\S]*web[\\s\\S]*app \\(here\\)"],
    // The writes, from app again. Not used in 90 days, by name: db-migrate, which is mounted from
    // the host and so cannot be moved, then the two Global rows, gone-helper and sentry-cli.
    [
      "13-marked",
      ["Down", "Enter", "Wait ▾ app \\(here\\)", "Type 1", ...down(5), ...table, "Down", "Type x", "Down", "Type x"],
      "2 marked",
    ],
    // gone-helper is a link: only the link goes.
    ["14-confirm-delete", ["Type d"], "Delete 2 skills\\?[\\s\\S]*link only, target kept"],
    ["15-deleted", ["Type y"], "Deleted 2 skills · u to undo"],
    ["16-undo-confirm", ["Type u"], "Undo: Deleted 2 skills\\?"],
    ["17-undone", ["Type y"], "Undid: Deleted 2 skills"],
    // Up past Plugins to Cloud: its pdf comes back from claude.ai, so d says why not.
    ["18-refusal", [...scopes, "Up", "Up", ...table, "Type d"], "It comes back from claude\\.ai"],
    // MCP's Global, past Project and Parent folders: figma, on in both accounts, is its first row.
    // The question names the accounts it changes in, cut at the narrow sizes.
    [
      "19-picker",
      ["Type 2", ...down(3), ...table, "Space"],
      "Turn off figma in this project[\\s\\S]*◉ personal[\\s\\S]*◉ work",
    ],
    ["20-off", ["Type y"], "Turned off figma in this project"],
    // eli5, Global's second row: its details end with the keys that apply to it, on one line or
    // two. Page down scrolls to that end where the details do not all fit, as in 24 rows.
    [
      "21-details-actions",
      ["Type 1", ...down(2), ...table, "Down", "Enter", "PageDown"],
      "space off here[\\s\\S]*g off everywhere[\\s\\S]*d delete[\\s\\S]*v name\\s+only",
    ],
    ["22-visibility", ["Type v"], "Show eli5 as name only in this project\\?"],
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
    "Wait+Screen@60s /Loaded\\s+\\d+/",
    "Sleep 500ms",
    "Show",
  ];
  for (const [name, keys, screen] of steps(columns < TWO_PANES_FROM)) {
    for (const key of keys) {
      if (key.startsWith("Wait ")) lines.push(`Wait+Screen@15s /${key.slice(5)}/`, "Sleep 300ms");
      else lines.push(key.startsWith("Type ") ? `Type "${key.slice(5)}"` : key, "Sleep 300ms");
    }
    // vhs saves a screenshot from the next frame it records; the sleep after it lets that frame
    // come before the next step's first key.
    lines.push(
      `Wait+Screen@15s /${screen}/`,
      "Sleep 400ms",
      `Screenshot ${build}/ext-${size}-${name}.png`,
      "Sleep 200ms",
    );
  }
  // The last dialog cancelled: nothing it asked about is changed.
  lines.push("Escape", "Wait+Screen@15s /Nothing changed\\./");
  const tape = path.join(build, `ext-${size}.tape`);
  writeFileSync(tape, `${lines.join("\n")}\n`);
  execFileSync("vhs", [tape], { stdio: "inherit" });
}
