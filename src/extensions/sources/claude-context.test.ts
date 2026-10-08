import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { type Collector, emptyFacts, type Warning } from "../model.js";
import { TestHome } from "../test-home.js";
import {
  collectClaudeSettingsFacts,
  loadClaudeAccounts,
  loadClaudeContext,
  managedSettingsPath,
  sharesPrimaryEntry,
} from "./claude-context.js";

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.dispose();
});

function seed() {
  const h = new TestHome();
  homes.push(h);
  h.claude("work", ".claude-work", { oauthAccount: { emailAddress: "w@example.com" } });
  h.claude("default", ".claude", { oauthAccount: { emailAddress: "p@example.com" } });
  h.write(".claude-broken/.claude.json", "{ nope");
  h.registry.profiles["claude:broken"] = {
    tool: "claude",
    configDir: h.path(".claude-broken"),
    email: "b@example.com",
  };
  const app = h.project("repos/app");
  h.write(".claude/settings.json", { skillOverrides: { eli5: "off" }, enabledPlugins: { "sp@m": true } });
  h.write("repos/app/.claude/settings.local.json", { skillOverrides: { eli5: "on" } });
  h.write(".claude/plugins/installed_plugins.json", {
    version: 2,
    plugins: {
      "sp@m": [{ scope: "user", installPath: h.path(".claude/plugins/cache/m/sp/1.0.0") }],
      "proj@m": [{ scope: "project", projectPath: app, installPath: h.path(".claude/plugins/cache/m/proj/1.0.0") }],
      "home@m": [{ scope: "project", projectPath: h.home, installPath: h.path(".claude/plugins/cache/m/home/1.0.0") }],
    },
  });
  return { h, app };
}

describe("loadClaudeAccounts", () => {
  it("puts the primary first, reads ~/.claude.json for it, and keeps an unreadable account", async () => {
    const { h } = seed();
    const warnings: Warning[] = [];
    const accounts = await loadClaudeAccounts(h.registry, h.home, warnings);
    expect(accounts.map((a) => a.id)).toEqual(["claude:default", "claude:work", "claude:broken"]);
    expect(accounts[0]?.jsonPath).toBe(h.path(".claude.json"));
    expect(accounts[0]?.json?.oauthAccount).toEqual({ emailAddress: "p@example.com" });
    expect(accounts[2]?.json).toBeUndefined();
    expect(warnings.map((w) => path.basename(path.dirname(w.file)))).toEqual([".claude-broken"]);
  });
});

describe("loadClaudeContext", () => {
  it("reads user and project settings, plugin installs, and the managed file when there is one", async () => {
    const { h, app } = seed();
    const warnings: Warning[] = [];
    const managed = h.write("managed-settings.json", { skillOverrides: { secret: "off" } });
    const accounts = await loadClaudeAccounts(h.registry, h.home, warnings);
    const ctx = await loadClaudeContext({
      accounts,
      registry: h.registry,
      homeDir: h.home,
      projects: [{ path: app, tools: ["claude"], profiles: [] }],
      managedSettings: managed,
      warnings,
    });
    expect(ctx.primaryDir).toBe(h.path(".claude"));
    expect(ctx.settings.map((s) => [s.layer, path.basename(s.file)])).toEqual([
      ["managed", "managed-settings.json"],
      ["user", "settings.json"],
      ["local", "settings.local.json"],
    ]);
    expect(ctx.plugins).toEqual([
      { id: "home@m", name: "home", installPath: h.path(".claude/plugins/cache/m/home/1.0.0") },
      { id: "proj@m", name: "proj", installPath: h.path(".claude/plugins/cache/m/proj/1.0.0"), project: app },
      { id: "sp@m", name: "sp", installPath: h.path(".claude/plugins/cache/m/sp/1.0.0") },
    ]);

    const out: Collector = { items: [], facts: emptyFacts(), warnings };
    collectClaudeSettingsFacts(ctx, out);
    expect(out.facts.claudeSkillOverrides.map((o) => [o.layer, o.map])).toEqual([
      ["managed", { secret: "off" }],
      ["user", { eli5: "off" }],
      ["local", { eli5: "on" }],
    ]);
    expect(out.facts.claudeEnabledPlugins.map((o) => o.map)).toEqual([{ "sp@m": true }]);
  });

  it("names a managed settings path for each platform", () => {
    expect(managedSettingsPath("darwin")).toBe("/Library/Application Support/ClaudeCode/managed-settings.json");
    expect(managedSettingsPath("linux")).toBe("/etc/claude-code/managed-settings.json");
    expect(managedSettingsPath("win32")).toBe("C:\\ProgramData\\ClaudeCode\\managed-settings.json");
  });
});

describe("sharesPrimaryEntry", () => {
  it("is true through a link to the primary's entry and false for an own folder", async () => {
    const { h } = seed();
    h.skill(".claude/skills", "eli5");
    h.link(".claude/skills", ".claude-work/skills");
    h.skill(".claude-broken/skills", "mine");
    const accounts = await loadClaudeAccounts(h.registry, h.home, []);
    const work = accounts.find((a) => a.id === "claude:work");
    const broken = accounts.find((a) => a.id === "claude:broken");
    if (!work || !broken) throw new Error("accounts missing");
    const primary = h.path(".claude");
    expect(await sharesPrimaryEntry(work, primary, "skills")).toBe(true);
    expect(await sharesPrimaryEntry(broken, primary, "skills")).toBe(false);
  });
});
