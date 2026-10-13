import { realpathSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { valueHash } from "../hash.js";
import { loadInventory } from "../inventory.js";
import { type Collector, emptyFacts } from "../model.js";
import { stateOf } from "../state.js";
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

  it("records which projects Codex trusts, fingerprints each server's table and places each hook", async () => {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    const web = h.project("repos/web");
    // Literal keys, so a Windows path's backslashes are not escapes.
    h.codex(
      "personal",
      ".codex",
      [
        `[projects.'${app}']`,
        'trust_level = "trusted"',
        "",
        `[projects.'${web}']`,
        'trust_level = "untrusted"',
        "",
        "[mcp_servers.exa]",
        'command = "npx"',
        'args = ["-y", "exa-mcp"]',
        "",
      ].join("\n"),
    );
    h.write("repos/app/.codex/config.toml", '[mcp_servers.own]\nurl = "https://own.example/mcp"\nenabled = true\n');
    h.write(".codex/hooks.json", { hooks: { Stop: [{ hooks: [{ type: "command", command: "notify" }] }] } });
    // Written without the "hooks" key: the events sit at the root.
    h.write("repos/app/.codex/hooks.json", {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard" }] }],
    });
    const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
    const ctx = await loadCodexContext(h.registry, h.home, out.warnings);
    if (!ctx) throw new Error("no codex context");
    const projects = [app, web].map((p) => ({ path: p, tools: ["codex" as const], profiles: [] }));
    await readCodex(ctx, projects, out);

    expect(out.facts.codexTrust).toEqual([
      { project: app, trusted: true },
      { project: web, trusted: false },
    ]);
    expect(out.facts.fingerprints["mcp:codex:global:-:exa"]).toBe(
      valueHash({ command: "npx", args: ["-y", "exa-mcp"] }),
    );
    const own = out.items.find((i) => i.name === "own");
    expect(own && out.facts.fingerprints[own.id]).toBe(valueHash({ url: "https://own.example/mcp", enabled: true }));
    const hook = (command: string) => out.items.find((i) => i.kind === "hook" && i.summary?.command === command);
    expect(hook("notify")?.hook).toEqual({ base: "hooks", event: "Stop", group: 0, index: 0 });
    expect(hook("guard")?.hook).toEqual({ base: "root", event: "PreToolUse", matcher: "Bash", group: 0, index: 0 });
    const guard = hook("guard");
    expect(guard && out.facts.fingerprints[guard.id]).toBe(valueHash({ type: "command", command: "guard" }));
  });

  it("matches a [[skills.config]] path to a skill through links, either way round, as Codex does", async () => {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    // Codex's skills folder is a link, and the entry holds the real path.
    h.skill("shared/codex-skills", "lint");
    h.link("shared/codex-skills", ".codex/skills");
    // A project skill folder is a link, and the entry holds the link's path.
    h.skill("elsewhere", "deploy");
    h.link("elsewhere/deploy", "repos/app/.agents/skills/deploy");
    // The entry holds a path through a link to the home, and the skill is listed by its own.
    h.skill(".agents/skills", "eli5");
    h.link(".", "alias");
    const toml = (p: string) => `[[skills.config]]\npath = '${p}'\nenabled = false\n`;
    h.codex(
      "personal",
      ".codex",
      [
        `[projects.'${app}']\ntrust_level = "trusted"\n`,
        toml(realpathSync(h.path("shared", "codex-skills", "lint", "SKILL.md"))),
        toml(h.path("repos", "app", ".agents", "skills", "deploy", "SKILL.md")),
        toml(h.path("alias", ".agents", "skills", "eli5", "SKILL.md")),
      ].join("\n"),
    );
    const inv = await loadInventory(h.inventoryOptions(app, h.path("m.json")));
    const state = (name: string) => {
      const item = inv.items.find((i) => i.location.tool === "codex" && i.name === name);
      if (!item) throw new Error(`no ${name}`);
      return stateOf(inv, item, app).value;
    };
    expect([state("lint"), state("deploy"), state("eli5")]).toEqual(["off", "off", "off"]);
  });

  it("names a skill by its front matter's name, as Codex does, and keeps its folder in the id", async () => {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    h.codex("personal", ".codex", '[[skills.config]]\nname = "front-name"\nenabled = false\n');
    h.write(".agents/skills/folder-name/SKILL.md", "---\nname: front-name\ndescription: d\n---\nbody\n");
    // No name, or an empty one: the folder's. Whitespace collapses to one space, in both.
    h.write(".agents/skills/unnamed/SKILL.md", "---\ndescription: only this\n---\nbody\n");
    h.write(".agents/skills/blank/SKILL.md", '---\nname: ""\ndescription:   two   spaces\n---\nbody\n');
    h.write(".codex/skills/spaced/SKILL.md", "---\nname:  My   Skill\ndescription: d\n---\nbody\n");
    h.write("repos/app/.agents/skills/repo-folder/SKILL.md", "---\nname: repo-name\ndescription: d\n---\n");
    const kit = ".codex/plugins/cache/m/kit/1.0.0";
    h.write(`${kit}/.codex-plugin/plugin.json`, { name: "kit" });
    h.write(`${kit}/skills/plan-folder/SKILL.md`, "---\nname: plan\ndescription: d\n---\n");
    const inv = await loadInventory(h.inventoryOptions(app, h.path("m.json")));
    const codex = inv.items.filter((i) => i.kind === "skill" && i.location.tool === "codex");
    expect(codex.map((i) => [i.name, i.id.split(":").slice(-1)[0], i.description]).sort()).toEqual(
      [
        ["blank", "blank", "two spaces"],
        ["front-name", "folder-name", "d"],
        ["kit:plan", "plan-folder", "d"],
        ["My Skill", "spaced", "d"],
        ["repo-name", "repo-folder", "d"],
        ["unnamed", "unnamed", "only this"],
      ].sort(),
    );
    // Codex switches a skill by that name.
    const front = codex.find((i) => i.name === "front-name");
    expect(front && stateOf(inv, front, app).value).toBe("off");
  });

  it("marks a SKILL.md Codex does not load: no front matter, or a name over 64 characters", async () => {
    const h = new TestHome();
    homes.push(h);
    h.codex("personal", ".codex");
    h.write(".agents/skills/plain/SKILL.md", "just text\n");
    h.write(".agents/skills/empty-block/SKILL.md", "---\n---\nbody\n");
    h.write(".agents/skills/unclosed/SKILL.md", "---\nname: x\ndescription: d\nbody\n");
    h.write(".agents/skills/long/SKILL.md", `---\nname: ${"x".repeat(65)}\ndescription: d\n---\n`);
    // Codex reads the delimiter lines trimmed, and 64 characters is still a name.
    h.write(".agents/skills/padded/SKILL.md", ` --- \nname: ${"y".repeat(64)}\ndescription: d\n --- \n`);
    const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
    const ctx = await loadCodexContext(h.registry, h.home, out.warnings);
    if (!ctx) throw new Error("no codex context");
    await readCodex(ctx, [], out);
    const error = (folder: string) => out.items.find((i) => i.location.file.endsWith(folder))?.codexError;
    expect(["plain", "empty-block", "unclosed", "long", "padded"].map(error)).toEqual([
      "no front matter",
      "no front matter",
      "no front matter",
      "name too long",
      undefined,
    ]);
    // Listed by its folder, so it can be found and cleaned up.
    expect(out.items.find((i) => i.location.file.endsWith("plain"))?.name).toBe("plain");
  });

  it("finds skills in nested folders down to Codex's depth of 6, through links, but not in hidden ones", async () => {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    h.codex("personal", ".codex");
    const at = (rel: string, name: string) => h.write(`${rel}/SKILL.md`, `---\nname: ${name}\ndescription: d\n---\n`);
    at(".agents/skills/top", "top");
    at(".agents/skills/g2/d2", "depth-2");
    at(".agents/skills/g6/a/b/c/d/d6", "depth-6");
    at(".agents/skills/g7/a/b/c/d/e/d7", "depth-7");
    // A skill inside a skill is one too; a hidden folder is not looked in.
    at(".agents/skills/outer/inner", "inner");
    at(".agents/skills/outer", "outer");
    at(".agents/skills/.hidden/h", "hidden");
    // A linked folder is followed, once, however many links lead to it.
    at("elsewhere/pack/linked", "linked");
    h.link("elsewhere/pack", ".agents/skills/via-link");
    h.link("elsewhere/pack", ".agents/skills/again");
    at(".codex/skills/own/nested", "own-nested");
    at("repos/app/.agents/skills/group/repo-nested", "repo-nested");
    // Codex's own skills are its own: a link there is not followed.
    at(".codex/skills/.system/sys/deep", "sys-deep");
    at("elsewhere/sys-linked", "sys-linked");
    h.link("elsewhere/sys-linked", ".codex/skills/.system/linked");
    const kit = ".codex/plugins/cache/m/kit/1.0.0";
    h.write(`${kit}/.codex-plugin/plugin.json`, { name: "kit" });
    at(`${kit}/skills/group/deep`, "deep");
    const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
    const ctx = await loadCodexContext(h.registry, h.home, out.warnings);
    if (!ctx) throw new Error("no codex context");
    await readCodex(ctx, [{ path: app, tools: ["codex"], profiles: [] }], out);
    const skills = out.items.filter((i) => i.kind === "skill");
    expect(skills.map((i) => i.name).sort()).toEqual(
      [
        "top",
        "depth-2",
        "depth-6",
        "outer",
        "inner",
        "linked",
        "own-nested",
        "repo-nested",
        "sys-deep",
        "kit:deep",
      ].sort(),
    );
    // The id ends in the folder below the skills folder; one at the top keeps its id of before.
    const id = (name: string) => skills.find((i) => i.name === name)?.id;
    expect([id("top"), id("depth-2"), id("kit:deep")]).toEqual([
      "skill:codex:global:agents:top",
      "skill:codex:global:agents:g2/d2",
      "skill:codex:plugin:kit@m:kit:group/deep",
    ]);
    expect(skills.find((i) => i.name === "linked")?.location.file).toMatch(/(via-link|again)[\\/]linked$/);
  });

  it("keys each hook's trust as Codex does, per profile, with the hash Codex 0.159.3 gives it", async () => {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    const user = h.path(".codex", "hooks.json");
    const work = h.path(".codex-work", "hooks.json");
    h.codex(
      "personal",
      ".codex",
      [
        `[hooks.state.${JSON.stringify(`${user}:stop:0:0`)}]`,
        'trusted_hash = "sha256:x"',
        `[hooks.state.${JSON.stringify(` ${work}:stop:0:1 `)}]`,
        "enabled = false",
      ].join("\n"),
    );
    h.codex("work", ".codex-work");
    // Every profile links the primary's hooks.json, and keys its hooks by its own path.
    h.write(".codex/hooks.json", {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "echo a" },
              { type: "command", command: "echo b", timeout: 30 },
            ],
          },
          // Codex runs neither, so they have no trust to read.
          {
            hooks: [
              { type: "prompt", prompt: "p" },
              { type: "command", command: "  " },
            ],
          },
        ],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo e" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "echo d", statusMessage: "hi" }] }],
      },
    });
    h.link(".codex/hooks.json", ".codex-work/hooks.json");
    h.write("repos/app/.codex/hooks.json", { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo p" }] }] } });
    const kit = ".codex/plugins/cache/m/kit/1.0.0";
    h.write(`${kit}/.codex-plugin/plugin.json`, {
      name: "kit",
      hooks: [
        { hooks: { Stop: [{ hooks: [{ type: "mcp_tool", server: "srv", tool: "t", input: { a: 1, b: "x" } }] }] } },
      ],
    });
    const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
    const ctx = await loadCodexContext(h.registry, h.home, out.warnings);
    if (!ctx) throw new Error("no codex context");
    await readCodex(ctx, [{ path: app, tools: ["codex"], profiles: [] }], out);
    const trust = (command: string) => {
      const item = out.items.find((i) => i.kind === "hook" && i.summary?.command === command);
      return out.facts.codexHookTrust.find((t) => t.id === item?.id);
    };
    // The hashes Codex's hooks/list reported for these very hooks.
    expect(trust("echo a")).toEqual({
      id: expect.any(String),
      keys: expect.arrayContaining([`${user}:stop:0:0`, `${work}:stop:0:0`]),
      hash: "sha256:f9b7a328de9c5845f5eed806f12f8f5adeba50ba82617690fd3f8ededeb12f90",
    });
    expect(trust("echo b")?.hash).toBe("sha256:8bc692b8683e57143231758daf9cea94d84862d2dfe702ff8d5d75c1c5ce4713");
    expect(trust("echo d")?.hash).toBe("sha256:5e5315cfa6a6d8a596960cfa128f46887b882abf3224c7d94af6c774e106a126");
    expect(trust("echo e")?.hash).toBe("sha256:b500dbf8519fc7cab049f31ec4788be3b7f50c889022bd7d4792197fc83ac207");
    expect(trust("echo p")?.keys).toContain(path.join(app, ".codex", "hooks.json:stop:0:0"));
    const mcp = out.facts.codexHookTrust.find((t) => t.keys[0]?.startsWith("kit@m:"));
    expect(mcp).toMatchObject({
      keys: ["kit@m:plugin.json#hooks[0]:stop:0:0"],
      hash: "sha256:e8b7611c6b6f118f78081ea67de3bbaaa1d8e6061637871e83176156fea65374",
    });
    expect(out.facts.codexHookTrust).toHaveLength(6);
    expect(out.facts.codexHookStates).toEqual([
      { file: h.path(".codex", "config.toml"), key: `${user}:stop:0:0`, trustedHash: "sha256:x" },
      { file: h.path(".codex", "config.toml"), key: `${work}:stop:0:1`, enabled: false },
    ]);
  });

  it("marks the hooks of a hooks file Codex cannot read: anything but hooks and a description at its top", async () => {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    h.codex("personal", ".codex");
    const stop = (command: string) => ({ Stop: [{ hooks: [{ type: "command", command }] }] });
    h.write(".codex/hooks.json", { $schema: "https://example.com/hooks.json", hooks: stop("with-schema") });
    // Events at the top, as a Claude plugin's hooks.json may have them.
    h.write("repos/app/.codex/hooks.json", stop("at-root"));
    const kit = ".codex/plugins/cache/m/kit/1.0.0";
    h.write(`${kit}/.codex-plugin/plugin.json`, { name: "kit" });
    h.write(`${kit}/hooks/hooks.json`, stop("plugin-root"));
    const good = ".codex/plugins/cache/m/good/1.0.0";
    h.write(`${good}/.codex-plugin/plugin.json`, { name: "good" });
    h.write(`${good}/hooks/hooks.json`, { description: "fine", hooks: stop("fine") });
    const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
    const ctx = await loadCodexContext(h.registry, h.home, out.warnings);
    if (!ctx) throw new Error("no codex context");
    await readCodex(ctx, [{ path: app, tools: ["codex"], profiles: [] }], out);
    const hook = (command: string) => out.items.find((i) => i.kind === "hook" && i.summary?.command === command);
    expect(["with-schema", "at-root", "plugin-root", "fine"].map((c) => hook(c)?.codexError)).toEqual([
      "invalid hooks file",
      "invalid hooks file",
      "invalid hooks file",
      undefined,
    ]);
    // No trust to read for a hook Codex never gets to.
    const trusted = new Set(out.facts.codexHookTrust.map((t) => t.id));
    expect(["with-schema", "at-root", "plugin-root", "fine"].map((c) => trusted.has(hook(c)?.id ?? ""))).toEqual([
      false,
      false,
      false,
      true,
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
