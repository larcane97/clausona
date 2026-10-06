#!/usr/bin/env node
// Talks to the Superset host service on this machine for the superset-fleet skill, for when the
// superset CLI is missing or not logged in. It calls the same tRPC procedures the CLI calls.
// The host's auth token is read from the host's manifest inside this process and sent only in
// the Authorization header: it is never printed, passed on a command line or written to a file.
// Every command prints JSON on stdout. Errors go to stderr, with exit status 1.
import { readdirSync, readFileSync } from "node:fs";
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
  terminals send --workspace <id> --terminal <id> --text <text>
  terminals close --workspace <id> --terminal <id>
  trust --config-dir <profile config dir> --path <folder> [--check]`;

class CliError extends Error {}

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
  if (!response.ok) throw new CliError(`${procedure} failed: ${message ?? `HTTP ${response.status}`}`);
  return body?.result?.data?.json;
}

function positiveInt(text, flag) {
  if (!/^\d+$/.test(text) || Number(text) === 0) throw new CliError(`${flag} must be a positive integer`);
  return Number(text);
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
  // The host stops the workspace's terminals and removes its worktree even when it has
  // uncommitted changes (it runs with force), and keeps the branch. The skill checks first.
  "workspaces delete": {
    positionals: 1,
    run: (host, _v, [id]) => call(host, "workspace.delete", { id }, { mutation: true }),
  },
  "terminals list": {
    options: { workspace: str },
    required: ["workspace"],
    run: async (host, { workspace }) => {
      const { sessions } = await call(host, "terminal.list", { workspaceId: workspace });
      const agents = (await call(host, "terminalAgents.list")).filter((a) => a.workspaceId === workspace);
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
    options: { workspace: str, terminal: str, text: str },
    required: ["workspace", "terminal", "text"],
    run: (host, v) =>
      call(
        host,
        "terminal.send",
        { terminalId: v.terminal, workspaceId: v.workspace, text: v.text, submit: true },
        { mutation: true },
      ),
  },
  "terminals close": {
    options: { workspace: str, terminal: str },
    required: ["workspace", "terminal"],
    run: (host, v) =>
      call(host, "terminal.killSession", { terminalId: v.terminal, workspaceId: v.workspace }, { mutation: true }),
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
