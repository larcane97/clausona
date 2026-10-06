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
