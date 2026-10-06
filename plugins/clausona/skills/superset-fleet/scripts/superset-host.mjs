#!/usr/bin/env node
// Talks to the Superset host service on this machine for the superset-fleet skill, for when the
// superset CLI is missing or not logged in. It calls the same tRPC procedures the CLI calls.
// The host's auth token is read from the host's manifest inside this process and sent only in
// the Authorization header: it is never printed, passed on a command line or written to a file.
// Every command prints JSON on stdout. Errors go to stderr, with exit status 1.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const USAGE = `usage: superset-host.mjs <command>
  status
  projects
  workspaces list [--project <id>]
  workspaces create --project <id> --name <name> --branch <branch> [--base-branch <branch>] [--skip-branch-prefix]
  workspaces delete <id>
  agents configs
  agents add-config --label <label> --profile <profile> [--command <path>] [-- <claude args>...]
  agents remove-config <id>
  agents run --workspace <id> --agent <config id> [--prompt <text> | --prompt-file <path>] [--from-terminal <id>]
  terminals list --workspace <id>
  terminals read --workspace <id> --terminal <id> [--max-lines <n>]
  terminals send --workspace <id> --terminal <id> (--text <text> | --text-file <path>)
  terminals close --workspace <id> --terminal <id>
  terminals wait --workspace <id> [--workspace <id>...] [--terminal <id>...] [--seen <terminal>@<time>...] [--timeout <s>] [--quiet <s>] [--interval <s>]
  trust --config-dir <profile config dir> --path <folder> [--check]`;

class CliError extends Error {
  // The HTTP status, when the host answered with an error.
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Set once the token is read, so that nothing printed afterwards can carry it.
let secret = "";

function redact(text) {
  return secret ? text.split(secret).join("<redacted>") : text;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// The desktop app (or `superset start`) writes one manifest per host it runs; a manifest whose
// process is gone is left behind by a crash and must be skipped.
function findHost() {
  const dir = path.join(process.env.SUPERSET_HOME_DIR || path.join(homedir(), ".superset"), "host");
  let names = [];
  try {
    names = readdirSync(dir).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path.join(dir, name, "manifest.json"), "utf8"));
    } catch {
      continue;
    }
    const { endpoint, authToken, pid } = manifest ?? {};
    if (typeof endpoint !== "string" || typeof authToken !== "string") continue;
    if (!Number.isInteger(pid) || !isAlive(pid)) continue;
    secret = authToken;
    return { endpoint: endpoint.replace(/\/+$/, ""), token: authToken };
  }
  throw new CliError("no running Superset host service found. Open the Superset app, or run `superset start`.");
}

async function call(host, procedure, input, { mutation = false } = {}) {
  const url = new URL(`${host.endpoint}/trpc/${procedure}`);
  const headers = { Authorization: `Bearer ${host.token}` };
  const init = { headers, signal: AbortSignal.timeout(180_000) };
  if (mutation) {
    init.method = "POST";
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify({ json: input });
  } else if (input !== undefined) {
    url.searchParams.set("input", JSON.stringify({ json: input }));
  }
  let response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    throw new CliError(`cannot reach the Superset host at ${host.endpoint}: ${err.cause?.code ?? err.message}`);
  }
  let body = null;
  try {
    body = JSON.parse(await response.text());
  } catch {
    body = null;
  }
  const message = body?.error?.json?.message;
  // A missing workspace or terminal is a 404 too; only this message means the procedure is gone.
  if (response.status === 404 && typeof message === "string" && message.startsWith("No procedure found")) {
    throw new CliError(
      `the Superset host API has changed (${procedure} is gone). Update the plugin with ` +
        "`claude plugin update clausona@clausona`, or log the Superset CLI in with `superset auth login` and use it instead.",
    );
  }
  if (!response.ok) throw new CliError(`${procedure} failed: ${message ?? `HTTP ${response.status}`}`, response.status);
  return body?.result?.data?.json;
}

function positiveInt(text, flag) {
  if (!/^\d+$/.test(text) || Number(text) === 0) throw new CliError(`${flag} must be a positive integer`);
  return Number(text);
}

function positiveNumber(text, flag) {
  if (!/^\d+(\.\d+)?$/.test(text) || !(Number(text) > 0)) throw new CliError(`${flag} must be a positive number`);
  return Number(text);
}

// The host files each agent's hook events under these; only Start and PermissionRequest mean
// the agent is working.
const ENDED_EVENTS = new Set(["Stop", "Failed", "Detached"]);

// Waits until one of the given workers needs the orchestrator. The host keeps each agent's last
// hook event, so this does not depend on what a worker prints or in which language. A worker
// counts as needing attention when its turn ended (done, blocked or asking), it failed or its
// terminal is gone, or it has had no event for `quiet` seconds, which is how a permission prompt
// looks from outside. A state stays the same until the agent's next event, so each result carries
// a `seen` mark; given back with --seen, that state is skipped and the wait goes on. Given
// `terminals`, only those count as workers: a shell tab or an agent the user opened in the same
// workspace is left out.
async function waitForWorkers(host, workspaces, { timeout, quiet, interval, seen, terminals }) {
  const isWorker = (terminalId) => terminals.size === 0 || terminals.has(terminalId);
  const started = Date.now();
  for (;;) {
    const agents = await call(host, "terminalAgents.list");
    const waited = Math.round((Date.now() - started) / 1000);
    for (const workspaceId of workspaces) {
      const mine = agents.filter((a) => a.workspaceId === workspaceId && isWorker(a.terminalId));
      if (mine.length === 0) {
        // A worker that was just started has no agent row for a few seconds.
        let sessions = [];
        try {
          ({ sessions } = await call(host, "terminal.list", { workspaceId }));
        } catch (err) {
          // A workspace the host no longer finds has no terminals. Any other error, a changed
          // host API among them, is the host's problem, not a sign the worker is gone.
          if (err.status !== 404) throw err;
        }
        if (!sessions.some((s) => !s.exited && isWorker(s.terminalId))) return { event: "gone", workspaceId, waited };
        continue;
      }
      for (const agent of mine) {
        const mark = `${agent.terminalId}@${agent.lastEventAt}`;
        if (seen.has(mark)) continue;
        const { terminalId, lastEventType, lastEventAt } = agent;
        const found = { workspaceId, terminalId, lastEventType, lastEventAt, seen: mark, waited };
        if (ENDED_EVENTS.has(lastEventType)) return { event: "stopped", ...found };
        if (Date.now() - lastEventAt > quiet * 1000) return { event: "quiet", ...found };
      }
    }
    if (Date.now() - started >= timeout * 1000) return { event: "timeout", workspaces, waited };
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
  }
}

// An agent row names the account it signed in with. The skill needs only the config dir, and an
// orchestrator prints what it reads, so the email is dropped.
function withoutEmail({ account, ...rest }) {
  if (!account) return rest;
  const { email, ...kept } = account;
  return { ...rest, account: kept };
}

// Config env can hold API keys, so only the keys are shown.
function hideEnv({ env, ...rest }) {
  return { ...rest, envKeys: Object.keys(env ?? {}) };
}

// The CLI's own cap on the context it hands from one terminal to a new agent.
const HANDOFF_MAX_CHARS = 36_000;

function readTextFile(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    throw new CliError(`cannot read ${file}: ${err.code ?? err.message}`);
  }
}

// Mirrors `superset agents create --from-terminal`: the new agent starts from the old
// terminal's recent output, read from the host's transcript of that terminal.
async function handoffPrompt(host, workspaceId, terminalId, extra) {
  const transcript = await call(host, "terminal.transcript", { terminalId, workspaceId, maxChars: HANDOFF_MAX_CHARS });
  const text = transcript?.text ?? "";
  if (!text.trim()) throw new CliError(`terminal ${terminalId} has no output to hand off yet`);
  const lines = [
    `You are taking over a task that another agent was working on in this workspace (Superset terminal ${terminalId}).`,
    "Its recent terminal output is below. Check the worktree's git state, then carry the task on from where it stopped. Do not redo finished steps.",
    "",
    "<previous-terminal-output>",
    text,
    "</previous-terminal-output>",
  ];
  if (extra?.trim()) lines.push("", extra);
  return lines.join("\n");
}

// The host deletes a workspace with force: it removes the worktree even with uncommitted work in
// it. It keeps the branch. So a workspace is deleted only when its worktree is clean and its
// branch has an upstream with nothing left to push.
function git(worktree, args) {
  return execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function whyNotRetirable(worktree) {
  if (typeof worktree !== "string" || !existsSync(worktree)) {
    return `its worktree ${worktree} is missing, so it cannot be checked`;
  }
  let status;
  try {
    status = git(worktree, ["status", "--porcelain"]);
  } catch (err) {
    return `git status failed in ${worktree}: ${String(err.stderr ?? err.message).trim()}`;
  }
  const changes = status.split("\n").filter(Boolean).length;
  if (changes > 0) return `${worktree} has ${changes} uncommitted change(s)`;
  let ahead;
  try {
    ahead = Number(git(worktree, ["rev-list", "--count", "@{u}..HEAD"]).trim());
  } catch {
    return "its branch has no upstream; push it with `git push -u origin HEAD` first";
  }
  if (ahead > 0) return `${ahead} commit(s) on its branch are not pushed`;
  return null;
}

async function deleteWorkspace(host, id) {
  const workspace = (await call(host, "workspace.list")).find((w) => w.id === id);
  if (!workspace) throw new CliError(`no workspace ${id}`);
  const reason = whyNotRetirable(workspace.worktreePath);
  if (reason) throw new CliError(`not deleting workspace ${id}: ${reason}`);
  return call(host, "workspace.delete", { id }, { mutation: true });
}

// Claude Code keeps the default account's state in ~/.claude.json, outside ~/.claude, and any
// other config dir's inside it (the same rule as clausona's claudeJsonPathForConfigDir).
function claudeJsonFor(configDir) {
  const dir = path.resolve(configDir);
  const home = homedir();
  return dir === path.join(home, ".claude") ? path.join(home, ".claude.json") : path.join(dir, ".claude.json");
}

// A symlinked file (a dotfiles checkout) is written at its target, so the link survives, even when
// the target does not exist yet.
function writeTarget(file) {
  try {
    return realpathSync(file);
  } catch {
    // A dangling link, or no file yet.
  }
  try {
    if (lstatSync(file).isSymbolicLink()) return path.resolve(path.dirname(file), readlinkSync(file));
  } catch {
    // No file yet.
  }
  return file;
}

// Replaces the file in one rename so a Claude Code reading it never sees half of it.
function atomicWrite(file, content) {
  const target = writeTarget(file);
  if (!existsSync(path.dirname(target))) throw new CliError(`${path.dirname(target)} does not exist`);
  let mode = 0o600;
  try {
    mode = statSync(target).mode & 0o777;
  } catch {
    mode = 0o600;
  }
  const dir = mkdtempSync(path.join(path.dirname(target), ".superset-fleet-"));
  const tmp = path.join(dir, "next");
  try {
    writeFileSync(tmp, content, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, target);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Superset pre-trusts a worktree only for its own claude and codex presets, so a worker started
// through `clausona run` would stop at Claude Code's folder-trust prompt. This records the same
// answer Superset's seedClaudeFolderTrust records, keyed by the folder's real path.
function trust(configDir, folder, checkOnly) {
  const file = claudeJsonFor(configDir);
  let key;
  try {
    key = realpathSync(folder);
  } catch {
    throw new CliError(`${folder} does not exist`);
  }
  let state = {};
  if (existsSync(file)) {
    try {
      state = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new CliError(`${file} is not valid JSON; leaving it as it is`);
    }
  } else if (!existsSync(path.dirname(file))) {
    throw new CliError(
      `${path.dirname(file)} does not exist: pass a profile's configDir from \`clausona list --json\``,
    );
  }
  const trusted = state.projects?.[key]?.hasTrustDialogAccepted === true;
  if (checkOnly || trusted) return { file, path: key, trusted };
  state.projects = { ...state.projects, [key]: { ...state.projects?.[key], hasTrustDialogAccepted: true } };
  atomicWrite(file, JSON.stringify(state, null, 2));
  return { file, path: key, trusted: true };
}

