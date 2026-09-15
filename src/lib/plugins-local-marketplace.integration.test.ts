import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DoctorProfileResult, Registry } from "../types.js";

// doctorProfiles resolves ~/.clausona/profiles.json at module load, so the module graph
// has to see a temporary home.
let currentHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => currentHome }, homedir: () => currentHome };
});

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

type Marketplace = { name: string; installLocation: (ctx: { configDir: string; home: string }) => string };

/** A marketplace clausona manages: a directory under plugins/marketplaces. */
const managed = (name: string): Marketplace => ({
  name,
  installLocation: ({ configDir }) => path.join(configDir, "plugins", "marketplaces", name),
});

/** A marketplace the user registered from a path of their own, as Claude Code allows. */
const pathRegistered = (name: string, rel: string): Marketplace => ({
  name,
  installLocation: ({ home }) => path.join(home, rel),
});

function seed(marketplaces: Marketplace[]) {
  currentHome = mkdtempSync(path.join(tmpdir(), "clausona-plugins-"));
  temps.push(currentHome);

  const primary = path.join(currentHome, ".claude");
  const work = path.join(currentHome, ".claude-work");
  mkdirSync(path.join(currentHome, ".clausona"), { recursive: true });
  for (const dir of [primary, work]) {
    mkdirSync(path.join(dir, "plugins", "marketplaces"), { recursive: true });
    writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "T" } }));
  }
  writeFileSync(path.join(currentHome, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "p@x" } }));
  writeFileSync(path.join(work, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "w@x" } }));

  const known: Record<string, unknown> = {};
  for (const m of marketplaces) {
    const location = m.installLocation({ configDir: work, home: currentHome });
    known[m.name] = { source: "github", repo: `example/${m.name}`, installLocation: location };
    // A managed marketplace exists as a directory in both config dirs; a path-registered
    // one lives wherever the user put it.
    if (location.startsWith(path.join(work, "plugins", "marketplaces"))) {
      mkdirSync(location, { recursive: true });
      mkdirSync(path.join(primary, "plugins", "marketplaces", m.name), { recursive: true });
    } else {
      mkdirSync(location, { recursive: true });
    }
  }
  writeFileSync(path.join(work, "plugins", "known_marketplaces.json"), JSON.stringify(known, null, 2));

  const registry: Registry = {
    version: 2,
    primarySources: { claude: primary },
    activeProfiles: { claude: "claude:default" },
    profiles: {
      "claude:default": { tool: "claude", configDir: primary, email: "p@x", isPrimary: true },
      "claude:work": { tool: "claude", configDir: work, email: "w@x" },
    },
  };
  writeFileSync(path.join(currentHome, ".clausona", "profiles.json"), JSON.stringify(registry));

  return { primary, work };
}

async function runDoctor(): Promise<DoctorProfileResult[]> {
  vi.resetModules();
  const { doctorProfiles } = await import("./service.js");
  return doctorProfiles();
}

function kinds(results: DoctorProfileResult[], name: string): string[] {
  const result = results.find((r) => r.name === name);
  if (!result) throw new Error(`no doctor result for ${name}`);
  return result.issues.map((issue) => issue.kind);
}

describe("doctor and a marketplace registered by local path", () => {
  it("does not report a path-registered marketplace as drift", async () => {
    seed([managed("official"), pathRegistered("internal-wiki", "repos/internal/wiki")]);

    const results = await runDoctor();

    // Its installLocation can never equal <configDir>/plugins/marketplaces/<name>, so
    // comparing it that way makes the profile permanently unhealthy.
    expect(kinds(results, "claude:work")).not.toContain("plugins_out_of_sync");
  });

  it("still reports a managed marketplace whose installLocation points elsewhere", async () => {
    const { work } = seed([managed("official")]);
    // Claims a path inside the managed directory, but the wrong one — real drift.
    const knownPath = path.join(work, "plugins", "known_marketplaces.json");
    const known = JSON.parse(readFileSync(knownPath, "utf8"));
    known.official.installLocation = path.join(work, "plugins", "marketplaces", "somewhere-else");
    writeFileSync(knownPath, JSON.stringify(known));

    const results = await runDoctor();

    expect(kinds(results, "claude:work")).toContain("plugins_out_of_sync");
  });

  it("still reports a marketplace directory that is missing from the JSON", async () => {
    const { work } = seed([managed("official")]);
    writeFileSync(path.join(work, "plugins", "known_marketplaces.json"), JSON.stringify({}));

    const results = await runDoctor();

    expect(kinds(results, "claude:work")).toContain("plugins_out_of_sync");
  });
});

describe("syncPluginsJson and a marketplace registered by local path", () => {
  it("keeps the registration instead of dropping it", async () => {
    const { primary, work } = seed([managed("official"), pathRegistered("internal-wiki", "repos/internal/wiki")]);

    vi.resetModules();
    const { syncPluginsJson } = await import("./service.js");
    await syncPluginsJson(work, primary);

    const known = JSON.parse(readFileSync(path.join(work, "plugins", "known_marketplaces.json"), "utf8"));
    expect(Object.keys(known).sort()).toEqual(["internal-wiki", "official"]);
    // Its location is the user's, not one clausona may rewrite.
    expect(known["internal-wiki"].installLocation).toBe(path.join(currentHome, "repos/internal/wiki"));
    expect(known["internal-wiki"].repo).toBe("example/internal-wiki");
  });

  it("still drops an entry that claims a managed path with no directory behind it", async () => {
    const { primary, work } = seed([managed("official")]);
    const knownPath = path.join(work, "plugins", "known_marketplaces.json");
    const known = JSON.parse(readFileSync(knownPath, "utf8"));
    known.ghost = { installLocation: path.join(work, "plugins", "marketplaces", "ghost") };
    writeFileSync(knownPath, JSON.stringify(known));

    vi.resetModules();
    const { syncPluginsJson } = await import("./service.js");
    await syncPluginsJson(work, primary);

    const after = JSON.parse(readFileSync(knownPath, "utf8"));
    expect(Object.keys(after)).toEqual(["official"]);
  });
});
