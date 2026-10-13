import { createHash } from "node:crypto";
import path from "node:path";

import { parse, TomlDate } from "smol-toml";

import type { Collector, Location, StateFacts } from "../model.js";
import { isRecord, readText, realPath } from "../read.js";
import { addHooks } from "./claude-hooks.js";

/**
 * Codex's hook trust, as Codex 0.159.3 keeps it (codex-rs/hooks, engine/discovery.rs). Codex runs
 * a hook it does not manage only once the user has reviewed it: `[hooks.state."<key>"]` in the
 * user config.toml then holds `trusted_hash`, the hash of the hook's definition at the time, and
 * a hook whose definition changed since is to be reviewed again. `enabled = false` there turns
 * one hook off. The key is where the hook is - `<source>:<event>:<group>:<index>` - and the
 * source is the path of the hooks file, or of the config.toml that holds it, or for a plugin
 * `<plugin id>:<path in the plugin>`.
 */

/** Codex's hook events, by the name a hooks file gives them, with the label its keys and hashes use. */
const EVENTS: Readonly<Record<string, string>> = {
  PreToolUse: "pre_tool_use",
  PermissionRequest: "permission_request",
  PostToolUse: "post_tool_use",
  PreCompact: "pre_compact",
  PostCompact: "post_compact",
  SessionStart: "session_start",
  SessionEnd: "session_end",
  UserPromptSubmit: "user_prompt_submit",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  Stop: "stop",
  Interrupt: "interrupt",
};

/** The events whose matcher Codex reads; the others ignore it, in the hash too. */
const WITH_MATCHER = new Set([
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "SessionEnd",
  "SubagentStart",
  "SubagentStop",
]);

/** The events that can give the model context, so take `additionalContextLimit`. */
const CONTEXT_EVENTS = new Set(["PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit", "SubagentStart"]);

/** The context limit Codex uses by default, which it leaves out of the hash when given. */
const DEFAULT_CONTEXT_LIMIT = 2500;

/**
 * Bundled plugins' cleanup hooks, which Codex runs without a review: an MCP tool call, with no
 * matcher, on these events (codex-rs/plugin bundled_hooks.rs).
 */
const BUNDLED: readonly { plugins: readonly string[]; server: string; tool: string }[] = [
  {
    plugins: [
      "browser@openai-bundled",
      "chrome@openai-bundled",
      "chrome-dev@openai-bundled",
      "chrome-internal@openai-bundled",
      "computer-use@openai-bundled",
    ],
    server: "node_repl",
    tool: "turn_ended",
  },
  { plugins: ["unified-computer-use@openai-bundled"], server: "cua_repl", tool: "turn_ended" },
];
const BUNDLED_EVENTS = new Set(["Stop", "Interrupt", "SubagentStop"]);

/**
 * The trust identity of each hook in one hooks file's events - `hooks[event][group].hooks[index]`,
 * as addHooks reads them, under the same ids (`<idBase>:<event>#<at><group>.<index>`) - into the
 * facts: the key under each of `sources`, and the hash Codex trusts it at. A hook Codex does not
 * run whatever its trust - a prompt or agent hook, an empty command - has none. `plugin` is the
 * plugin's id, for the cleanup hooks Codex runs without a review.
 */
export function addCodexHookTrust(
  events: unknown,
  idBase: string,
  sources: readonly string[],
  facts: StateFacts,
  plugin?: string,
  at = "",
): void {
  if (!isRecord(events)) return;
  for (const [event, groups] of Object.entries(events)) {
    const label = EVENTS[event];
    if (label === undefined || !Array.isArray(groups)) continue;
    groups.forEach((group, g) => {
      if (!isRecord(group) || !Array.isArray(group.hooks)) return;
      const raw = typeof group.matcher === "string" ? group.matcher : undefined;
      const matcher = WITH_MATCHER.has(event) ? raw : undefined;
      group.hooks.forEach((hook, h) => {
        const handler = normalized(event, hook);
        if (handler === undefined) return;
        const identity = { event_name: label, ...(matcher !== undefined ? { matcher } : {}), hooks: [handler] };
        facts.codexHookTrust.push({
          id: `${idBase}:${event}#${at}${g}.${h}`,
          keys: sources.map((source) => `${source}:${label}:${g}:${h}`),
          hash: hashOf(identity),
          ...(plugin !== undefined && raw === undefined && bundled(plugin, event, handler) ? { builtin: true } : {}),
        });
      });
    });
  }
}