const str = { type: "string" };

const COMMANDS = {
  status: {
    run: async (host) => {
      const projects = await call(host, "project.list");
      return { ok: true, endpoint: host.endpoint, projects: projects.length };
    },
  },
  projects: {
    run: async (host) => (await call(host, "project.list")).map(({ id, name, repoPath }) => ({ id, name, repoPath })),
  },
  "workspaces list": {
    options: { project: str },
    run: async (host, { project }) => {
      const all = await call(host, "workspace.list");
      return project ? all.filter((w) => w.projectId === project) : all;
    },
  },
  "workspaces create": {
    options: { project: str, name: str, branch: str, "base-branch": str, "skip-branch-prefix": { type: "boolean" } },
    required: ["project", "name", "branch"],
    run: (host, v) =>
      call(
        host,
        "workspaces.create",
        {
          projectId: v.project,
          name: v.name,
          branch: v.branch,
          ...(v["base-branch"] ? { baseBranch: v["base-branch"] } : {}),
          ...(v["skip-branch-prefix"] ? { skipBranchPrefix: true } : {}),
        },
        { mutation: true },
      ),
  },
  // Stops the workspace's terminals and removes its worktree, after deleteWorkspace's checks.
  "workspaces delete": {
    positionals: 1,
    run: (host, _v, [id]) => deleteWorkspace(host, id),
  },
  "terminals list": {
    options: { workspace: str },
    required: ["workspace"],
    run: async (host, { workspace }) => {
      const { sessions } = await call(host, "terminal.list", { workspaceId: workspace });
      const agents = (await call(host, "terminalAgents.list"))
        .filter((a) => a.workspaceId === workspace)
        .map(withoutEmail);
      return { sessions, agents };
    },
  },
  "terminals read": {
    options: { workspace: str, terminal: str, "max-lines": str },
    required: ["workspace", "terminal"],
    run: (host, v) =>
      call(host, "terminal.snapshot", {
        terminalId: v.terminal,
        workspaceId: v.workspace,
        maxLines: positiveInt(v["max-lines"] ?? "240", "--max-lines"),
      }),
  },
  "terminals send": {
    options: { workspace: str, terminal: str, text: str, "text-file": str },
    required: ["workspace", "terminal"],
    run: (host, v) => {
      if (v.text !== undefined && v["text-file"] !== undefined) {
        throw new CliError("pass --text or --text-file, not both");
      }
      // A file's final newline goes, as it would from `$(cat file)`: the send presses Enter itself.
      const text = v["text-file"] !== undefined ? readTextFile(v["text-file"]).replace(/\n+$/, "") : v.text;
      if (text === undefined) throw new CliError("pass --text or --text-file");
      return call(
        host,
        "terminal.send",
        { terminalId: v.terminal, workspaceId: v.workspace, text, submit: true },
        { mutation: true },
      );
    },
  },
  "terminals close": {
    options: { workspace: str, terminal: str },
    required: ["workspace", "terminal"],
    run: (host, v) =>
      call(host, "terminal.killSession", { terminalId: v.terminal, workspaceId: v.workspace }, { mutation: true }),
  },
  "terminals wait": {
    options: {
      workspace: { type: "string", multiple: true },
      terminal: { type: "string", multiple: true },
      seen: { type: "string", multiple: true },
      timeout: str,
      quiet: str,
      interval: str,
    },
    required: ["workspace"],
    run: (host, v) =>
      waitForWorkers(host, v.workspace, {
        timeout: positiveNumber(v.timeout ?? "1800", "--timeout"),
        quiet: positiveNumber(v.quiet ?? "300", "--quiet"),
        interval: positiveNumber(v.interval ?? "5", "--interval"),
        seen: new Set(v.seen ?? []),
        terminals: new Set(v.terminal ?? []),
      }),
  },
  "agents configs": {
    run: async (host) => (await call(host, "settings.agentConfigs.list")).map(hideEnv),
  },
  "agents add-config": {
    options: { label: str, profile: str, command: str },
    required: ["label", "profile"],
    passthrough: true,
    run: async (host, v, _p, extra) =>
      hideEnv(
        await call(
          host,
          "settings.agentConfigs.add",
          {
            label: v.label,
            command: v.command ?? "clausona",
            args: ["run", v.profile, "--", ...extra],
            promptTransport: "argv",
            promptArgs: [],
            env: {},
            presetId: "custom",
          },
          { mutation: true },
        ),
      ),
  },
  "agents remove-config": {
    positionals: 1,
    run: (host, _v, [id]) => call(host, "settings.agentConfigs.remove", { id }, { mutation: true }),
  },
  "agents run": {
    options: { workspace: str, agent: str, prompt: str, "prompt-file": str, "from-terminal": str },
    required: ["workspace", "agent"],
    run: async (host, v) => {
      if (v.prompt !== undefined && v["prompt-file"] !== undefined) {
        throw new CliError("pass --prompt or --prompt-file, not both");
      }
      let prompt = v["prompt-file"] !== undefined ? readTextFile(v["prompt-file"]) : v.prompt;
      if (v["from-terminal"] !== undefined) prompt = await handoffPrompt(host, v.workspace, v["from-terminal"], prompt);
      if (!prompt?.trim()) throw new CliError("pass --prompt, --prompt-file or --from-terminal");
      // The prompt is the last argument of the worker's command line.
      if (prompt.startsWith("-")) {
        throw new CliError('the prompt starts with "-", so claude would read it as an option. Start it with a word.');
      }
      return call(host, "agents.run", { workspaceId: v.workspace, agent: v.agent, prompt }, { mutation: true });
    },
  },
  trust: {
    options: { "config-dir": str, path: str, check: { type: "boolean" } },
    required: ["config-dir", "path"],
    local: true,
    run: (_host, v) => trust(v["config-dir"], v.path, v.check === true),
  },
};

