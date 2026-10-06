import { type ExecFileException, execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The helper ships inside the plugin and runs straight from Node, so it is tested the way the
// skill runs it: as a child process, against a fake Superset host.
const SCRIPT = path.resolve("plugins/clausona/skills/superset-fleet/scripts/superset-host.mjs");
const TOKEN = ["fake", "host", "token", "for", "tests"].join("-");

type Seen = { method: string; procedure: string; input: unknown; auth: string | undefined };
type Reply = { status?: number; json?: unknown; error?: string };

let server: Server;
let endpoint: string;
let home: string;
let seen: Seen[];
let replies: Record<string, Reply>;

function startServer(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const procedure = url.pathname.replace(/^\/trpc\//, "");
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const encoded = req.method === "GET" ? url.searchParams.get("input") : raw;
      seen.push({
        method: req.method ?? "",
        procedure,
        input: encoded ? JSON.parse(encoded).json : undefined,
        auth: req.headers.authorization,
      });
      res.setHeader("content-type", "application/json");
      const reply = replies[procedure];
      if (!reply) {
        // What the real host answers for a procedure it does not have.
        res.statusCode = 404;
        res.end(
          JSON.stringify({
            error: { json: { message: `No procedure found on path "${procedure}"`, data: { code: "NOT_FOUND" } } },
          }),
        );
        return;
      }
      if (reply.error !== undefined) {
        res.statusCode = reply.status ?? 500;
        res.end(JSON.stringify({ error: { json: { message: reply.error, data: { code: "ERROR" } } } }));
        return;
      }
      res.end(JSON.stringify({ result: { data: { json: reply.json ?? null } } }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`);
    });
  });
}

function writeManifest(dirName: string, content: string) {
  const dir = path.join(home, ".superset", "host", dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "manifest.json"), content);
}

function run(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          SUPERSET_HOME_DIR: path.join(home, ".superset"),
          ...env,
        },
      },
      (err: ExecFileException | null, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
      },
    );
  });
}

beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), "superset-host-"));
  seen = [];
  replies = {};
  endpoint = await startServer();
  // A trailing slash, as some manifests carry: the helper must not double it.
  writeManifest("org-1", JSON.stringify({ pid: process.pid, endpoint: `${endpoint}/`, authToken: TOKEN }));
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
});

describe("host discovery and calls", () => {
  it("finds the live host and calls project.list with its token", async () => {
    replies["project.list"] = { json: [{ id: "p1" }, { id: "p2" }] };
    const r = await run(["status"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, endpoint, projects: 2 });
    expect(seen).toEqual([{ method: "GET", procedure: "project.list", input: undefined, auth: `Bearer ${TOKEN}` }]);
  });

  it("skips a manifest whose process is gone and one that does not parse", async () => {
    const gone = spawnSync(process.execPath, ["-e", ""]).pid;
    // Both sort before org-1, so the helper meets them first.
    writeManifest("a-gone", JSON.stringify({ pid: gone, endpoint: "http://127.0.0.1:9", authToken: "other" }));
    writeManifest("b-broken", "{not json");
    replies["project.list"] = { json: [] };
    const r = await run(["status"]);
    expect(r.code).toBe(0);
    expect(seen.map((s) => s.auth)).toEqual([`Bearer ${TOKEN}`]);
  });

  it("says so when no host is running", async () => {
    rmSync(path.join(home, ".superset", "host"), { recursive: true, force: true });
    const r = await run(["status"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no running Superset host service found/);
  });

  it("reports API drift when a procedure is gone", async () => {
    const r = await run(["status"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/the Superset host API has changed \(project\.list is gone\)/);
    expect(r.stderr).toMatch(/claude plugin update clausona@clausona/);
  });

  it("does not mistake a missing resource for API drift", async () => {
    replies["project.list"] = { status: 404, error: "Project not found" };
    const r = await run(["projects"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/project\.list failed: Project not found/);
    expect(r.stderr).not.toMatch(/API has changed/);
  });

  it("never prints the token, even when the host echoes it", async () => {
    replies["project.list"] = { status: 500, error: `bad header: Bearer ${TOKEN}` };
    const r = await run(["status"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/<redacted>/);
    expect(r.stderr + r.stdout).not.toContain(TOKEN);
  });

  it("lists projects as id, name and repoPath", async () => {
    replies["project.list"] = { json: [{ id: "p1", name: "acme", repoPath: "/r/acme", color: "red", icon: null }] };
    const r = await run(["projects"]);
    expect(JSON.parse(r.stdout)).toEqual([{ id: "p1", name: "acme", repoPath: "/r/acme" }]);
  });

  it("rejects an unknown command with the usage, without calling the host", async () => {
    const r = await run(["nope"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/usage: superset-host\.mjs/);
    expect(seen).toEqual([]);
  });
});

describe("workspaces and terminals", () => {
  it("lists workspaces, filtered to a project", async () => {
    replies["workspace.list"] = {
      json: [
        { id: "w1", projectId: "p1" },
        { id: "w2", projectId: "p2" },
      ],
    };
    expect(JSON.parse((await run(["workspaces", "list"])).stdout)).toHaveLength(2);
    expect(JSON.parse((await run(["workspaces", "list", "--project", "p2"])).stdout)).toEqual([
      { id: "w2", projectId: "p2" },
    ]);
  });

  it("creates a workspace with only the options given", async () => {
    replies["workspaces.create"] = { json: { workspace: { id: "w1" } } };
    await run(["workspaces", "create", "--project", "p1", "--name", "Task 1", "--branch", "fleet/t1"]);
    await run([
      "workspaces",
      "create",
      "--project",
      "p1",
      "--name",
      "Task 2",
      "--branch",
      "fleet/t2",
      "--base-branch",
      "main",
      "--skip-branch-prefix",
    ]);
    expect(seen.map((s) => [s.method, s.procedure, s.input])).toEqual([
      ["POST", "workspaces.create", { projectId: "p1", name: "Task 1", branch: "fleet/t1" }],
      [
        "POST",
        "workspaces.create",
        { projectId: "p1", name: "Task 2", branch: "fleet/t2", baseBranch: "main", skipBranchPrefix: true },
      ],
    ]);
  });

  it("refuses to create a workspace without a branch, and calls nothing", async () => {
    const r = await run(["workspaces", "create", "--project", "p1", "--name", "Task 1"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--branch is required/);
    expect(seen).toEqual([]);
  });

  it("deletes a workspace by id", async () => {
    replies["workspace.delete"] = { json: { worktreeRemoved: true, warnings: [] } };
    const r = await run(["workspaces", "delete", "w1"]);
    expect(JSON.parse(r.stdout)).toEqual({ worktreeRemoved: true, warnings: [] });
    expect(seen.map((s) => [s.method, s.procedure, s.input])).toEqual([["POST", "workspace.delete", { id: "w1" }]]);
    expect((await run(["workspaces", "delete"])).code).toBe(1);
  });

  it("lists a workspace's terminals and only the agents running in it", async () => {
    replies["terminal.list"] = { json: { sessions: [{ terminalId: "t1", workspaceId: "w1" }] } };
    replies["terminalAgents.list"] = {
      json: [
        { terminalId: "t1", workspaceId: "w1", agentId: "claude" },
        { terminalId: "t9", workspaceId: "w9", agentId: "claude" },
      ],
    };
    const r = await run(["terminals", "list", "--workspace", "w1"]);
    expect(JSON.parse(r.stdout)).toEqual({
      sessions: [{ terminalId: "t1", workspaceId: "w1" }],
      agents: [{ terminalId: "t1", workspaceId: "w1", agentId: "claude" }],
    });
    expect(seen[0]).toMatchObject({ method: "GET", procedure: "terminal.list", input: { workspaceId: "w1" } });
  });

  it("reads a terminal, 240 lines unless told otherwise", async () => {
    replies["terminal.snapshot"] = { json: { terminalId: "t1", text: "hello" } };
    await run(["terminals", "read", "--workspace", "w1", "--terminal", "t1"]);
    await run(["terminals", "read", "--workspace", "w1", "--terminal", "t1", "--max-lines", "50"]);
    expect(seen.map((s) => s.input)).toEqual([
      { terminalId: "t1", workspaceId: "w1", maxLines: 240 },
      { terminalId: "t1", workspaceId: "w1", maxLines: 50 },
    ]);
  });

  it("rejects a max-lines that is not a positive integer", async () => {
    for (const bad of ["0", "ten", "-3"]) {
      const r = await run(["terminals", "read", "--workspace", "w1", "--terminal", "t1", `--max-lines=${bad}`]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/--max-lines must be a positive integer/);
    }
    expect(seen).toEqual([]);
  });

  it("sends text verbatim and submits it", async () => {
    replies["terminal.send"] = { json: { terminalId: "t1", submitted: true } };
    const text = 'say "hi" && echo `date` $(whoami)\nsecond line';
    await run(["terminals", "send", "--workspace", "w1", "--terminal", "t1", "--text", text]);
    expect(seen).toEqual([
      {
        method: "POST",
        procedure: "terminal.send",
        input: { terminalId: "t1", workspaceId: "w1", text, submit: true },
        auth: `Bearer ${TOKEN}`,
      },
    ]);
  });

  it("closes a terminal", async () => {
    replies["terminal.killSession"] = { json: { success: true } };
    await run(["terminals", "close", "--workspace", "w1", "--terminal", "t1"]);
    expect(seen.map((s) => [s.method, s.procedure, s.input])).toEqual([
      ["POST", "terminal.killSession", { terminalId: "t1", workspaceId: "w1" }],
    ]);
  });
});

describe("agents", () => {
  it("lists configs with env keys but never env values", async () => {
    const value = ["value", "that", "must", "not", "print"].join("-");
    replies["settings.agentConfigs.list"] = {
      json: [
        {
          id: "c1",
          label: "Claude · work",
          command: "clausona",
          args: ["run", "claude:work"],
          env: { API_KEY: value },
        },
      ],
    };
    const r = await run(["agents", "configs"]);
    expect(JSON.parse(r.stdout)).toEqual([
      { id: "c1", label: "Claude · work", command: "clausona", args: ["run", "claude:work"], envKeys: ["API_KEY"] },
    ]);
    expect(r.stdout).not.toContain(value);
  });

  it("adds a clausona config, with the claude args after --", async () => {
    replies["settings.agentConfigs.add"] = { json: { id: "c2", label: "Claude · work (Sonnet 5.5)", env: {} } };
    const r = await run([
      "agents",
      "add-config",
      "--label",
      "Claude · work (Sonnet 5.5)",
      "--profile",
      "claude:work",
      "--",
      "--model",
      "claude-sonnet-5-5",
      "--effort",
      "high",
    ]);
    expect(JSON.parse(r.stdout)).toEqual({ id: "c2", label: "Claude · work (Sonnet 5.5)", envKeys: [] });
    await run(["agents", "add-config", "--label", "X", "--profile", "claude:glm", "--command", "/opt/bin/clausona"]);
    expect(seen.map((s) => s.input)).toEqual([
      {
        label: "Claude · work (Sonnet 5.5)",
        command: "clausona",
        args: ["run", "claude:work", "--", "--model", "claude-sonnet-5-5", "--effort", "high"],
        promptTransport: "argv",
        promptArgs: [],
        env: {},
        presetId: "custom",
      },
      {
        label: "X",
        command: "/opt/bin/clausona",
        args: ["run", "claude:glm", "--"],
        promptTransport: "argv",
        promptArgs: [],
        env: {},
        presetId: "custom",
      },
    ]);
  });

  it("removes a config", async () => {
    replies["settings.agentConfigs.remove"] = { json: { success: true } };
    await run(["agents", "remove-config", "c2"]);
    expect(seen.map((s) => [s.method, s.procedure, s.input])).toEqual([
      ["POST", "settings.agentConfigs.remove", { id: "c2" }],
    ]);
  });

  it("starts an agent with a brief file, byte for byte", async () => {
    replies["agents.run"] = { json: { kind: "terminal", sessionId: "t1", label: "Claude · work" } };
    const brief = 'Fix `parse()` in src/parse.ts.\nRun $(npm test) && echo "done"\n\tKeep \\n literal.\n';
    const file = path.join(home, "brief.md");
    writeFileSync(file, brief);
    const r = await run(["agents", "run", "--workspace", "w1", "--agent", "c1", "--prompt-file", file]);
    expect(JSON.parse(r.stdout)).toEqual({ kind: "terminal", sessionId: "t1", label: "Claude · work" });
    expect(seen).toEqual([
      {
        method: "POST",
        procedure: "agents.run",
        input: { workspaceId: "w1", agent: "c1", prompt: brief },
        auth: `Bearer ${TOKEN}`,
      },
    ]);
  });

  it("refuses both --prompt and --prompt-file, and no prompt at all", async () => {
    const file = path.join(home, "brief.md");
    writeFileSync(file, "x");
    const both = await run([
      "agents",
      "run",
      "--workspace",
      "w1",
      "--agent",
      "c1",
      "--prompt",
      "x",
      "--prompt-file",
      file,
    ]);
    const none = await run(["agents", "run", "--workspace", "w1", "--agent", "c1"]);
    expect(both.code).toBe(1);
    expect(none.code).toBe(1);
    expect(none.stderr).toMatch(/pass --prompt, --prompt-file or --from-terminal/);
    expect(seen).toEqual([]);
  });

  it("hands a task over from another terminal", async () => {
    replies["terminal.transcript"] = { json: { terminalId: "t1", text: "step 3 of 5 done; usage limit reached" } };
    replies["agents.run"] = { json: { kind: "terminal", sessionId: "t2", label: "Claude · side" } };
    await run([
      "agents",
      "run",
      "--workspace",
      "w1",
      "--agent",
      "c-side",
      "--from-terminal",
      "t1",
      "--prompt",
      "Finish step 4 and 5.",
    ]);
    expect(seen[0]).toMatchObject({
      method: "GET",
      procedure: "terminal.transcript",
      input: { terminalId: "t1", workspaceId: "w1", maxChars: 36000 },
    });
    expect(seen[1]).toMatchObject({ method: "POST", procedure: "agents.run" });
    const prompt = (seen[1].input as { prompt: string }).prompt;
    expect(prompt).toContain("Superset terminal t1");
    expect(prompt).toContain("step 3 of 5 done; usage limit reached");
    expect(prompt.endsWith("Finish step 4 and 5.")).toBe(true);
  });

  it("will not hand over a terminal that has printed nothing", async () => {
    replies["terminal.transcript"] = { json: { terminalId: "t1", text: "  \n" } };
    const r = await run(["agents", "run", "--workspace", "w1", "--agent", "c1", "--from-terminal", "t1"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/terminal t1 has no output to hand off yet/);
    expect(seen.map((s) => s.procedure)).toEqual(["terminal.transcript"]);
  });
});