/**
 * The hooks.json whose path keys the trust of a profile Codex runs with CODEX_HOME set: the one in
 * that folder as Codex makes it canonical first (find_codex_home), every link followed and, on
 * Windows, each 8.3 short name made long - as realpath does too. Undefined for a folder that is
 * not there, where Codex does not start. `real` and `paths` stand in for realpath and node:path in
 * a test.
 */
export async function codexHomeHooksFile(
  dir: string,
  real: (p: string) => Promise<string> = realPath,
  paths: Pick<typeof path, "join"> = path,
): Promise<string | undefined> {
  const canonical = await real(dir).catch(() => undefined);
  return canonical === undefined ? undefined : paths.join(canonical, "hooks.json");
}

/**
 * Whether Codex reads `json` as a hooks file: `hooks` and an optional `description`, and nothing
 * else at its top. Codex refuses any other file whole - one with its events at the top, as a
 * Claude plugin's may be written, or with a key such as `$schema` - and runs none of its hooks.
 */
export function codexReadsHooksFile(json: Record<string, unknown>): boolean {
  const known = Object.keys(json).every((key) => key === "hooks" || key === "description");
  return known && (json.hooks === undefined || isRecord(json.hooks));
}

/**
 * What the ids of a config.toml's hooks hold before their place, so that they are not those of
 * the hooks.json beside it.
 */
const CONFIG_HOOKS_AT = "config.toml:";

/**
 * The hooks a config.toml holds under `[hooks]` - `[[hooks.<Event>]]` tables, in the same shape
 * as a hooks.json's - which Codex 0.159.3 runs beside that folder's hooks.json, trusted the same
 * way, keyed by the config.toml's path. Its `[hooks.state]` tables are no event, and are skipped.
 * `exact` is the same `[hooks]` with its numbers as Codex reads them (exactConfigHooks).
 */
export function addConfigHooks(
  config: Record<string, unknown>,
  location: Location,
  owner: string,
  sources: readonly string[],
  out: Collector,
  exact?: unknown,
): void {
  if (!isRecord(config.hooks)) return;
  addHooks(config.hooks, location, owner, out, "hooks", CONFIG_HOOKS_AT);
  const idBase = `hook:${location.tool}:${location.scope}:${owner}`;
  addCodexHookTrust(exact ?? config.hooks, idBase, sources, out.facts, undefined, CONFIG_HOOKS_AT);
}

/**
 * Marks the Codex hooks Codex 0.159.3 never runs, whatever their trust, as it skips them: a
 * prompt or agent hook ("not supported yet"), and an MCP tool hook when a session ends. One in a
 * file Codex refuses keeps that reason.
 */
export function markUnsupportedHooks(out: Collector): void {
  for (const item of out.items) {
    if (item.kind !== "hook" || item.location.tool !== "codex" || item.codexError) continue;
    const type = item.summary?.type;
    const sessionEndTool = type === "mcp_tool" && item.hook?.event === "SessionEnd";
    if (type === "prompt" || type === "agent" || sessionEndTool) item.codexError = "not supported";
  }
}

/** Marks the Codex hooks `out` read from `file` as in a file Codex refuses: they do not load. */
export function markRefusedHooksFile(out: Collector, file: string): void {
  for (const item of out.items) {
    if (item.kind === "hook" && item.location.tool === "codex" && item.location.file === file) {
      item.codexError = "invalid hooks file";
    }
  }
}

/**
 * The `[hooks.state]` tables of the user config.toml, into the facts: Codex reads hook state from
 * the user's config alone, a project's being no place to trust its own hooks.
 */
export function addCodexHookStates(config: Record<string, unknown>, file: string, facts: StateFacts): void {
  const hooks = isRecord(config.hooks) ? config.hooks : undefined;
  for (const [key, state] of Object.entries(isRecord(hooks?.state) ? hooks.state : {})) {
    if (!isRecord(state) || key.trim() === "") continue;
    facts.codexHookStates.push({
      file,
      key: key.trim(),
      ...(typeof state.enabled === "boolean" ? { enabled: state.enabled } : {}),
      ...(typeof state.trusted_hash === "string" ? { trustedHash: state.trusted_hash } : {}),
    });
  }
}

