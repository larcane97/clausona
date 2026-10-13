import { realpathSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { valueHash } from "../hash.js";
import { loadInventory } from "../inventory.js";
import { type Collector, emptyFacts, type Warning } from "../model.js";
import { stateOf } from "../state.js";
import { TestHome } from "../test-home.js";
import { codexProjectRecords, loadCodexContext, readCodex } from "./codex.js";
import { addCodexHookTrust, codexHomeHooksFile } from "./codex-hooks.js";

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

  it("marks a SKILL.md with no description, after a name too long, as Codex 0.159.3 checks them", async () => {
    const h = new TestHome();
    homes.push(h);
    h.codex("personal", ".codex");
    h.write(".agents/skills/none/SKILL.md", "---\nname: none\n---\n");
    h.write(".agents/skills/empty/SKILL.md", '---\nname: empty\ndescription: ""\n---\n');
    h.write(".agents/skills/below/SKILL.md", "---\nname: below\ndescription:\n  on the next line\n---\n");
    h.write(".agents/skills/long/SKILL.md", `---\nname: ${"z".repeat(65)}\n---\n`);
    const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
    const ctx = await loadCodexContext(h.registry, h.home, out.warnings);
    if (!ctx) throw new Error("no codex context");
    await readCodex(ctx, [], out);
    const error = (folder: string) => out.items.find((i) => i.location.file.endsWith(folder))?.codexError;
    expect(["none", "empty", "below", "long"].map(error)).toEqual([
      "no description",
      "no description",
      undefined,
      "name too long",
    ]);
  });

  it("marks a SKILL.md whose front matter Codex cannot read as YAML, and one with a byte order mark", async () => {
    const h = new TestHome();
    homes.push(h);
    h.codex("personal", ".codex");
    // What Codex 0.159.3 said of each: an invalid YAML error, the last two listed.
    h.write(".agents/skills/trailing/SKILL.md", '---\nname: trailing\ndescription: "Use it" when asked\n---\n');
    h.write(".agents/skills/as-list/SKILL.md", "---\nname: as-list\ndescription: [a, b]\n---\n");
    h.write(".agents/skills/unindented/SKILL.md", "---\nname: unindented\ndescription: one line\nand the next\n---\n");
    h.write(".agents/skills/colon/SKILL.md", "---\nname: colon\ndescription: Use when: asked\n---\n");
    h.write(".agents/skills/wrapped/SKILL.md", "---\nname: wrapped\ndescription: one line\n  and the next\n---\n");
    // Rust's trim leaves a byte order mark, so Codex finds no front matter.
    h.write(".agents/skills/bom/SKILL.md", "﻿---\nname: bom\ndescription: d\n---\n");
    const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
    const ctx = await loadCodexContext(h.registry, h.home, out.warnings);
    if (!ctx) throw new Error("no codex context");
    await readCodex(ctx, [], out);
    const error = (folder: string) => out.items.find((i) => i.location.file.endsWith(folder))?.codexError;
    expect(["trailing", "as-list", "unindented", "colon", "wrapped", "bom"].map(error)).toEqual([
      "invalid front matter",
      "invalid front matter",
      "invalid front matter",
      undefined,
      undefined,
      "no front matter",
    ]);
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
    // Codex runs work with CODEX_HOME set, which it makes canonical before it keys work's hooks by
    // the hooks.json there: /var is /private/var on macOS, and a temp dir's RUNNER~1 is runneradmin
    // on Windows.
    const work = path.join(realpathSync.native(h.codex("work", ".codex-work")), "hooks.json");
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
    // By a file symlink, as clausona shares hooks.json on Windows too: a junction is for a folder.
    symlinkSync(user, h.path(".codex-work", "hooks.json"), "file");
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

  it("reads the hooks a config.toml holds, the user's and a trusted project's, keyed as Codex keys them", async () => {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    const user = h.path(".codex", "config.toml");
    // A `[[hooks.<event>]]` group of one command hook; `group` and `hook` add lines to each.
    const toml = (event: string, command: string, group = "", hook = "") =>
      `[[hooks.${event}]]\n${group}[[hooks.${event}.hooks]]\ntype = "command"\ncommand = "${command}"\n${hook}`;
    h.codex(
      "personal",
      ".codex",
      [
        `[projects."${app.replaceAll("\\", "\\\\")}"]`,
        'trust_level = "trusted"',
        toml("Stop", "echo toml-a"),
        toml("PreToolUse", "echo toml-b", 'matcher = "Bash"\n', "timeout = 30\n"),
        // Codex trusts the first as it is now.
        `[hooks.state.${JSON.stringify(`${user}:stop:0:0`)}]`,
        'trusted_hash = "sha256:0ba7626e463001be6e8ede70f8f378c158f6587b414aafdc02e0d25c6ff57ecb"',
      ].join("\n"),
    );
    // A hooks.json beside it: Codex runs both, each keyed by its own file.
    h.write(".codex/hooks.json", { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo json-a" }] }] } });
    h.write("repos/app/.codex/config.toml", toml("Stop", "echo repo-toml"));
    const inv = await loadInventory(h.inventoryOptions(app, h.path("m.json")));
    const hook = (command: string) => inv.items.find((i) => i.kind === "hook" && i.summary?.command === command);
    const trust = (command: string) => inv.facts.codexHookTrust.find((t) => t.id === hook(command)?.id);
    // The hashes Codex 0.159.3's hooks/list reported for these hooks.
    expect(trust("echo toml-a")).toMatchObject({
      keys: expect.arrayContaining([`${user}:stop:0:0`]),
      hash: "sha256:0ba7626e463001be6e8ede70f8f378c158f6587b414aafdc02e0d25c6ff57ecb",
    });
    expect(trust("echo toml-b")?.hash).toBe("sha256:8e266741fcd93362d7c441ae1c9ac542468b353c73c490429099a869888a2ef9");
    expect(trust("echo repo-toml")?.keys).toContain(path.join(app, ".codex", "config.toml:stop:0:0"));
    expect(hook("echo toml-a")?.location).toMatchObject({ scope: "global", file: user });
    expect(hook("echo repo-toml")?.location).toMatchObject({ scope: "project", project: app });
    // Two Stop hooks at group 0, index 0, one in each file of the user's: two rows.
    expect(new Set([hook("echo toml-a")?.id, hook("echo json-a")?.id]).size).toBe(2);
    const states = ["echo toml-a", "echo toml-b", "echo json-a"].map((c) => {
      const item = hook(c);
      return item && stateOf(inv, item, app).value;
    });
    expect(states).toEqual(["on", "pending-approval", "pending-approval"]);
  });

  it("hashes the numbers in an MCP tool hook's input as Codex's serde_json holds them, from JSON and TOML", async () => {
    const h = new TestHome();
    homes.push(h);
    // Each number as written, the tool it is the input of, and the hash Codex 0.159.3's hooks/list
    // gave that hook. JSON keeps a number's text, but for an integer's sign and its exponent's form.
    const json: [string, string, string][] = [
      ["1.0", "j1", "d87f35ed0be41896ac422349050fa7b924cf38f7fba78f4bd4d944703d0f43fa"],
      ["1e3", "j2", "6473a6709957327a2814a367eb8902d7834b91b7b0ca12c81e61f1418aa073fa"],
      ["1E+3", "j3", "618dd49e0344798e851373e4cfec77468799750b80fd7f8455d142e8f930d658"],
      ["-0", "j4", "dfc886550c6e4cab2237ecb63adda23ff582a1103f1f6ef310d683cbdaea35c0"],
      ["12345678901234567890", "j5", "073c7e22d2047ad16444b64df724f33f1a51975b1da14d2af453b1131879cea4"],
      ["1.50", "j6", "4da926ed7a99cdeeaaff5c6d7ec3a23eb7e33399d3d95e885c48c2a22b71746e"],
      ["-0.0", "j10", "a843b7ad9e66d25e5682c152a355e32d3a3f1c015a932aeb7c2852946f2fa877"],
      ["1e400", "j11", "887d25e6831d8e18e35da5df36dec9c18102be63880eb7e86f8a6a74cbf2e9be"],
      ["9007199254740993", "j16", "efb78d12f9fe067601569a6820bbd31068c74d32a1be9bb176fc9941007bf265"],
      ["2.5E-3", "j18", "4ad6742fd1da843bded4493e65a031a5cebb863a9c6de0bb30eeb7ef83005ede"],
      ["10E2", "j22", "451981aff766b78eb8b7f255e567d28f8d6ea8f0c128ca2c1777c15bfa5b364c"],
    ];
    // TOML has an integer, or a float, which serde_json writes as ryu does, with a sign on its exponent.
    const toml: [string, string, string][] = [
      ["1.0", "t1", "a12d545cf305b543a4957b450f365882e3161cad17006e4e3bf314384ffd6136"],
      ["1e3", "t2", "819d5600da0b2fe75c9d280c7f291ca2aef69c80a726e73ededae8ddd9a27e43"],
      ["1_000", "t3", "35b493bc534221c7d78930ab23d7e09b0c6fdc04f66add872c067b7f148a366a"],
      ["100", "t5", "d5739220114d8f9845428f0de9c5414e04c7ad4d837a32850686b97511d16fdd"],
      ["1.5e300", "t7", "69755851880abb954f0d068d5d7850bc87eac767df8e92d5ab38aa22ae45bd4e"],
      ["1e16", "t10", "940284e746ac5ea1bf63223764d52a4c2537a1f01e4744394dac7d7218d0fd74"],
      ["0.000001", "t12", "9d2739f465b242c8432d124cb2458c9aab17bb0c051f85ba3e88bfca009d3e9a"],
      ["2.50", "t13", "e61a6fb9982c5a4c7145fb16515eec73edffd1812825aae2bda60fda08471314"],
      ["0x10", "t15", "2ec80f2cc68a44f930cd6476d5e0265bc56a6b2087e864528ec7ae01bc1551ab"],
      ["123456789.123456789", "t19", "bee368052b0a42c4805db22fe9115731b1ef07f608d8313a38c0bdad6ad83d09"],
    ];
    const groups = json.map(
      ([n, tool]) => `{"hooks": [{"type": "mcp_tool", "server": "srv", "tool": "${tool}", "input": {"x": ${n}}}]}`,
    );
    h.write(".codex/hooks.json", `{"hooks": {"PostToolUse": [${groups.join(", ")}]}}`);
    const tables = toml.map(
      ([n, tool]) =>
        `[[hooks.PreToolUse]]\n[[hooks.PreToolUse.hooks]]\ntype = "mcp_tool"\nserver = "srv"\ntool = "${tool}"\ninput = { x = ${n} }\n`,
    );
    h.codex("personal", ".codex", tables.join("\n"));
    // A plugin's manifest holds hooks too: its numbers are read the same way.
    const kit = ".codex/plugins/cache/m/kit/1.0.0";
    h.write(
      `${kit}/.codex-plugin/plugin.json`,
      `{"name": "kit", "hooks": [{"hooks": {"PostToolUse": [${groups[0]}]}}]}`,
    );
    const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
    const ctx = await loadCodexContext(h.registry, h.home, out.warnings);
    if (!ctx) throw new Error("no codex context");
    await readCodex(ctx, [], out);
    // Each hook's trust, by the id its place gives it: group `index` of its event.
    const hashOf = (tool: string) => {
      const index = (tool.startsWith("j") ? json : toml).findIndex(([, t]) => t === tool);
      const id = tool.startsWith("j")
        ? `hook:codex:global:-:PostToolUse#${index}.0`
        : `hook:codex:global:-:PreToolUse#config.toml:${index}.0`;
      return out.facts.codexHookTrust.find((t) => t.id === id)?.hash;
    };
    expect([...json, ...toml].map(([n, tool]) => [n, hashOf(tool)])).toEqual(
      [...json, ...toml].map(([n, , hash]) => [n, `sha256:${hash}`]),
    );
    const inPlugin = out.facts.codexHookTrust.find((t) => t.keys[0]?.startsWith("kit@m:plugin.json#hooks[0]"));
    expect(inPlugin?.hash).toBe(`sha256:${json[0]?.[2]}`);
  });

  it("marks the hooks Codex never runs: prompt and agent hooks, and an MCP tool hook when a session ends", async () => {
    const h = new TestHome();
    homes.push(h);
    // What Codex 0.159.3's hooks/list skipped, with "prompt hooks are not supported yet" and the like.
    h.codex("personal", ".codex", '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "prompt"\nprompt = "in toml"\n');
    h.write(".codex/hooks.json", {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "echo json-a" },
              { type: "agent", prompt: "an agent" },
              { type: "prompt", prompt: "a json prompt" },
              { type: "mcp_tool", server: "srv", tool: "end" },
            ],
          },
        ],
        SessionEnd: [{ hooks: [{ type: "mcp_tool", server: "srv", tool: "on-end" }] }],
      },
    });
    const kit = ".codex/plugins/cache/m/kit/1.0.0";
    h.write(`${kit}/.codex-plugin/plugin.json`, { name: "kit" });
    h.write(`${kit}/hooks/hooks.json`, { hooks: { Stop: [{ hooks: [{ type: "prompt", prompt: "kit prompt" }] }] } });
    const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
    const ctx = await loadCodexContext(h.registry, h.home, out.warnings);
    if (!ctx) throw new Error("no codex context");
    await readCodex(ctx, [], out);
    const hooks = out.items.filter((i) => i.kind === "hook");
    const error = (what: string) =>
      hooks.find((i) => i.summary?.prompt === what || i.summary?.command === what || i.id.endsWith(what))?.codexError;
    expect(["in toml", "an agent", "a json prompt", "kit prompt"].map(error)).toEqual(Array(4).fill("not supported"));
    // The MCP tool hook on SessionEnd; one on Stop runs.
    const mcp = hooks.filter((i) => i.summary?.type === "mcp_tool").map((i) => [i.hook?.event, i.codexError]);
    expect(mcp.sort()).toEqual([
      ["SessionEnd", "not supported"],
      ["Stop", undefined],
    ]);
    expect(error("echo json-a")).toBeUndefined();
  });

  it("marks a command hook whose command is empty, which Codex skips, and runs the rest of its file", async () => {
    const h = new TestHome();
    homes.push(h);
    h.codex("personal", ".codex", '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = ""\n');
    // Codex 0.159.3's hooks/list: "skipping empty hook command" twice, and echo ok listed.
    h.write(".codex/hooks.json", {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "" },
              { type: "command", command: "   " },
              { type: "command", command: "echo ok" },
            ],
          },
        ],
        // An event Codex does not know: no empty command, but an unknown event.
        Unknown: [{ hooks: [{ type: "command", command: "echo who" }] }],
      },
    });
    const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
    const ctx = await loadCodexContext(h.registry, h.home, out.warnings);
    if (!ctx) throw new Error("no codex context");
    await readCodex(ctx, [], out);
    const hooks = out.items.filter((i) => i.kind === "hook");
    // Each by its place: `<event>#<group>.<index>`, after its file's owner.
    const place = (id: string) => id.slice(id.indexOf(":-:") + 3);
    expect(hooks.map((i) => [place(i.id), i.codexError]).sort()).toEqual(
      [
        ["Stop#0.0", "empty command"],
        ["Stop#0.1", "empty command"],
        ["Stop#0.2", undefined],
        ["Stop#config.toml:0.0", "empty command"],
        ["Unknown#0.0", "unknown event"],
      ].sort(),
    );
  });

  it("marks the hooks of a group whose matcher Codex cannot compile, on an event that reads it", async () => {
    const h = new TestHome();
    homes.push(h);
    // Codex 0.159.3's hooks/list: "invalid matcher" for (?=Bash), Bash( and [, and fine, names
    // and stop listed, under the keys pre_tool_use:2:0, pre_tool_use:3:0 and stop:0:0.
    h.write(".codex/hooks.json", {
      hooks: {
        PreToolUse: [
          {
            matcher: "(?=Bash)",
            hooks: [
              { type: "command", command: "ahead" },
              { type: "prompt", prompt: "p" },
            ],
          },
          { matcher: "Bash(", hooks: [{ type: "command", command: "open" }] },
          { matcher: "(?i)bash|^Read$", hooks: [{ type: "command", command: "fine" }] },
          { matcher: "Bash|Read", hooks: [{ type: "command", command: "names" }] },
        ],
        // Stop reads no matcher; SessionStart does.
        Stop: [{ matcher: "(", hooks: [{ type: "command", command: "stop" }] }],
        SessionStart: [{ matcher: "[", hooks: [{ type: "command", command: "start" }] }],
      },
    });
    h.codex(
      "personal",
      ".codex",
      '[[hooks.PreToolUse]]\nmatcher = "(?=Bash)"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "toml"\n',
    );
    const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
    const ctx = await loadCodexContext(h.registry, h.home, out.warnings);
    if (!ctx) throw new Error("no codex context");
    await readCodex(ctx, [], out);
    const place = (id: string) => id.slice(id.indexOf(":-:") + 3);
    expect(
      out.items
        .filter((i) => i.kind === "hook")
        .map((i) => [place(i.id), i.codexError])
        .sort(),
    ).toEqual(
      [
        ["PreToolUse#0.0", "invalid matcher"],
        ["PreToolUse#0.1", "invalid matcher"],
        ["PreToolUse#1.0", "invalid matcher"],
        ["PreToolUse#2.0", undefined],
        ["PreToolUse#3.0", undefined],
        ["PreToolUse#config.toml:0.0", "invalid matcher"],
        ["SessionStart#0.0", "invalid matcher"],
        ["Stop#0.0", undefined],
      ].sort(),
    );
    // Codex lists none of a skipped group's hooks, so they have no trust to look up.
    expect(out.facts.codexHookTrust.map((t) => place(t.id)).sort()).toEqual(
      ["PreToolUse#2.0", "PreToolUse#3.0", "Stop#0.0"].sort(),
    );
  });

  it("marks an MCP tool hook whose server or tool is empty, which Codex skips, and runs the rest", async () => {
    const h = new TestHome();
    homes.push(h);
    // Codex 0.159.3's hooks/list: "server and tool must not be empty" for the first two.
    h.write(".codex/hooks.json", {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "mcp_tool", server: "", tool: "t" },
              { type: "mcp_tool", server: "s", tool: " " },
              { type: "mcp_tool", server: "s", tool: "t" },
            ],
          },
        ],
        // When a session ends Codex runs no MCP tool hook at all: that reason stands.
        SessionEnd: [{ hooks: [{ type: "mcp_tool", server: "", tool: "t" }] }],
      },
    });
    h.codex("personal", ".codex");
    const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
    const ctx = await loadCodexContext(h.registry, h.home, out.warnings);
    if (!ctx) throw new Error("no codex context");
    await readCodex(ctx, [], out);
    const place = (id: string) => id.slice(id.indexOf(":-:") + 3);
    expect(out.items.filter((i) => i.kind === "hook").map((i) => [place(i.id), i.codexError])).toEqual([
      ["Stop#0.0", "empty tool"],
      ["Stop#0.1", "empty tool"],
      ["Stop#0.2", undefined],
      ["SessionEnd#0.0", "not supported"],
    ]);
  });

  it("marks every hook of a file with a hook Codex cannot read, as Codex refuses the whole file", async () => {
    const h = new TestHome();
    homes.push(h);
    const app = h.project("repos/app");
    const good = (command: string) => ({ type: "command", command });
    const stop = (...hooks: unknown[]) => ({ hooks: { Stop: [{ hooks }] } });
    // What Codex 0.159.3's hooks/list refused, each with "failed to parse hooks config …".
    h.codex("personal", ".codex", `[projects."${app.replaceAll("\\", "\\\\")}"]\ntrust_level = "trusted"\n`);
    h.write(".codex/hooks.json", stop(good("json-ok"), { type: "command", command: 5 }));
    h.write("repos/app/.codex/hooks.json", stop(good("app-ok"), { type: "command", command: "x", timeout: 1.5 }));
    const srv = ".codex/plugins/cache/m/srv/1.0.0";
    h.write(`${srv}/.codex-plugin/plugin.json`, { name: "srv" });
    h.write(`${srv}/hooks/hooks.json`, stop(good("srv-ok"), { type: "mcp_tool", server: 5, tool: "t" }));
    // One bad inline entry, and Codex reads none of the manifest's hooks.
    const inl = ".codex/plugins/cache/m/inl/1.0.0";
    h.write(`${inl}/.codex-plugin/plugin.json`, {
      name: "inl",
      hooks: [stop(good("inl-a-ok")), stop(good("inl-b-ok"), { type: "http", url: "x" })],
    });
    const fine = ".codex/plugins/cache/m/fine/1.0.0";
    h.write(`${fine}/.codex-plugin/plugin.json`, { name: "fine" });
    h.write(`${fine}/hooks/hooks.json`, stop(good("fine-ok"), { type: "prompt", prompt: 5 }));
    const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
    const ctx = await loadCodexContext(h.registry, h.home, out.warnings);
    if (!ctx) throw new Error("no codex context");
    await readCodex(ctx, [{ path: app, tools: ["codex"], profiles: [] }], out);
    const error = (command: string) =>
      out.items.find((i) => i.kind === "hook" && i.summary?.command === command)?.codexError;
    expect(["json-ok", "app-ok", "srv-ok", "inl-a-ok", "inl-b-ok", "fine-ok"].map(error)).toEqual([
      ...Array(5).fill("invalid hooks file"),
      undefined,
    ]);
    // A prompt hook's fields are Codex's to ignore: that file reads, and its prompt is not supported.
    expect(out.items.find((i) => i.summary?.type === "prompt")?.codexError).toBe("not supported");
    expect(out.facts.codexHookTrust.map((t) => t.id)).toEqual([expect.stringContaining("fine@m")]);
  });

  it("reads a hook's timeout and context limit as serde does: a whole number written as one", async () => {
    // Codex 0.159.3's hooks/list, one hooks.json each: "invalid type: map, expected u64" for a
    // number its serde keeps as text (1e3, 1E3, 30.0, 3e1, 1e0), the same past u64; 0 and -0 read.
    const read = async (field: string, value: string) => {
      const h = new TestHome();
      homes.push(h);
      h.codex("personal", ".codex");
      h.write(
        ".codex/hooks.json",
        `{"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "good"}, {"type": "command", "command": "x", "${field}": ${value}}]}]}}`,
      );
      const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
      const ctx = await loadCodexContext(h.registry, h.home, out.warnings);
      if (!ctx) throw new Error("no codex context");
      await readCodex(ctx, [], out);
      return out.items.find((i) => i.summary?.command === "good")?.codexError ?? "read";
    };
    const forms = ["1e3", "1E3", "30.0", "3e1", "1e0", "18446744073709551616", "0", "-0", "30"];
    const verdicts = await Promise.all(forms.map((n) => read("timeout", n)));
    expect(verdicts).toEqual([...Array(6).fill("invalid hooks file"), "read", "read", "read"]);
    expect(await read("additionalContextLimit", "1e3")).toBe("invalid hooks file");
    expect(await read("additionalContextLimit", "2500.0")).toBe("invalid hooks file");
    expect(await read("additionalContextLimit", "2500")).toBe("read");
  });

  it("refuses a config.toml whose hook has a timeout that is no whole number, as Codex does", async () => {
    // Codex 0.159.3's config/read: "invalid type: floating point `30.0`, expected u64", and the
    // same for 1e3 (a float in TOML) and -1; 30 reads.
    for (const [timeout, refused] of [
      ["30.0", true],
      ["1e3", true],
      ["-1", true],
      ["30", false],
    ] as const) {
      const h = new TestHome();
      homes.push(h);
      h.codex(
        "personal",
        ".codex",
        `[mcp_servers.x]\ncommand = "x"\n\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "c"\ntimeout = ${timeout}\n`,
      );
      const warnings: Warning[] = [];
      const ctx = await loadCodexContext(h.registry, h.home, warnings);
      expect([timeout, ctx?.config === undefined, warnings.map((w) => w.message)]).toEqual([
        timeout,
        refused,
        refused ? ["has a hook Codex cannot read, so Codex refuses the whole file"] : [],
      ]);
    }
  });

  it("refuses a config.toml whose [hooks.state] Codex cannot read, as Codex refuses the whole file", async () => {
    // Codex 0.159.3's config/read: "expected a boolean", "expected a string", "expected struct
    // HookStateToml", "expected a map" - and a key it does not know in an entry, read.
    for (const [state, refused] of [
      ['[hooks.state."k"]\nenabled = "yes"\n', true],
      ['[hooks.state."k"]\ntrusted_hash = 5\n', true],
      ["[hooks.state]\nk = 5\n", true],
      ["[hooks]\nstate = 5\n", true],
      ['[hooks.state."k"]\nfoo = 1\nenabled = false\n', false],
    ] as const) {
      const h = new TestHome();
      homes.push(h);
      h.codex("personal", ".codex", `[mcp_servers.x]\ncommand = "x"\n\n${state}`);
      const warnings: Warning[] = [];
      const ctx = await loadCodexContext(h.registry, h.home, warnings);
      expect([state, ctx?.config === undefined, warnings.map((w) => w.message)]).toEqual([
        state,
        refused,
        refused ? ["has a hook Codex cannot read, so Codex refuses the whole file"] : [],
      ]);
    }
  });

  it("refuses a config.toml with a hook Codex cannot read, as Codex refuses the whole file", async () => {
    const h = new TestHome();
    homes.push(h);
    // Codex 0.159.3's config/read: "invalid configuration: invalid type: integer `5`, expected a string".
    h.codex(
      "personal",
      ".codex",
      '[mcp_servers.x]\ncommand = "x"\n\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = 5\n',
    );
    const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
    const ctx = await loadCodexContext(h.registry, h.home, out.warnings);
    if (!ctx) throw new Error("no codex context");
    await readCodex(ctx, [], out);
    expect(out.items).toEqual([]);
    expect(out.warnings.map((w) => w.message)).toEqual([
      "has a hook Codex cannot read, so Codex refuses the whole file",
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

  it("reads a config.toml with an integer past 2^53 as Codex does, and refuses one past 64 bits", async () => {
    const config = (big: string) =>
      [
        `x_big = ${big}`,
        "[mcp_servers.a]",
        'command = "true"',
        "[[hooks.PostToolUse]]",
        "[[hooks.PostToolUse.hooks]]",
        'type = "mcp_tool"',
        'server = "srv"',
        'tool = "t"',
        `input = { x = ${big} }`,
      ].join("\n");
    const read = async (big: string) => {
      const h = new TestHome();
      homes.push(h);
      h.codex("personal", ".codex", config(big));
      const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
      const ctx = await loadCodexContext(h.registry, h.home, out.warnings);
      if (!ctx) throw new Error("no codex context");
      await readCodex(ctx, [], out);
      return out;
    };
    // Codex 0.159.3 reads 2^53 + 1 and -2^63 as the i64 they are, the hashes its hooks/list gave.
    for (const [big, hash] of [
      ["9007199254740993", "9fc64986a169ae5caaebab35603b28e3c49be153a9dbc06543d8f1062fde552d"],
      ["-9223372036854775808", "4efb0a81d5d3195241a94492cb19a74de3e1d76902e46bf5648a5ad927c10a73"],
    ] as const) {
      const out = await read(big);
      expect(out.warnings).toEqual([]);
      expect(out.items.filter((i) => i.kind === "mcp").map((i) => i.name)).toEqual(["a"]);
      expect(out.facts.codexHookTrust.map((t) => t.hash)).toEqual([`sha256:${hash}`]);
    }
    // Past 64 bits it refuses the file: "u64 value was too large", and loads nothing.
    const past = await read("9223372036854775808");
    expect(past.items.filter((i) => i.location.file.endsWith("config.toml"))).toEqual([]);
    expect(past.warnings.map((w) => w.message)).toEqual([
      "has an integer too large for 64 bits, so Codex refuses the whole file",
    ]);
  });

  it("refuses a config.toml with a value of the wrong type in a section clausona reads, as Codex does", async () => {
    // Codex 0.159.3's config/read, one config.toml each: "invalid configuration" for the first
    // ones, read for the last.
    const cases: [string, string | undefined][] = [
      ["[mcp_servers.x]\ncommand = 5\n", "an MCP server"],
      ['[mcp_servers.x]\ncommand = "x"\nargs = "x"\n', "an MCP server"],
      ['[mcp_servers.x]\ncommand = "x"\nenv = { A = 5 }\n', "an MCP server"],
      ['[mcp_servers.x]\ncommand = "x"\nurl = "http://x"\n', "an MCP server"],
      ["[mcp_servers.x]\nenabled = false\n", "an MCP server"],
      ['[mcp_servers.x]\nurl = "http://x"\nargs = ["a"]\n', "an MCP server"],
      ['[mcp_servers.x]\ncommand = "x"\ntool_timeout_sec = -1.0\n', "an MCP server"],
      ['[mcp_servers.x]\ncommand = "x"\nstartup_timeout_ms = 1.5\n', "an MCP server"],
      ["mcp_servers = 5\n", "an MCP server"],
      ['[[skills.config]]\nname = "a"\nenabled = "yes"\n', "a skills.config entry"],
      ['[[skills.config]]\nname = "a"\n', "a skills.config entry"],
      ["skills = 5\n", "a skills.config entry"],
      ['[plugins."a@b"]\nenabled = "yes"\n', "a plugin"],
      ['[plugins."a@b".mcp_servers.s]\nenabled = "no"\n', "a plugin"],
      ['[projects."/x"]\ntrust_level = "maybe"\n', "a projects entry"],
      ['[projects."/x"]\ntrust_level = "Trusted"\n', "a projects entry"],
      ["hooks = 5\n", "a hook"],
      ['[mcp_servers.x]\ncommand = "x"\nfoo = 1\nstartup_timeout_sec = 5\n', undefined],
      ['[[skills.config]]\npath = "rel/SKILL.md"\nenabled = false\n', undefined],
      ['[projects."/x"]\nfoo = 1\n', undefined],
    ];
    for (const [text, problem] of cases) {
      const h = new TestHome();
      homes.push(h);
      h.codex("personal", ".codex", text);
      const warnings: Warning[] = [];
      const ctx = await loadCodexContext(h.registry, h.home, warnings);
      const message = problem && `has ${problem} Codex cannot read, so Codex refuses the whole file`;
      expect([text, ctx?.config === undefined, warnings.map((w) => w.message)]).toEqual([
        text,
        problem !== undefined,
        message ? [message] : [],
      ]);
    }
  });

  it("checks a trusted project's config.toml merged over the user's, as Codex does, and an untrusted one's not", async () => {
    const h = new TestHome();
    homes.push(h);
    const projects = ["repos/bad", "repos/orphan", "repos/switch", "repos/untrusted"].map((p) => h.project(p));
    const trusted = projects
      .slice(0, 3)
      .map((p) => `[projects."${p.replaceAll("\\", "\\\\")}"]\ntrust_level = "trusted"\n`);
    h.codex("personal", ".codex", `${trusted.join("\n")}\n[mcp_servers.good]\ncommand = "good"\n`);
    // Codex 0.159.3's config/read from each: "invalid type: integer `5`", "invalid transport" (a
    // switch for a server the user does not define), read, and ignored.
    h.write("repos/bad/.codex/config.toml", "[mcp_servers.p]\ncommand = 5\n");
    h.write("repos/orphan/.codex/config.toml", "[mcp_servers.other]\nenabled = false\n");
    h.write("repos/switch/.codex/config.toml", "[mcp_servers.good]\nenabled = false\n");
    h.write("repos/untrusted/.codex/config.toml", "[mcp_servers.p]\ncommand = 5\n");
    const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
    const ctx = await loadCodexContext(h.registry, h.home, out.warnings);
    if (!ctx) throw new Error("no codex context");
    await readCodex(
      ctx,
      projects.map((p) => ({ path: p, tools: ["codex"], profiles: [] })),
      out,
    );
    const said = "has an MCP server Codex cannot read, so Codex loads no config in this project";
    expect(out.warnings.map((w) => [path.basename(path.dirname(path.dirname(w.file))), w.message]).sort()).toEqual([
      ["bad", said],
      ["orphan", said],
    ]);
    // The switch of a server the user defines still counts.
    expect(out.facts.codexMcpEnabled.map((e) => [e.name, e.enabled])).toEqual([["good", false]]);
  });

  it("records where Codex refuses a config.toml: the user's everywhere, a trusted project's there", async () => {
    const h = new TestHome();
    homes.push(h);
    const projects = ["repos/types", "repos/syntax", "repos/big", "repos/fine", "repos/untrusted"].map((p) =>
      h.project(p),
    );
    const trusted = projects
      .slice(0, 4)
      .map((p) => `[projects."${p.replaceAll("\\", "\\\\")}"]\ntrust_level = "trusted"\n`);
    h.codex("personal", ".codex", trusted.join("\n"));
    // Codex 0.159.3 from each: config/read and skills/list fail for the first three ("invalid
    // type", "Error parsing project config file", "u64 value was too large"); the last two read.
    h.write("repos/types/.codex/config.toml", "[mcp_servers.p]\ncommand = 5\n");
    h.write("repos/syntax/.codex/config.toml", "[mcp_servers.p\n");
    h.write(
      "repos/big/.codex/config.toml",
      '[mcp_servers.p]\ncommand = "p"\nstartup_timeout_ms = 9223372036854775808\n',
    );
    h.write("repos/fine/.codex/config.toml", '[mcp_servers.p]\ncommand = "p"\n');
    h.write("repos/untrusted/.codex/config.toml", "[mcp_servers.p\n");
    const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
    const ctx = await loadCodexContext(h.registry, h.home, out.warnings);
    if (!ctx) throw new Error("no codex context");
    await readCodex(
      ctx,
      projects.map((p) => ({ path: p, tools: ["codex"], profiles: [] })),
      out,
    );
    const name = (file: string) => path.basename(path.dirname(path.dirname(file)));
    expect(
      out.facts.codexConfigRefused.map((r) => [name(r.file), r.project && path.basename(r.project)]).sort(),
    ).toEqual([
      ["big", "big"],
      ["syntax", "syntax"],
      ["types", "types"],
    ]);
    const says = Object.fromEntries(out.warnings.map((w) => [name(w.file), w.message]));
    expect(says.types).toBe("has an MCP server Codex cannot read, so Codex loads no config in this project");
    expect(says.syntax).toMatch(
      /^is not valid TOML( at line \d+, column \d+)?, so Codex loads no config in this project$/,
    );
    expect(says.big).toBe("has an integer too large for 64 bits, so Codex loads no config in this project");
    expect(says.untrusted).toMatch(/^is not valid TOML( at line \d+, column \d+)?$/);
    expect(
      out.items.filter((i) => i.kind === "mcp").map((i) => i.location.project && path.basename(i.location.project)),
    ).toEqual(["fine"]);
    // A user config.toml Codex refuses keeps all of its config out, in every project.
    const user = new TestHome();
    homes.push(user);
    user.codex("personal", ".codex", "[mcp_servers.x\n");
    const userOut: Collector = { items: [], facts: emptyFacts(), warnings: [] };
    const userCtx = await loadCodexContext(user.registry, user.home, userOut.warnings);
    if (!userCtx) throw new Error("no codex context");
    await readCodex(userCtx, [], userOut);
    expect(userOut.facts.codexConfigRefused).toEqual([{ file: userCtx.configFile }]);
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

describe("codexHomeHooksFile", () => {
  it("names the hooks.json in a CODEX_HOME made canonical, as Codex keys it, in each platform's form", async () => {
    // Windows: realpath, as Codex's canonicalize, makes a temp dir's 8.3 short name long.
    const long = async (dir: string) => dir.replace("RUNNER~1", "runneradmin");
    expect(
      await codexHomeHooksFile("C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\h\\.codex-work", long, path.win32),
    ).toBe("C:\\Users\\runneradmin\\AppData\\Local\\Temp\\h\\.codex-work\\hooks.json");
    // macOS: /var is a link to /private/var.
    const linked = async (dir: string) => `/private${dir}`;
    expect(await codexHomeHooksFile("/var/folders/h/.codex-work", linked, path.posix)).toBe(
      "/private/var/folders/h/.codex-work/hooks.json",
    );
    // A folder that is not there: Codex does not start with it, so it trusts nothing under it.
    const gone = () => Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    expect(await codexHomeHooksFile("/gone/.codex-work", gone, path.posix)).toBeUndefined();
  });
});

describe("addCodexHookTrust", () => {
  const realPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  });

  it("hashes a hook by its Windows command on Windows alone, as Codex does, and keys it by its file as given", () => {
    const source = path.win32.join("C:\\Users\\me\\.codex-work", "hooks.json");
    const trustOn = (platform: NodeJS.Platform, hook: Record<string, unknown>) => {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      const facts = emptyFacts();
      addCodexHookTrust({ Stop: [{ hooks: [hook] }] }, "hook:codex:global:-", [source], facts);
      return facts.codexHookTrust[0];
    };
    // The hash Codex 0.159.3 reported for a Stop hook running "echo a".
    const echoA = "sha256:f9b7a328de9c5845f5eed806f12f8f5adeba50ba82617690fd3f8ededeb12f90";
    const plain = (command: string) => ({ type: "command", command });
    for (const hook of [
      { ...plain("echo a"), commandWindows: "echo w" },
      { ...plain("echo a"), command_windows: "echo w" },
    ]) {
      // On Windows Codex runs the Windows command in place of command, and leaves it out of the hash.
      expect(trustOn("win32", hook)?.hash).toBe(trustOn("win32", plain("echo w"))?.hash);
      expect(trustOn("win32", hook)?.hash).not.toBe(echoA);
      for (const platform of ["darwin", "linux"] as const) expect(trustOn(platform, hook)?.hash).toBe(echoA);
    }
    expect(trustOn("win32", plain("echo a"))?.keys).toEqual(["C:\\Users\\me\\.codex-work\\hooks.json:stop:0:0"]);
  });
});
