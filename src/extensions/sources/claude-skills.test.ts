import { afterEach, describe, expect, it } from "vitest";

import { type Collector, emptyFacts } from "../model.js";
import { TestHome } from "../test-home.js";
import { collectClaudeSettingsFacts, loadClaudeAccounts, loadClaudeContext } from "./claude-context.js";
import { readClaudeSkills } from "./claude-skills.js";

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.dispose();
});

async function inventoryOf(h: TestHome, paths: string[]) {
  const out: Collector = { items: [], facts: emptyFacts(), warnings: [] };
  const projects = paths.map((p) => ({ path: p, tools: ["claude" as const], profiles: [] }));
  const accounts = await loadClaudeAccounts(h.registry, h.home, out.warnings);
  const ctx = await loadClaudeContext({
    accounts,
    registry: h.registry,
    homeDir: h.home,
    projects,
    managedSettings: h.path("no-managed.json"),
    warnings: out.warnings,
  });
  collectClaudeSettingsFacts(ctx, out);
  await readClaudeSkills(ctx, projects, out);
  return out;
}

describe("readClaudeSkills", () => {
  it("finds every kind of skill once, with its scope and owner", async () => {
    const h = new TestHome();
    homes.push(h);
    h.claude("default", ".claude", {
      oauthAccount: { organizationUuid: "org1", accountUuid: "acc1" },
    });
    h.claude("work", ".claude-work");
    h.claude("solo", ".claude-solo");
    h.skill(".claude/skills", "eli5", "Explain simply");
    h.link("/nowhere/at/all", ".claude/skills/gone");
    h.write(".claude/skills/notes-only/README.md", "not a skill");
    h.write(".claude/commands/review.md", "---\ndescription: Review the diff\n---\nReview.");
    h.skill(".claude/skills/synced/org1_acc1", "pdf");
    h.write(".claude/skills/synced/org1_acc1/manifest.json", { skills: [] });
    h.link(".claude/skills", ".claude-work/skills");
    h.skill(".claude-solo/skills", "solo-only");
    const app = h.project("repos/app");
    h.skill("repos/app/.claude/skills", "deploy-check");
    h.skill("repos/app/.claude/skills", "eli5");
    const sp = h.path(".claude/plugins/cache/m/superpowers/1.0.0");
    h.write(".claude/plugins/installed_plugins.json", { plugins: { "superpowers@m": [{ installPath: sp }] } });
    h.skill(".claude/plugins/cache/m/superpowers/1.0.0/skills", "brainstorming");
    h.write(".claude/plugins/cache/m/superpowers/1.0.0/commands/plan.md", "Plan.");
    h.write(".claude/settings.json", { skillOverrides: { "claude-api": "off", eli5: "name-only" } });

    const out = await inventoryOf(h, [app]);
    const rows = out.items
      .map(
        (i) => `${i.location.scope}|${i.location.profile ?? i.location.project ?? i.location.plugin ?? "-"}|${i.name}`,
      )
      .sort();
    expect(rows).toEqual(
      [
        `builtin|-|claude-api`,
        `global|-|eli5`,
        `global|-|gone`,
        `global|-|review`,
        `account|claude:solo|solo-only`,
        `synced|claude:default|pdf`,
        `project|${app}|deploy-check`,
        `project|${app}|eli5`,
        `plugin|superpowers@m|superpowers:brainstorming`,
        `plugin|superpowers@m|superpowers:plan`,
      ].sort(),
    );
    const byName = Object.fromEntries(out.items.map((i) => [`${i.location.scope}:${i.name}`, i]));
    expect(byName["global:eli5"]?.description).toBe("Explain simply");
    expect(byName["global:gone"]?.link?.broken).toBe(true);
    expect(byName["global:review"]?.summary).toEqual({ type: "command" });
    expect(byName["global:review"]?.description).toBe("Review the diff");
    expect(byName["synced:pdf"]?.usageKeys).toEqual(["pdf", "anthropic-skills:pdf"]);
    expect(byName["plugin:superpowers:brainstorming"]?.usageKeys).toEqual(["superpowers:brainstorming"]);
    expect(byName["plugin:superpowers:brainstorming"]?.location.accounts).toEqual(["claude:default"]);
    expect(new Set(out.items.map((i) => i.id)).size).toBe(out.items.length);
  });

  it("lists a plugin's skills once per install, each with its own id", async () => {
    const h = new TestHome();
    homes.push(h);
    h.claude("default", ".claude");
    h.claude("work", ".claude-work");
    const app = h.project("repos/app");
    const v1 = h.path(".claude/plugins/cache/m/superpowers/1.0.0");
    const v2 = h.path(".claude/plugins/cache/m/superpowers/2.0.0");
    h.skill(".claude/plugins/cache/m/superpowers/1.0.0/skills", "brainstorming");
    h.write(".claude/plugins/cache/m/superpowers/1.0.0/commands/plan.md", "Plan.");
    h.skill(".claude/plugins/cache/m/superpowers/2.0.0/skills", "brainstorming");
    h.write(".claude/plugins/installed_plugins.json", {
      plugins: { "superpowers@m": [{ installPath: v1 }, { installPath: v1, scope: "local", projectPath: app }] },
    });
    h.write(".claude-work/plugins/installed_plugins.json", { plugins: { "superpowers@m": [{ installPath: v2 }] } });

    const out = await inventoryOf(h, [app]);
    const installs = (name: string) =>
      out.items
        .filter((i) => i.name === name)
        .map((i) => `${i.location.plugin}|${i.location.project ?? "-"}|${i.location.accounts?.join(",")}`)
        .sort();
    expect(installs("superpowers:brainstorming")).toEqual(
      ["superpowers@m|-|claude:default", `superpowers@m|${app}|claude:default`, "superpowers@m|-|claude:work"].sort(),
    );
    expect(installs("superpowers:plan")).toEqual(
      ["superpowers@m|-|claude:default", `superpowers@m|${app}|claude:default`].sort(),
    );
    expect(new Set(out.items.map((i) => i.id)).size).toBe(out.items.length);
  });
});