/**
 * A hook as Codex hashes it: its timeout made explicit - 600 seconds, or for SessionEnd and
 * Interrupt 1, held to 1 to 3 - and fields Codex ignores left out. Undefined for one Codex skips.
 */
function normalized(event: string, hook: unknown): Record<string, unknown> | undefined {
  if (!isRecord(hook)) return undefined;
  const short = event === "SessionEnd" || event === "Interrupt";
  const given = count(hook.timeout);
  const timeout = short ? Math.min(Math.max(given ?? 1, 1), 3) : Math.max(given ?? 600, 1);
  const statusMessage = typeof hook.statusMessage === "string" ? { statusMessage: hook.statusMessage } : {};
  if (hook.type === "command") {
    const windows = hook.commandWindows ?? hook.command_windows;
    const command = process.platform === "win32" && typeof windows === "string" ? windows : hook.command;
    if (typeof command !== "string" || command.trim() === "") return undefined;
    const limit = count(hook.additionalContextLimit);
    const context =
      CONTEXT_EVENTS.has(event) && limit !== undefined && limit !== DEFAULT_CONTEXT_LIMIT
        ? { additionalContextLimit: limit }
        : {};
    return { type: "command", command, timeout, async: hook.async === true, ...statusMessage, ...context };
  }
  if (hook.type === "mcp_tool" && event !== "SessionEnd") {
    const { server, tool } = hook;
    if (typeof server !== "string" || typeof tool !== "string" || server.trim() === "" || tool.trim() === "") {
      return undefined;
    }
    const input = isRecord(hook.input) && !(hook.input instanceof SerdeNumber) ? hook.input : {};
    return { type: "mcp_tool", server, tool, input: precise(input), timeout, ...statusMessage };
  }
  return undefined;
}

/** A whole number a hook gives - a timeout, a limit - however it was read. */
function count(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return value instanceof SerdeNumber ? Number(value.text) : undefined;
}

/**
 * A number as Codex's serde_json, built with arbitrary precision, holds it: as text, which its
 * hash writes as `{"$serde_json::private::Number": text}`. Codex 0.159.3's hooks/list gave the
 * hashes this text matches.
 */
class SerdeNumber {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

/** A free-form value as Codex hashes it: each number a map of its text. */
function precise(value: unknown): unknown {
  if (value instanceof SerdeNumber) return { "$serde_json::private::Number": value.text };
  // Read without its text: JavaScript's is the file's for an integer or a plain decimal.
  if (typeof value === "number" || typeof value === "bigint") return { "$serde_json::private::Number": String(value) };
  if (Array.isArray(value)) return value.map(precise);
  return isRecord(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, precise(v)])) : value;
}

/**
 * A JSON number's text as serde_json keeps it: an integer as Rust writes it (so `-0` is `0`),
 * any other as written but for its exponent, which is `e` with a sign - `1E3` is `1e+3`.
 */
function jsonNumberText(token: string): string {
  if (/^-?\d+$/.test(token)) return BigInt(token).toString();
  return token.replace(/[eE]([+-]?)/, (_, sign: string) => `e${sign === "-" ? "-" : "+"}`);
}

/**
 * A TOML float's text as serde_json makes it from the double: ryu's shortest digits, as plain
 * decimals from 1e-5 up to 1e16, else in exponent form - with a sign on the exponent.
 */