async function main(argv) {
  const pair = argv.slice(0, 2).join(" ");
  const name = COMMANDS[pair] ? pair : argv[0];
  const command = COMMANDS[name];
  if (!command) throw new CliError(USAGE);
  let rest = argv.slice(name.split(" ").length);
  let extra = [];
  const dashdash = rest.indexOf("--");
  if (dashdash >= 0) {
    if (!command.passthrough) throw new CliError(`${name} takes nothing after --\n${USAGE}`);
    extra = rest.slice(dashdash + 1);
    rest = rest.slice(0, dashdash);
  }
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: command.options ?? {}, allowPositionals: true, strict: true });
  } catch (err) {
    throw new CliError(`${err.message}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  const want = command.positionals ?? 0;
  if (positionals.length !== want) throw new CliError(`${name} takes ${want} argument(s)\n${USAGE}`);
  for (const key of command.required ?? []) {
    if (values[key] === undefined) throw new CliError(`${name}: --${key} is required`);
  }
  const host = command.local ? null : findHost();
  return command.run(host, values, positionals, extra);
}

main(process.argv.slice(2)).then(
  (result) => {
    process.stdout.write(`${redact(JSON.stringify(result ?? null, null, 2))}\n`);
  },
  (err) => {
    const text = err instanceof CliError ? err.message : String(err?.stack ?? err);
    process.stderr.write(`superset-host: ${redact(text)}\n`);
    process.exitCode = 1;
  },
);
