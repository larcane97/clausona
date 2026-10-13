import { createHash } from "node:crypto";
import path from "node:path";

import type { Collector, StateFacts } from "../model.js";
import { isRecord, realPath } from "../read.js";

/**
 * Codex's hook trust, as Codex 0.159.3 keeps it (codex-rs/hooks, engine/discovery.rs). Codex runs
 * a hook it does not manage only once the user has reviewed it: `[hooks.state."<key>"]` in the
 * user config.toml then holds `trusted_hash`, the hash of the hook's definition at the time, and
 * a hook whose definition changed since is to be reviewed again. `enabled = false` there turns
 * one hook off. The key is where the hook is - `<source>:<event>:<group>:<index>` - and the
 * source is the hooks file's path, or for a plugin `<plugin id>:<path in the plugin>`.
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
 * as addHooks reads them, under the same ids (`<idBase>:<event>#<group>.<index>`) - into the
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
          id: `${idBase}:${event}#${g}.${h}`,
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
  const given = typeof hook.timeout === "number" ? hook.timeout : undefined;
  const timeout = short ? Math.min(Math.max(given ?? 1, 1), 3) : Math.max(given ?? 600, 1);
  const statusMessage = typeof hook.statusMessage === "string" ? { statusMessage: hook.statusMessage } : {};
  if (hook.type === "command") {
    const windows = hook.commandWindows ?? hook.command_windows;
    const command = process.platform === "win32" && typeof windows === "string" ? windows : hook.command;
    if (typeof command !== "string" || command.trim() === "") return undefined;
    const limit = hook.additionalContextLimit;
    const context =
      CONTEXT_EVENTS.has(event) && typeof limit === "number" && limit !== DEFAULT_CONTEXT_LIMIT
        ? { additionalContextLimit: limit }
        : {};
    return { type: "command", command, timeout, async: hook.async === true, ...statusMessage, ...context };
  }
  if (hook.type === "mcp_tool" && event !== "SessionEnd") {
    const { server, tool } = hook;
    if (typeof server !== "string" || typeof tool !== "string" || server.trim() === "" || tool.trim() === "") {
      return undefined;
    }
    const input = isRecord(hook.input) ? hook.input : {};
    return { type: "mcp_tool", server, tool, input: precise(input), timeout, ...statusMessage };
  }
  return undefined;
}

/**
 * A free-form JSON value as Codex's serde_json, built with arbitrary precision, hashes it: each
 * number a map of its text. The text is the number's as JavaScript writes it, which is the
 * file's for an integer or a plainly written decimal.
 */
function precise(value: unknown): unknown {
  if (typeof value === "number") return { "$serde_json::private::Number": String(value) };
  if (Array.isArray(value)) return value.map(precise);
  return isRecord(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, precise(v)])) : value;
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