function floatText(value: number): string {
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const sign = value < 0 ? "-" : "";
  const [mantissa = "", exponent = "0"] = Math.abs(value).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  // 10^(point - 1) <= value < 10^point, as ryu's `kk`.
  const point = Number(exponent) + 1;
  const zeros = point - digits.length;
  if (zeros >= 0 && point <= 16) return `${sign}${digits}${"0".repeat(zeros)}.0`;
  if (point > 0 && point <= 16) return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
  if (point > -5 && point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  const e = point - 1;
  const fraction = digits.length > 1 ? `.${digits.slice(1)}` : "";
  return `${sign}${digits[0]}${fraction}e${e < 0 ? "-" : "+"}${Math.abs(e)}`;
}

/** One JSON token, after the whitespace before it: a string, a number, a literal, a mark. */
const JSON_TOKEN =
  /[ \t\n\r]*(?:("(?:[^"\\]|\\.)*")|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)|([{}[\],:]))/y;

/**
 * JSON text read with each number a SerdeNumber of its text, for a file JSON.parse has read
 * already: it throws on what is no JSON, and its strings are JSON.parse's.
 */
function exactJson(text: string): unknown {
  let at = 0;
  const next = () => {
    JSON_TOKEN.lastIndex = at;
    const token = JSON_TOKEN.exec(text);
    if (!token) throw new SyntaxError("not JSON");
    at = JSON_TOKEN.lastIndex;
    return token;
  };
  const value = (token = next()): unknown => {
    const [, string, number, literal, mark] = token;
    if (string !== undefined) return JSON.parse(string) as string;
    if (number !== undefined) return new SerdeNumber(jsonNumberText(number));
    if (literal !== undefined) return literal === "null" ? null : literal === "true";
    if (mark === "[") {
      const list: unknown[] = [];
      for (let t = next(); t[4] !== "]"; t = next()) {
        list.push(value(t));
        const after = next();
        if (after[4] === "]") return list;
        if (after[4] !== ",") throw new SyntaxError("not JSON");
      }
      return list;
    }
    if (mark !== "{") throw new SyntaxError("not JSON");
    const object: Record<string, unknown> = {};
    for (let t = next(); t[4] !== "}"; t = next()) {
      if (t[1] === undefined || next()[4] !== ":") throw new SyntaxError("not JSON");
      // As JSON.parse makes it: an own property, `__proto__` too.
      Object.defineProperty(object, JSON.parse(t[1]) as string, {
        value: value(),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      const after = next();
      if (after[4] === "}") return object;
      if (after[4] !== ",") throw new SyntaxError("not JSON");
    }
    return object;
  };
  const result = value();
  if (!/^[ \t\n\r]*$/.test(text.slice(at))) throw new SyntaxError("not JSON");
  return result;
}

/** A TOML value with each integer and float a SerdeNumber, as serde_json makes them from TOML's. */
function exactTomlNumbers(value: unknown): unknown {
  if (typeof value === "bigint") return new SerdeNumber(value.toString());
  if (typeof value === "number") return Number.isFinite(value) ? new SerdeNumber(floatText(value)) : value;
  if (Array.isArray(value)) return value.map(exactTomlNumbers);
  return isRecord(value) && value.constructor !== TomlDate
    ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, exactTomlNumbers(v)]))
    : value;
}

/**
 * A hooks file's JSON as Codex reads its numbers, for its hooks' hashes: a second read of a file
 * read already. Undefined where it does not read, and the plain read stands.
 */
export async function exactJsonFile(file: string): Promise<Record<string, unknown> | undefined> {
  const text = await readText(file, []);
  try {
    const json = text === undefined ? undefined : exactJson(text);
    return isRecord(json) ? json : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A config.toml's `[hooks]` as Codex reads their numbers - an integer apart from a float, as
 * smol-toml tells them only with `integersAsBigInt` - for their hashes. Undefined where it does
 * not read.
 */
export async function exactConfigHooks(file: string): Promise<unknown> {
  const text = await readText(file, []);
  try {
    const config = text === undefined ? undefined : parse(text, { integersAsBigInt: true });
    return config === undefined ? undefined : exactTomlNumbers(config.hooks);
  } catch {
    return undefined;
  }
}

function bundled(plugin: string, event: string, handler: Record<string, unknown>): boolean {
  return (
    handler.type === "mcp_tool" &&
    BUNDLED_EVENTS.has(event) &&
    BUNDLED.some((b) => b.plugins.includes(plugin) && b.server === handler.server && b.tool === handler.tool)
  );
}

/** `sha256:<hex>` of the value's JSON with every object's keys sorted, as Codex's `version_for_toml`. */
function hashOf(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(sorted(value)))
    .digest("hex")}`;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!isRecord(value)) return value;
  const keys = Object.keys(value).sort(byCodePoint);
  return Object.fromEntries(keys.map((key) => [key, sorted(value[key])]));
}

/** Rust's order for strings, by their UTF-8 bytes, which is the order of their code points. */
function byCodePoint(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}
