import { createInterface } from "node:readline";

import { type RouteSpec, STRATEGIES, type Strategy, withDefaults } from "../core/route-config.js";
import type { Ranking } from "../core/routing.js";
import type { ToolName } from "../types.js";
import { renderCreateScreen, skipText, usageText } from "./route-render.js";

/** The terminal, as the creation screen sees it. Injected in tests. */
export type RouteIo = {
  interactive: boolean;
  /** One answer, trimmed; null when the input closed (Ctrl-D) or on Ctrl-C. */
  ask: (question: string) => Promise<string | null>;
  say: (text: string) => void;
};

/**
 * Prompts on `stream` and reads `input` (stdin; a test passes its own). `clausona run` passes stderr,
 * so a routed run whose stdout is piped (`-p … > out.txt`) still asks on the terminal and keeps the
 * file clean.
 */
export function terminalIo(
  stream: NodeJS.WriteStream = process.stderr,
  input: NodeJS.ReadStream = process.stdin,
): RouteIo {
  return {
    interactive: input.isTTY === true && stream.isTTY === true,
    ask: (question) =>
      new Promise((resolve) => {
        // An input that has already ended never emits `close` again: the question would wait forever.
        if (input.readableEnded) {
          resolve(null);
          return;
        }
        const rl = createInterface({ input, output: stream });
        let done = false;
        const finish = (answer: string | null) => {
          if (done) return;
          done = true;
          resolve(answer === null ? null : answer.trim());
          // Closing emits `close`, which the flag above has already made a no-op.
          rl.close();
        };
        // Ctrl-D and Ctrl-C leave the cursor after the question, so whatever is said next starts a line.
        const cancel = () => {
          if (!done) stream.write("\n");
          finish(null);
        };
        rl.on("close", cancel);
        rl.on("SIGINT", cancel);
        rl.question(question, (answer) => finish(answer));
      }),
    say: (text) => {
      stream.write(`${text}\n`);
    },
  };
}

export function toggleSelection(selected: boolean[], answer: string): boolean[] | null {
  const next = [...selected];
  for (const word of answer.split(/[\s,]+/).filter(Boolean)) {
    const n = Number(word);
    if (!Number.isInteger(n) || n < 1 || n > next.length) return null;
    next[n - 1] = !next[n - 1];
  }
  return next;
}

export async function askTool(io: RouteIo): Promise<ToolName | undefined> {
  const answer = (await io.ask("Tool for this route [claude/codex]: "))?.toLowerCase();
  return answer === "claude" || answer === "codex" ? answer : undefined;
}

/**
 * The checklist behind `e`: every subscription profile of the tool, ticked if it is in the pool
 * `shown` (the screen's ranking of `spec`), then the strategy. Null when the input closes or on
 * Ctrl-C, which creates nothing, as on the screen itself.
 */
async function editSelection(
  spec: RouteSpec,
  shown: Ranking,
  io: RouteIo,
  preview: (spec: RouteSpec) => Promise<Ranking>,
): Promise<RouteSpec | null> {
  const everyone = (await preview({ ...spec, from: ["*"], exclude: [], fallback: [] })).rows;
  const inPool = new Set(shown.rows.filter((row) => row.role === "pool").map((row) => row.id));
  const initial = everyone.map((row) => inPool.has(row.id));
  let selected = initial;
  if (everyone.length === 0) {
    io.say(`No ${spec.tool} subscription profile is registered; the pool stays as it is.`);
  } else {
    const width = Math.max(...everyone.map((row) => row.id.length));
    for (;;) {
      io.say(
        everyone
          .map(
            (row, i) =>
              `  ${String(i + 1).padStart(2)} [${selected[i] ? "x" : " "}] ${row.id.padEnd(width)}  ${row.skip ? skipText(row) : usageText(row.usage)}`,
          )
          .join("\n"),
      );
      const answer = await io.ask("Toggle by number (e.g. 2 5), Enter when done: ");
      if (answer === null) return null;
      if (answer === "") break;
      const next = toggleSelection(selected, answer);
      if (next) selected = next;
      else io.say(`Numbers from 1 to ${everyone.length}.`);
    }
  }
  const current = withDefaults(spec).strategy;
  const answer = await io.ask(`Strategy [${current}] (${STRATEGIES.join(", ")}): `);
  if (answer === null) return null;
  const strategy = answer.toLowerCase();
  const next: RouteSpec = { ...spec };
  if (STRATEGIES.includes(strategy as Strategy)) next.strategy = strategy as Strategy;
  else if (strategy) io.say(`Unknown strategy; keeping ${current}.`);

  // Left as it was, the checklist keeps the patterns, so a glob still takes accounts added later.
  if (selected.every((ticked, i) => ticked === initial[i])) return next;
  // Everyone ticked under `*` keeps `*` too; an account ticked back is no longer excluded.
  if (selected.every(Boolean) && withDefaults(spec).from.includes("*")) {
    delete next.exclude;
    return next;
  }
  const chosen = everyone.filter((_, i) => selected[i]).map((row) => row.id.slice(spec.tool.length + 1));
  if (chosen.length === 0) {
    io.say("A route needs at least one account; keeping the pool as it was.");
    return next;
  }
  next.from = chosen;
  delete next.exclude;
  return next;
}

/**
 * Shows what would be created - the pool with each account's state, the strategy and the
 * limits - and asks Y / e / n. Resolves to the spec to create, or null for nothing.
 */
export async function confirmNewRoute(
  name: string,
  spec: RouteSpec,
  io: RouteIo,
  preview: (spec: RouteSpec) => Promise<Ranking>,
  andRun: boolean,
): Promise<RouteSpec | null> {
  let current = spec;
  for (;;) {
    const ranking = await preview(current);
    const { body, question } = renderCreateScreen(name, current, ranking, andRun);
    io.say(body);
    const answer = await io.ask(question);
    if (answer === null) return null;
    const normalized = answer.toLowerCase();
    if (normalized === "" || normalized === "y" || normalized === "yes") return current;
    if (normalized === "n" || normalized === "no") return null;
    if (normalized === "e" || normalized === "edit") {
      const edited = await editSelection(current, ranking, io, preview);
      if (edited === null) return null;
      current = edited;
      continue;
    }
    io.say("Answer y, e or n.");
  }
}
