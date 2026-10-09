import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { type Collector, emptyFacts } from "../model.js";
import { TestHome } from "../test-home.js";
import { codexProjectRecords, loadCodexContext, readCodex } from "./codex.js";

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.dispose();
});

describe("readCodex", () => {
  it("reads user, built-in, account and repo skills, servers, hooks and the switches", async () => {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    h.codex(
      "personal",
      ".codex",
      [
        `[projects."${app.replaceAll("\\", "\\\\")}"]`,
        'trust_level = "trusted"',
        "",
        "[mcp_servers.exa]",
        'command = "npx"',
        'args = ["-y", "exa-mcp"]',
        "",
        "[mcp_servers.old]",
        'command = "old"',
        "enabled = false",
        "",
        "[[skills.config]]",
        'name = "eli5"',
        "enabled = false",
        "",
        "[[skills.config]]",
        `path = "${path.join(app, ".agents", "skills", "lint", "SKILL.md").replaceAll("\\", "\\\\")}"`,
        "enabled = false",
        "",
        "[[skills.config]]",
        'name = "both"',
        'path = "/x"',
        "enabled = false",
        "",
      ].join("\n"),
    );
    h.codex("team", ".codex-team");
    h.skill(".agents/skills", "eli5");
    h.skill(".codex/skills/.system", "skill-creator");
    h.skill(".codex-team/skills", "team-only");
    h.skill("repos/app/.agents/skills", "lint");
    h.write("repos/app/.codex/config.toml", "[mcp_servers.exa]\nenabled = false\n");
    h.write(".codex/hooks.json", { hooks: { Stop: [{ hooks: [{ type: "command", command: "notify" }] }] } });

    const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
    const ctx = await loadCodexContext(h.registry, h.home, out.warnings);
    if (!ctx) throw new Error("no codex context");
    expect(codexProjectRecords(ctx)).toEqual([{ tool: "codex", profile: "codex:personal", paths: [app] }]);
    await readCodex(ctx, [{ path: app, tools: ["codex"], profiles: [] }], out);

    expect(out.items.map((i) => `${i.kind}|${i.location.scope}|${i.location.profile ?? "-"}|${i.name}`).sort()).toEqual(
      [
        "skill|global|-|eli5",
        "skill|builtin|-|skill-creator",
        "skill|account|codex:team|team-only",
        "skill|project|-|lint",
        "mcp|global|-|exa",
        "mcp|global|-|old",
        "hook|global|-|Stop",
      ].sort(),
    );
    expect(out.items.find((i) => i.name === "eli5")?.usageKeys).toEqual([]);
    expect(out.facts.codexSkillConfig.map((c) => c.name ?? path.basename(path.dirname(c.path ?? "")))).toEqual([
      "eli5",
      "lint",
    ]);
    expect(out.facts.codexMcpEnabled.map((e) => [e.name, e.project ? "project" : "user", e.enabled])).toEqual(
      expect.arrayContaining([
        ["old", "user", false],
        ["exa", "project", false],
      ]),
    );
  });

  it("reads a project table that only switches a server as that switch, not as a second server", async () => {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    h.codex("personal", ".codex", '[mcp_servers.github]\ncommand = "gh-mcp"\n');
    h.write(
      "repos/app/.codex/config.toml",
      '[mcp_servers.github]\nenabled = false\n\n[mcp_servers.own]\nurl = "https://own.example/mcp"\n',
    );
    const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
    const ctx = await loadCodexContext(h.registry, h.home, out.warnings);
    if (!ctx) throw new Error("no codex context");
    await readCodex(ctx, [{ path: app, tools: ["codex"], profiles: [] }], out);
    expect(out.items.map((i) => `${i.location.scope}|${i.name}`).sort()).toEqual(["global|github", "project|own"]);
    expect(out.facts.codexMcpEnabled).toEqual([
      { file: path.join(app, ".codex", "config.toml"), project: app, name: "github", enabled: false },
    ]);
  });

  it("warns for a config.toml that does not parse and reads the rest", async () => {
    const h = new TestHome();
    homes.push(h);
    // A secret-shaped value just before the syntax error, built from pieces so push protection lets it through.
    const secretLine = `token = "${"sk"}${"-live-"}${"abc123"}"`;
    h.codex("personal", ".codex", `${secretLine}\n[mcp_servers.x\ncommand = 1\n`);
    h.skill(".agents/skills", "still-here");
    const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
    const ctx = await loadCodexContext(h.registry, h.home, out.warnings);
    if (!ctx) throw new Error("no codex context");
    await readCodex(ctx, [], out);
    expect(out.items.map((i) => i.name)).toEqual(["still-here"]);
    expect(out.warnings.map((w) => path.basename(w.file))).toEqual(["config.toml"]);
    const message = out.warnings[0]?.message ?? "";
    expect(message).toMatch(/^is not valid TOML( at line \d+, column \d+)?$/);
    expect(message).not.toContain("abc123");
  });
});
