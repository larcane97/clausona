import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { leakedWindows } from "../test-leaks.js";
import {
  type Action,
  COMMAND_OF,
  NEXT_VISIBILITY,
  REFUSAL_CODES,
  REFUSALS,
  refusalText,
  stopText,
  toggleVerb,
} from "./actions.js";
import { valueHash } from "./hash.js";
import { loadInventory } from "./inventory.js";
import type { Inventory } from "./model.js";
import { actionsLine, keysFor, type Plan, type PlanContext, plan, rowForId, trackCandidates } from "./plan.js";
import { tilde } from "./present.js";
import { pathKey, samePath } from "./read.js";
import { type ItemKind, pluginContents, rowsIn, type ScopeId, type ScopeRow, type ToolName } from "./scopes.js";
import { stashFileName, stashIdFor, stashText } from "./stash.js";
import { TestHome } from "./test-home.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 10, 4, 36, 48);
// Built from pieces, so no key-shaped string sits in the source.
const KEY = ["sk", "ant", "api03", "Q2xhdXNvbmFUZXN0S2V5MTIzNDU2Nzg5MA"].join("-");
const STASH = path.join(".clausona", "extensions", "stash");

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.dispose();
});

const SETTINGS = {
  enabledPlugins: { "kit@m": true },
  hooks: {
    Stop: [
      {
        hooks: [
          { type: "command", command: "notify-a" },
          { type: "command", command: "notify-b" },
        ],
      },
    ],
  },
};

type More = (h: TestHome, app: string, web: string) => void;

/**
 * Two Claude accounts (default has opened app and web, work only app, where it has turned
 * github off) and a Codex one that trusts app and not web. Global eli5, old-one, a link notes
 * and a broken link lost; app's deploy-check; web's web-only; the Cloud pdf; Codex's eli5 and
 * app's app-lint; the plugin kit@m with a skill and a SessionStart hook; two Stop hooks in user
 * settings; github and figma in both accounts; docs-search in app's .mcp.json; Codex's docs.
 */
function home(more?: More): { h: TestHome; app: string; web: string } {
  const h = new TestHome();
  homes.push(h);
  const app = h.project("repos/app");
  const web = h.project("repos/web");
  h.claude("default", ".claude", {
    oauthAccount: { organizationUuid: "org", accountUuid: "one" },
    projects: { [app]: {}, [web]: {} },
    mcpServers: { github: { command: "gh", env: { GITHUB_TOKEN: KEY } }, figma: { command: "figma" } },
  });
  h.claude("work", ".claude-work", {
    projects: { [app]: { disabledMcpServers: ["github"] } },
    mcpServers: { github: { command: "gh" }, figma: { command: "figma" } },
  });
  h.codex(
    "personal",
    ".codex",
    `[projects.'${app}']\ntrust_level = "trusted"\n\n[projects.'${web}']\ntrust_level = "untrusted"\n\n[mcp_servers.docs]\ncommand = "docs"\n`,
  );
  h.skill(".claude/skills", "eli5");
  h.skill(".claude/skills", "old-one");
  h.skill("repos/app/.claude/skills", "deploy-check");
  h.skill(".agents/skills", "eli5");
  h.skill("repos/app/.agents/skills", "app-lint");
  h.skill("repos/web/.claude/skills", "web-only");
  h.skill(".claude/skills/synced/org_one", "pdf");
  h.skill("shared", "notes");
  h.link("shared/notes", ".claude/skills/notes");
  h.link(h.path("gone", "lost"), ".claude/skills/lost");
  const kit = h.path(".claude/plugins/cache/m/kit/1.0.0");
  h.write(".claude/plugins/installed_plugins.json", { plugins: { "kit@m": [{ installPath: kit }] } });
  h.skill(".claude/plugins/cache/m/kit/1.0.0/skills", "plan");
  h.write(".claude/plugins/cache/m/kit/1.0.0/hooks/hooks.json", {
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "kit-start" }] }] },
  });
  h.write(".claude/settings.json", SETTINGS);
  h.write("repos/app/.mcp.json", { mcpServers: { "docs-search": { command: "ds" } } });
  more?.(h, app, web);
  return { h, app, web };
}

// The managed settings are the home's own, so no test reads this machine's.
function load(h: TestHome, cwd: string): Promise<Inventory> {
  return loadInventory({
    homeDir: h.home,
    registry: h.registry,
    cwd,
    managedSettings: h.path("managed-settings.json"),
  });
}

function contextFor(h: TestHome, inv: Inventory, project: string | undefined): PlanContext {
  return { inv, project, now: NOW, tracked: new Set(), stashDir: h.path(STASH) };
}

async function seed(more?: More) {
  const { h, app, web } = home(more);
  const inv = await load(h, app);
  return { h, app, web, inv, ctx: contextFor(h, inv, app) };
}

/** The one row named `name` in a scope, seen from `project`. */
function rowIn(
  inv: Inventory,
  project: string | undefined,
  scope: ScopeId,
  name: string,
  tool: ToolName = "claude",
  kind: ItemKind = "skill",
): ScopeRow {
  const found = rowsIn(inv, tool, kind, scope, project, NOW).filter((r) => r.name === name);
  if (found.length !== 1) throw new Error(`${found.length} rows named ${name} in ${tool} ${kind} ${scope}`);
  return found[0] as ScopeRow;
}

function hookRow(inv: Inventory, project: string, command: string): ScopeRow {
  const found = rowsIn(inv, "claude", "hook", "global", project, NOW).filter(
    (r) => r.items[0]?.summary?.command === command,
  );
  if (found.length !== 1) throw new Error(`${found.length} hook rows running ${command}`);
  return found[0] as ScopeRow;
}

const act = (verb: Action["verb"], reach: Action["reach"], rows: ScopeRow[], more: Partial<Action> = {}): Action => ({
  verb,
  reach,
  rows,
  ...more,
});

const codes = (p: Plan) => p.refused.map((r) => r.code);

describe("plan: Claude skills", () => {
  it("turns a Global skill off in this project in its local settings, a file it makes", async () => {
    const { app, inv, ctx } = await seed();
    const eli5 = rowIn(inv, app, "global", "eli5");
    const p = plan(ctx, "skills", act("off", "here", [eli5]));
    const file = path.join(app, ".claude", "settings.local.json");
    expect(p.changes).toEqual([
      {
        kind: "json",
        file,
        edits: [{ op: "set", path: ["skillOverrides", "eli5"], value: "off" }],
        expect: [{ type: "value", path: ["skillOverrides", "eli5"], hash: null }],
        create: true,
        lock: false,
        lines: [{ file, change: "create", what: "skillOverrides.eli5 → off", tracked: false, rows: [eli5.key] }],
      },
    ]);
    expect(p.question).toBe("Turn off eli5 in this project?");
    expect(p.done).toBe("Turned off eli5 in this project");
    expect(p.refused).toEqual([]);
    expect(p.unchanged).toEqual([]);
    expect(p.accounts).toBeUndefined();
    expect(p.project).toBe(app);
  });

  it("turns it on here with an override when user settings turn it off, and by removing a local one", async () => {
    const user = await seed((h) => h.write(".claude/settings.json", { ...SETTINGS, skillOverrides: { eli5: "off" } }));
    const fromUser = plan(user.ctx, "skills", act("on", "here", [rowIn(user.inv, user.app, "global", "eli5")]));
    expect(fromUser.changes.map((c) => [c.file, c.kind === "json" ? c.edits : []])).toEqual([
      [
        path.join(user.app, ".claude", "settings.local.json"),
        [{ op: "set", path: ["skillOverrides", "eli5"], value: "on" }],
      ],
    ]);

    const local = await seed((h) =>
      h.write("repos/app/.claude/settings.local.json", { skillOverrides: { eli5: "off" } }),
    );
    const p = plan(local.ctx, "skills", act("on", "here", [rowIn(local.inv, local.app, "global", "eli5")]));
    const file = path.join(local.app, ".claude", "settings.local.json");
    expect(p.changes).toMatchObject([
      {
        kind: "json",
        file,
        edits: [{ op: "delete", path: ["skillOverrides", "eli5"] }],
        expect: [{ type: "value", path: ["skillOverrides", "eli5"], hash: valueHash("off") }],
        lines: [{ file, change: "edit", what: "skillOverrides.eli5 removed" }],
      },
    ]);
  });

  it("turns a skill off everywhere in user settings, back on by removing it, and says when it is already off", async () => {
    const { h, app, inv, ctx } = await seed();
    const oldOne = rowIn(inv, app, "global", "old-one");
    const off = plan(ctx, "skills", act("off", "everywhere", [oldOne]));
    const userFile = h.path(".claude", "settings.json");
    expect(off.changes).toMatchObject([
      {
        kind: "json",
        file: userFile,
        edits: [{ op: "set", path: ["skillOverrides", "old-one"], value: "off" }],
        lines: [{ file: userFile, change: "edit", what: "skillOverrides.old-one → off" }],
      },
    ]);
    expect(off.question).toBe("Turn off old-one in every project?");

    const user = await seed((h) =>
      h.write(".claude/settings.json", { ...SETTINGS, skillOverrides: { "old-one": "off" } }),
    );
    const row = rowIn(user.inv, user.app, "global", "old-one");
    const on = plan(user.ctx, "skills", act("on", "everywhere", [row]));
    expect(on.changes).toMatchObject([{ edits: [{ op: "delete", path: ["skillOverrides", "old-one"] }] }]);
    const again = plan(user.ctx, "skills", act("off", "everywhere", [row]));
    expect(again.changes).toEqual([]);
    expect(again.unchanged).toEqual([{ rowKey: row.key, name: "old-one", why: "already off in every project" }]);
  });

  it("notes the file that still keeps a skill off here once it is back on everywhere", async () => {
    const { app, inv, ctx } = await seed((h) => {
      h.write(".claude/settings.json", { ...SETTINGS, skillOverrides: { eli5: "off" } });
      h.write("repos/app/.claude/settings.local.json", { skillOverrides: { eli5: "off" } });
    });
    const p = plan(ctx, "skills", act("on", "everywhere", [rowIn(inv, app, "global", "eli5")]));
    expect(p.changes).toHaveLength(1);
    expect(p.notes).toEqual([`Still off in ${tilde(path.join(app, ".claude", "settings.local.json"), inv.homeDir)}`]);
  });

  it("sets a visibility level in this project", async () => {
    const { app, inv, ctx } = await seed();
    const p = plan(
      ctx,
      "skills",
      act("visibility", "here", [rowIn(inv, app, "global", "eli5")], { level: "name-only" }),
    );
    expect(p.changes).toMatchObject([
      {
        file: path.join(app, ".claude", "settings.local.json"),
        edits: [{ op: "set", path: ["skillOverrides", "eli5"], value: "name-only" }],
        lines: [{ what: "skillOverrides.eli5 → name-only" }],
      },
    ]);
    expect(p.level).toBe("name-only");
    expect(p.question).toBe("Show eli5 as name only in this project?");
    expect(p.done).toBe("eli5 shows as name only in this project");
    const call = plan(
      ctx,
      "skills",
      act("visibility", "here", [rowIn(inv, app, "global", "eli5")], { level: "user-invocable-only" }),
    );
    expect(call.question).toBe("Show eli5 only when you call it in this project?");
  });

  it("deletes a skill folder by its real path", async () => {
    const { h, app, inv, ctx } = await seed();
    const oldOne = rowIn(inv, app, "global", "old-one");
    const p = plan(ctx, "skills", act("rm", "here", [oldOne]));
    const real = realpathSync(h.path(".claude/skills/old-one"));
    expect(p.changes).toEqual([
      {
        kind: "remove",
        file: real,
        what: "folder",
        expect: [{ type: "entry", kind: "dir", realPath: real }],
        lines: [
          { file: h.path(".claude/skills/old-one"), change: "delete", what: "", tracked: false, rows: [oldOne.key] },
        ],
      },
    ]);
    expect(p.question).toBe("Delete old-one?");
    expect(p.done).toBe("Deleted old-one");
  });

  it("removes a linked skill's link only, and leaves its target alone", async () => {
    const { h, app, inv, ctx } = await seed();
    const notes = rowIn(inv, app, "global", "notes");
    const p = plan(ctx, "skills", act("rm", "here", [notes]));
    const link = h.path(".claude/skills/notes");
    expect(p.changes).toEqual([
      {
        kind: "remove",
        file: link,
        what: "link",
        expect: [{ type: "entry", kind: "link", target: notes.items[0]?.link?.target }],
        lines: [
          {
            file: link,
            change: "unlink",
            what: "",
            note: "link only, target kept",
            tracked: false,
            rows: [notes.key],
          },
        ],
      },
    ]);
    const shared = realpathSync(h.path("shared/notes"));
    expect(p.changes.some((c) => samePath(c.file, shared) || samePath(c.file, h.path("shared/notes")))).toBe(false);
  });

  // A file symlink needs privileges on Windows.
  it.skipIf(process.platform === "win32")(
    "removes a command file that is a link, and keeps what it leads to",
    async () => {
      let target = "";
      const { h, app, inv, ctx } = await seed((h) => {
        target = h.write("dotfiles/commands/ship.md", "Ship.");
        mkdirSync(h.path(".claude", "commands"), { recursive: true });
        symlinkSync(target, h.path(".claude", "commands", "ship.md"), "file");
      });
      const ship = rowIn(inv, app, "global", "ship");
      const link = h.path(".claude", "commands", "ship.md");
      expect(plan(ctx, "skills", act("rm", "here", [ship])).changes).toEqual([
        {
          kind: "remove",
          file: link,
          what: "link",
          expect: [{ type: "entry", kind: "link", target: ship.items[0]?.link?.target }],
          lines: [
            {
              file: link,
              change: "unlink",
              what: "",
              note: "link only, target kept",
              tracked: false,
              rows: [ship.key],
            },
          ],
        },
      ]);
      expect(samePath(ship.items[0]?.link?.target, target)).toBe(true);
    },
  );

  it("removes a broken link, and refuses to turn it off", async () => {
    const { h, app, inv, ctx } = await seed();
    const lost = rowIn(inv, app, "global", "lost");
    expect(plan(ctx, "skills", act("rm", "here", [lost])).changes).toMatchObject([
      { kind: "remove", what: "link", file: h.path(".claude/skills/lost") },
    ]);
    const off = plan(ctx, "skills", act("off", "here", [lost]));
    expect(off.changes).toEqual([]);
    expect(off.refused).toEqual([
      {
        rowKey: lost.key,
        name: "lost",
        code: "broken-link",
        reason: "Its link leads nowhere.",
        keys: "Press d to remove the link.",
        flags: "Remove the link: clausona skills rm lost.",
      },
    ]);
    expect(refusalText(off.refused[0] as Plan["refused"][number], "keys")).toBe(
      "Its link leads nowhere. Press d to remove the link.",
    );
  });

  it("deletes one folder two rows lead to only when both rows are in the action, then once", async () => {
    const h = new TestHome();
    homes.push(h);
    h.claude("default", ".claude", {});
    h.codex("personal", ".codex", "");
    h.skill(".agents/skills", "shared-one");
    h.link(".agents/skills", ".claude/skills");
    const inv = await load(h, h.home);
    const ctx = contextFor(h, inv, undefined);
    const claude = rowIn(inv, undefined, "global", "shared-one", "claude");
    const codex = rowIn(inv, undefined, "global", "shared-one", "codex");

    const alone = plan(ctx, "skills", act("rm", "here", [claude]));
    expect(alone.changes).toEqual([]);
    expect(alone.refused.map((r) => [r.code, r.reason])).toEqual([
      ["one-folder", "It is the same folder as Codex › Global shared-one, through a link."],
    ]);
    expect(refusalText(alone.refused[0] as Plan["refused"][number], "flags")).toBe(
      `It is the same folder as Codex › Global shared-one, through a link. Delete both together: clausona skills rm --id ${claude.key} --id ${codex.key}.`,
    );

    const both = plan(ctx, "skills", act("rm", "here", [claude, codex]));
    expect(both.refused).toEqual([]);
    expect(both.changes).toHaveLength(1);
    const change = both.changes[0];
    expect(change?.kind).toBe("remove");
    expect(samePath(change?.file, realpathSync(h.path(".agents/skills/shared-one")))).toBe(true);
    expect(change?.lines).toHaveLength(1);
    expect(change?.lines[0]?.rows).toEqual([claude.key, codex.key]);
    expect(both.question).toBe("Delete 2 skills?");
  });

  it("refuses to delete a Cloud skill or a plugin, and to switch a plugin's skill", async () => {
    const { app, inv, ctx } = await seed();
    const pdf = rowIn(inv, app, "cloud", "pdf");
    expect(codes(plan(ctx, "skills", act("rm", "here", [pdf])))).toEqual(["cloud-delete"]);
    const kitSkill = rowIn(inv, app, "loaded", "kit:plan");
    const off = plan(ctx, "skills", act("off", "here", [kitSkill]));
    expect(off.refused.map((r) => [r.code, r.reason])).toEqual([["plugin-item", "It comes with the plugin kit@m."]]);
    expect(refusalText(off.refused[0] as Plan["refused"][number], "flags")).toBe(
      "It comes with the plugin kit@m. Turn the plugin on or off: clausona skills off kit@m --scope plugins.",
    );
    const kit = rowIn(inv, app, "plugins", "kit@m");
    expect(codes(plan(ctx, "skills", act("rm", "here", [kit])))).toEqual(["plugin-delete"]);
  });

  it("refuses to change what git tracks, unless the action allows it", async () => {
    const { h, app, inv, ctx } = await seed();
    const deploy = rowIn(inv, app, "project", "deploy-check");
    const tracked = { ...ctx, tracked: new Set([pathKey(h.path("repos/app/.claude/skills/deploy-check"))]) };
    const refused = plan(tracked, "skills", act("rm", "here", [deploy]));
    expect(refused.changes).toEqual([]);
    expect(refused.refused.map((r) => [r.code, r.reason, r.project])).toEqual([
      ["tracked", "Git tracks it in app, so this changes the repo.", "app"],
    ]);
    expect(refusalText(refused.refused[0] as Plan["refused"][number], "flags")).toBe(
      "Git tracks it in app, so this changes the repo. Add --tracked to go ahead, or turn it off: clausona skills off deploy-check.",
    );
    const allowed = plan(tracked, "skills", act("rm", "here", [deploy], { tracked: true }));
    expect(allowed.refused).toEqual([]);
    expect(allowed.changes).toMatchObject([
      { kind: "remove", what: "folder", lines: [{ tracked: true, note: "changes the repo" }] },
    ]);
    // What git could track: files and folders inside a project that is not the home dir.
    expect(trackCandidates(plan(ctx, "skills", act("rm", "here", [deploy])), inv).map(pathKey)).toContain(
      pathKey(h.path("repos/app/.claude/skills/deploy-check")),
    );
    expect(
      trackCandidates(plan(ctx, "skills", act("rm", "here", [rowIn(inv, app, "global", "old-one")])), inv),
    ).toEqual([]);
  });

  it("refuses a file it could not read, naming it from the home dir", async () => {
    const { app, inv, ctx } = await seed((h) => h.write("repos/app/.claude/settings.local.json", "{ broken"));
    const p = plan(ctx, "skills", act("off", "here", [rowIn(inv, app, "global", "eli5")]));
    expect(p.changes).toEqual([]);
    const file = tilde(path.join(app, ".claude", "settings.local.json"), inv.homeDir);
    expect(file.startsWith(`~${path.sep}`)).toBe(true);
    expect(p.refused.map((r) => r.code)).toEqual(["unreadable"]);
    expect(refusalText(p.refused[0] as Plan["refused"][number], "flags")).toBe(
      `${file} could not be read. Fix it, then try again.`,
    );
    // Before anything is called already so: eli5 is on, but what the file says is not known.
    const on = plan(ctx, "skills", act("on", "here", [rowIn(inv, app, "global", "eli5")]));
    expect(on.unchanged).toEqual([]);
    expect(codes(on)).toEqual(["unreadable"]);
    expect(
      codes(plan(ctx, "mcp", act("on", "here", [rowIn(inv, app, "project", "docs-search", "claude", "mcp")]))),
    ).toEqual(["unreadable"]);
  });

  it("refuses to turn a skill off here with no project", async () => {
    const { h, inv } = await seed();
    const ctx = contextFor(h, inv, undefined);
    const p = plan(ctx, "skills", act("off", "here", [rowIn(inv, undefined, "global", "eli5")]));
    expect(p.refused.map((r) => [r.code, refusalText(r, "keys")])).toEqual([
      ["no-project", "There is no project to change it in. Pick one with p."],
    ]);
  });

  it("plans what it can and refuses the rest, for the caller to decide", async () => {
    const { app, inv, ctx } = await seed();
    const oldOne = rowIn(inv, app, "global", "old-one");
    const pdf = rowIn(inv, app, "cloud", "pdf");
    const p = plan(ctx, "skills", act("rm", "here", [oldOne, pdf]));
    expect(p.changes.flatMap((c) => c.lines.flatMap((l) => l.rows))).toEqual([oldOne.key]);
    expect(p.refused.map((r) => [r.rowKey, r.code])).toEqual([[pdf.key, "cloud-delete"]]);
    // The question is about what will change.
    expect(p.question).toBe("Delete old-one?");
  });

  it("refuses what managed settings decide, and managed items", async () => {
    const { app, inv, ctx } = await seed((h) =>
      h.write("managed-settings.json", {
        skillOverrides: { "old-one": "on" },
        hooks: { Stop: [{ hooks: [{ type: "command", command: "policy" }] }] },
      }),
    );
    const off = plan(ctx, "skills", act("off", "here", [rowIn(inv, app, "global", "old-one")]));
    expect(off.refused.map((r) => [r.code, r.reason])).toEqual([
      ["managed", "It is set by your organization's policy."],
    ]);
    const policy = rowIn(inv, app, "managed", "Stop", "claude", "hook");
    expect(codes(plan(ctx, "hooks", act("off", "everywhere", [policy])))).toEqual(["managed"]);
    expect(codes(plan(ctx, "hooks", act("rm", "here", [policy])))).toEqual(["managed"]);
    expect(codes(plan(ctx, "hooks", act("visibility", "here", [policy], { level: "name-only" })))).toEqual(["managed"]);
    // Deleting the folder is no setting: managed settings do not stop it.
    expect(plan(ctx, "skills", act("rm", "here", [rowIn(inv, app, "global", "old-one")])).refused).toEqual([]);
  });

  it("shows a skill as the full skill again from name only, which a plain on leaves as it is", async () => {
    const { app, inv, ctx } = await seed((h) =>
      h.write("repos/app/.claude/settings.local.json", { skillOverrides: { eli5: "name-only" } }),
    );
    const eli5 = rowIn(inv, app, "global", "eli5");
    expect(plan(ctx, "skills", act("on", "here", [eli5])).unchanged).toEqual([
      { rowKey: eli5.key, name: "eli5", why: "already on in this project" },
    ]);
    const full = plan(ctx, "skills", act("visibility", "here", [eli5], { level: "on" }));
    expect(full.changes).toMatchObject([{ edits: [{ op: "delete", path: ["skillOverrides", "eli5"] }] }]);
    expect(full.question).toBe("Show eli5 as the full skill in this project?");
    expect(plan(ctx, "skills", act("visibility", "here", [eli5], { level: "name-only" })).unchanged).toEqual([
      { rowKey: eli5.key, name: "eli5", why: "already shows as name only in this project" },
    ]);
  });

  it("refuses to delete what comes with either tool, saying how to turn it off in that tool", async () => {
    const { app, inv, ctx } = await seed((h) => {
      h.write(".claude/settings.json", { ...SETTINGS, skillOverrides: { "claude-api": "on" } });
      h.skill(".codex/skills/.system", "imagegen");
    });
    const claude = plan(ctx, "skills", act("rm", "here", [rowIn(inv, app, "builtin", "claude-api")])).refused;
    expect(claude.map((r) => [refusalText(r, "keys"), refusalText(r, "flags")])).toEqual([
      [
        "It comes with Claude Code. Press space to turn it off instead.",
        "It comes with Claude Code. Turn it off instead: clausona skills off claude-api.",
      ],
    ]);
    const codex = plan(ctx, "skills", act("rm", "here", [rowIn(inv, app, "builtin", "imagegen", "codex")])).refused;
    expect(codex.map((r) => [refusalText(r, "keys"), refusalText(r, "flags")])).toEqual([
      [
        "It comes with Codex. Press g to turn it off instead.",
        "It comes with Codex. Turn it off instead: clausona skills off imagegen --everywhere.",
      ],
    ]);
  });
});

describe("plan: Codex skills", () => {
  it("turns a user skill off everywhere by name and a project skill off here by path, never here for a user skill", async () => {
    const { h, app, inv, ctx } = await seed();
    const eli5 = rowIn(inv, app, "global", "eli5", "codex");
    expect(codes(plan(ctx, "skills", act("off", "here", [eli5])))).toEqual(["codex-user-here"]);
    const config = h.path(".codex", "config.toml");
    const everywhere = plan(ctx, "skills", act("off", "everywhere", [eli5]));
    expect(everywhere.changes).toEqual([
      {
        kind: "toml",
        file: config,
        edits: [{ op: "skill-config", selector: { name: "eli5" }, enabled: false }],
        expect: [{ type: "skill-config", selector: { name: "eli5" }, enabled: null }],
        create: true,
        lines: [{ file: config, change: "edit", what: "skills.config eli5 → off", tracked: false, rows: [eli5.key] }],
      },
    ]);
    const appLint = rowIn(inv, app, "project", "app-lint", "codex");
    const skillFile = path.join(app, ".agents", "skills", "app-lint", "SKILL.md");
    expect(plan(ctx, "skills", act("off", "here", [appLint])).changes).toMatchObject([
      {
        kind: "toml",
        file: config,
        edits: [{ op: "skill-config", selector: { path: skillFile }, enabled: false }],
        lines: [{ what: `skills.config ${tilde(skillFile, inv.homeDir)} → off` }],
      },
    ]);
    expect(codes(plan(ctx, "skills", act("visibility", "here", [eli5], { level: "name-only" })))).toEqual([
      "no-visibility",
    ]);
  });

  it("reads the entry it expects as the TOML writer finds it: one with both a name and a path is no entry", async () => {
    const { app, inv, ctx } = await seed((h, appDir) =>
      h.codex(
        "personal",
        ".codex",
        `[projects.'${appDir}']\ntrust_level = "trusted"\n\n[[skills.config]]\nname = "eli5"\npath = "/x/SKILL.md"\nenabled = false\n`,
      ),
    );
    const eli5 = rowIn(inv, app, "global", "eli5", "codex");
    expect(plan(ctx, "skills", act("off", "everywhere", [eli5])).changes).toMatchObject([
      { expect: [{ type: "skill-config", selector: { name: "eli5" }, enabled: null }] },
    ]);
  });

  it("puts a project skill back on here over a name entry that turns it off", async () => {
    const { app, inv, ctx } = await seed((h, appDir) =>
      h.codex(
        "personal",
        ".codex",
        `[projects.'${appDir}']\ntrust_level = "trusted"\n\n[[skills.config]]\nname = "app-lint"\nenabled = false\n`,
      ),
    );
    const appLint = rowIn(inv, app, "project", "app-lint", "codex");
    const skillFile = path.join(app, ".agents", "skills", "app-lint", "SKILL.md");
    expect(plan(ctx, "skills", act("on", "here", [appLint])).changes).toMatchObject([
      { edits: [{ op: "skill-config", selector: { path: skillFile }, enabled: true }] },
    ]);
    expect(plan(ctx, "skills", act("on", "everywhere", [appLint])).changes).toMatchObject([
      {
        edits: [{ op: "skill-config", selector: { name: "app-lint" }, enabled: null }],
        expect: [{ type: "skill-config", selector: { name: "app-lint" }, enabled: false }],
        lines: [{ what: "skills.config app-lint removed" }],
      },
    ]);
  });
});

describe("plan: Claude MCP servers", () => {
  it("turns an account server off here in each account that has opened the project", async () => {
    const { h, app, inv, ctx } = await seed();
    const github = rowIn(inv, app, "global", "github", "claude", "mcp");
    const p = plan(ctx, "mcp", act("off", "here", [github]));
    const file = h.path(".claude.json");
    expect(inv.places.claudeJson["claude:default"]).toBe(file);
    expect(p.changes).toEqual([
      {
        kind: "json",
        file,
        edits: [{ op: "list-add", path: ["projects", { projectKey: app }, "disabledMcpServers"], value: "github" }],
        expect: [],
        create: false,
        lock: true,
        lines: [
          {
            file,
            change: "edit",
            what: "disabledMcpServers + github",
            account: "claude:default",
            tracked: false,
            rows: [github.key],
          },
        ],
      },
    ]);
    expect(p.unchanged).toEqual([{ rowKey: github.key, name: "github", why: "already off in work" }]);
    expect(p.accounts).toEqual([{ profile: "claude:default", chosen: true }]);
    expect(p.question).toBe("Turn off github in this project, for default?");

    const workOnly = plan(ctx, "mcp", act("off", "here", [github], { accounts: ["claude:work"] }));
    expect(workOnly.changes).toEqual([]);
    expect(workOnly.accounts).toEqual([{ profile: "claude:default", chosen: false }]);

    const on = plan(ctx, "mcp", act("on", "here", [github]));
    expect(on.changes).toMatchObject([
      {
        file: h.path(".claude-work", ".claude.json"),
        edits: [{ op: "list-remove", path: ["projects", { projectKey: app }, "disabledMcpServers"], value: "github" }],
        lock: true,
        lines: [{ what: "disabledMcpServers - github", account: "claude:work" }],
      },
    ]);
    expect(on.question).toBe("Turn on github in this project, for work?");
    expect(on.done).toBe("Turned on github in this project, for work");
  });

  it("skips an account that has not opened the project, with a note, and never plans its entry", async () => {
    const { h, inv, web } = await seed();
    const ctx = contextFor(h, inv, web);
    const github = rowIn(inv, web, "global", "github", "claude", "mcp");
    const p = plan(ctx, "mcp", act("off", "here", [github]));
    expect(p.changes.map((c) => c.file)).toEqual([h.path(".claude.json")]);
    expect(p.changes).toMatchObject([
      { edits: [{ op: "list-add", path: ["projects", { projectKey: web }, "disabledMcpServers"], value: "github" }] },
    ]);
    expect(p.notes).toEqual(["work has not opened this project"]);
    const workOnly = plan(ctx, "mcp", act("off", "here", [github], { accounts: ["claude:work"] }));
    expect(workOnly.changes).toEqual([]);
    expect(workOnly.refused.map((r) => [r.code, r.reason])).toEqual([
      ["no-account", "No account that has it has opened this project."],
    ]);
  });

  it("takes an account server out of every account to turn it off everywhere, kept by clausona", async () => {
    const { h, app, inv, ctx } = await seed();
    const figma = rowIn(inv, app, "global", "figma", "claude", "mcp");
    const p = plan(ctx, "mcp", act("off", "everywhere", [figma]));
    const files = [h.path(".claude.json"), h.path(".claude-work", ".claude.json")];
    expect(p.changes.map((c) => c.file)).toEqual(files);
    const profiles = ["claude:default", "claude:work"];
    p.changes.forEach((change, i) => {
      const copy = figma.items.find((item) => item.location.profile === profiles[i]);
      const id = stashIdFor(copy?.id ?? "", NOW);
      expect(change).toEqual({
        kind: "json",
        file: files[i],
        edits: [{ op: "delete", path: ["mcpServers", "figma"] }],
        expect: [{ type: "value", path: ["mcpServers", "figma"], hash: valueHash({ command: "figma" }) }],
        create: false,
        lock: true,
        stash: {
          file: path.join(ctx.stashDir, stashFileName(id)),
          meta: {
            id,
            kind: "mcp",
            tool: "claude",
            name: "figma",
            file: files[i],
            path: ["mcpServers", "figma"],
            scope: "account",
            profile: profiles[i],
          },
        },
        lines: [
          {
            file: files[i],
            change: "edit",
            what: "mcpServers.figma taken out, kept by clausona",
            account: profiles[i],
            tracked: false,
            rows: [figma.key],
          },
        ],
      });
    });
    expect(p.question).toBe("Turn off figma in every project, for default and work?");
    const github = rowIn(inv, app, "global", "github", "claude", "mcp");
    const secretPlan = JSON.stringify(plan(ctx, "mcp", act("off", "everywhere", [github])));
    expect(secretPlan).not.toContain(KEY);
    expect(leakedWindows([secretPlan], KEY)).toEqual([]);
  });

  it("switches a .mcp.json server in this project's local settings, never everywhere, and deletes it from its file", async () => {
    const { app, inv, ctx } = await seed();
    const docs = rowIn(inv, app, "project", "docs-search", "claude", "mcp");
    const local = path.join(app, ".claude", "settings.local.json");
    expect(plan(ctx, "mcp", act("off", "here", [docs])).changes).toMatchObject([
      {
        kind: "json",
        file: local,
        create: true,
        edits: [
          { op: "list-add", path: ["disabledMcpjsonServers"], value: "docs-search" },
          { op: "list-remove", path: ["enabledMcpjsonServers"], value: "docs-search" },
        ],
        lines: [{ what: "disabledMcpjsonServers + docs-search" }],
      },
    ]);
    expect(codes(plan(ctx, "mcp", act("off", "everywhere", [docs])))).toEqual(["mcpjson-everywhere"]);
    const mcpjson = path.join(app, ".mcp.json");
    expect(plan(ctx, "mcp", act("rm", "here", [docs])).changes).toEqual([
      {
        kind: "json",
        file: mcpjson,
        edits: [{ op: "delete", path: ["mcpServers", "docs-search"] }],
        expect: [{ type: "value", path: ["mcpServers", "docs-search"], hash: valueHash({ command: "ds" }) }],
        create: false,
        lock: false,
        lines: [
          { file: mcpjson, change: "edit", what: "mcpServers.docs-search deleted", tracked: false, rows: [docs.key] },
        ],
      },
    ]);
  });

  it("turns a .mcp.json server on here, also in the accounts that denied it, and not over user settings", async () => {
    const accounts = await seed((h, app) => {
      h.claude("work", ".claude-work", {
        projects: { [app]: { disabledMcpjsonServers: ["docs-search"] } },
        mcpServers: {},
      });
    });
    const docs = rowIn(accounts.inv, accounts.app, "project", "docs-search", "claude", "mcp");
    const p = plan(accounts.ctx, "mcp", act("on", "here", [docs]));
    expect(p.changes).toMatchObject([
      {
        file: path.join(accounts.app, ".claude", "settings.local.json"),
        edits: [
          { op: "list-remove", path: ["disabledMcpjsonServers"], value: "docs-search" },
          { op: "list-add", path: ["enabledMcpjsonServers"], value: "docs-search" },
        ],
        lines: [{ what: "enabledMcpjsonServers + docs-search" }],
      },
      {
        file: accounts.h.path(".claude-work", ".claude.json"),
        lock: true,
        edits: [
          {
            op: "list-remove",
            path: ["projects", { projectKey: accounts.app }, "disabledMcpjsonServers"],
            value: "docs-search",
          },
        ],
        lines: [{ what: "disabledMcpjsonServers - docs-search", account: "claude:work" }],
      },
    ]);

    const user = await seed((h) =>
      h.write(".claude/settings.json", { ...SETTINGS, disabledMcpjsonServers: ["docs-search"] }),
    );
    const denied = plan(
      user.ctx,
      "mcp",
      act("on", "here", [rowIn(user.inv, user.app, "project", "docs-search", "claude", "mcp")]),
    );
    expect(denied.changes).toEqual([]);
    expect(denied.refused.map((r) => [r.code, r.reason])).toEqual([
      [
        "elsewhere",
        `It is turned off in ${tilde(user.h.path(".claude", "settings.json"), user.inv.homeDir)}, which applies here.`,
      ],
    ]);
  });

  it("puts a server clausona kept back where it came from, and keeps it from being turned on here", async () => {
    const { h, app, inv, ctx } = await seed((h, appDir) => {
      const work = h.claude("work", ".claude-work", {
        projects: { [appDir]: { disabledMcpServers: ["github"] } },
        mcpServers: { github: { command: "gh" } },
      });
      const id = stashIdFor("mcp:claude:account:claude:work:figma", NOW - DAY);
      h.write(
        path.join(STASH, stashFileName(id)),
        stashText({
          version: 1,
          id,
          kind: "mcp",
          tool: "claude",
          name: "figma",
          file: work.jsonPath,
          path: ["mcpServers", "figma"],
          scope: "account",
          profile: "claude:work",
          entry: { command: "figma" },
          stashedAt: new Date(NOW - DAY).toISOString(),
        }),
      );
    });
    const figma = rowIn(inv, app, "global", "figma", "claude", "mcp");
    const kept = figma.items.find((item) => item.stashed);
    expect(kept?.location.profile).toBe("claude:work");
    const on = plan(ctx, "mcp", act("on", "everywhere", [figma]));
    const workJson = h.path(".claude-work", ".claude.json");
    expect(on.changes).toEqual([
      {
        kind: "json",
        file: workJson,
        edits: [{ op: "restore", path: ["mcpServers", "figma"] }],
        expect: [{ type: "value", path: ["mcpServers", "figma"], hash: null }],
        create: false,
        lock: true,
        fromStash: kept?.stashed?.file,
        lines: [
          {
            file: workJson,
            change: "edit",
            what: "mcpServers.figma put back",
            account: "claude:work",
            tracked: false,
            rows: [figma.key],
          },
        ],
      },
    ]);
    expect(on.unchanged).toEqual([{ rowKey: figma.key, name: "figma", why: "not off everywhere in default" }]);
    const here = plan(ctx, "mcp", act("on", "here", [figma], { accounts: ["claude:work"] }));
    expect(here.refused.map((r) => [r.code, refusalText(r, "keys")])).toEqual([
      ["stashed-here", "It is off everywhere. Press g to turn it back on."],
    ]);
    expect(plan(ctx, "mcp", act("on", "here", [figma])).notes).toEqual([
      "work is off everywhere: turn it on everywhere first.",
    ]);
  });

  it("refuses to put a server back into a file that is gone, and deletes the copy clausona kept instead", async () => {
    let stashFile = "";
    const { h, app, inv, ctx } = await seed((h, appDir) => {
      h.claude("work", ".claude-work", { projects: { [appDir]: {} }, mcpServers: {} });
      const id = stashIdFor("mcp:claude:account:claude:work:figma", NOW - DAY);
      stashFile = h.write(
        path.join(STASH, stashFileName(id)),
        stashText({
          version: 1,
          id,
          kind: "mcp",
          tool: "claude",
          name: "figma",
          file: h.path("gone", ".claude.json"),
          path: ["mcpServers", "figma"],
          scope: "account",
          profile: "claude:work",
          entry: { command: "figma" },
          stashedAt: new Date(NOW - DAY).toISOString(),
        }),
      );
    });
    const figma = rowIn(inv, app, "global", "figma", "claude", "mcp");
    const gone = figma.items.find((item) => item.stashed?.gone);
    const on = plan(ctx, "mcp", act("on", "everywhere", [figma]));
    expect(on.changes).toEqual([]);
    expect(on.refused.map((r) => [r.code, r.reason, r.keys, r.flags])).toEqual([
      [
        "stash-gone",
        `${tilde(h.path("gone", ".claude.json"), inv.homeDir)}, where it came from, is gone.`,
        // d on the row would take default's live figma too.
        "Press d and choose only work in the dialog.",
        `Delete the copy clausona kept: clausona mcp rm --id ${gone?.id}.`,
      ],
    ]);
    const stashRemoved = {
      kind: "remove",
      file: stashFile,
      what: "file",
      expect: [{ type: "entry", kind: "file" }],
      lines: [
        { file: stashFile, change: "delete", what: "", account: "claude:work", tracked: false, rows: [figma.key] },
      ],
    };
    const rm = plan(ctx, "mcp", act("rm", "here", [figma], { accounts: ["claude:work"] }));
    expect(rm.refused).toEqual([]);
    expect(rm.changes).toEqual([stashRemoved]);

    // Following the flags' hint: --id <that copy> is the row narrowed to it, and default's live figma stays.
    const byId = rowForId(figma, gone?.id ?? "");
    expect(byId?.items).toEqual([gone]);
    const hinted = plan(ctx, "mcp", act("rm", "here", [byId as ScopeRow]));
    expect(hinted.changes).toEqual([stashRemoved]);
    expect(hinted.changes.some((c) => samePath(c.file, h.path(".claude.json")))).toBe(false);
    // The whole row, by its key, is every copy.
    expect(rowForId(figma, figma.key)).toBe(figma);
    expect(plan(ctx, "mcp", act("rm", "here", [figma])).changes.map((c) => c.file)).toEqual([
      h.path(".claude.json"),
      stashFile,
    ]);
    expect(rowForId(figma, "mcp:claude:account:nobody:figma")).toBeUndefined();
    // Two copies named by their ids, or a row named twice, plan as one row.
    const live = figma.items.find((item) => !item.stashed);
    const both = plan(ctx, "mcp", act("rm", "here", [byId as ScopeRow, rowForId(figma, live?.id ?? "") as ScopeRow]));
    expect(both.changes.map((c) => c.lines.map((l) => l.rows))).toEqual([[[figma.key]], [[figma.key]]]);
    expect(both.question).toBe("Delete figma?");
  });

  it("refuses to turn a .mcp.json server on over a managed denial", async () => {
    const { app, inv, ctx } = await seed((h) =>
      h.write("managed-settings.json", { disabledMcpjsonServers: ["docs-search"] }),
    );
    const docs = rowIn(inv, app, "project", "docs-search", "claude", "mcp");
    expect(codes(plan(ctx, "mcp", act("on", "here", [docs])))).toEqual(["managed"]);
  });

  it("switches a plugin's server here in each account that has the plugin and has opened the project", async () => {
    const seeded = await seed((h) => {
      const kit = h.path(".claude/plugins/cache/m/kit/1.0.0");
      h.write(".claude/plugins/cache/m/kit/1.0.0/.mcp.json", { mcpServers: { kitdb: { command: "kd" } } });
      h.write(".claude-work/plugins/installed_plugins.json", { plugins: { "kit@m": [{ installPath: kit }] } });
    });
    const { h, inv, web } = seeded;
    const ctx = contextFor(h, inv, web);
    const kitdb = rowIn(inv, web, "loaded", "plugin:kit:kitdb", "claude", "mcp");
    const off = plan(ctx, "mcp", act("off", "here", [kitdb]));
    expect(off.changes).toEqual([
      {
        kind: "json",
        file: h.path(".claude.json"),
        edits: [
          { op: "list-add", path: ["projects", { projectKey: web }, "disabledMcpServers"], value: "plugin:kit:kitdb" },
        ],
        expect: [],
        create: false,
        lock: true,
        lines: [
          {
            file: h.path(".claude.json"),
            change: "edit",
            what: "disabledMcpServers + plugin:kit:kitdb",
            account: "claude:default",
            tracked: false,
            rows: [kitdb.key],
          },
        ],
      },
    ]);
    expect(off.notes).toEqual(["work has not opened this project"]);
    expect(codes(plan(ctx, "mcp", act("off", "everywhere", [kitdb])))).toEqual(["plugin-item"]);
    expect(codes(plan(ctx, "mcp", act("rm", "here", [kitdb])))).toEqual(["plugin-item"]);

    const pluginOff = await seed((h) => {
      h.write(".claude/plugins/cache/m/kit/1.0.0/.mcp.json", { mcpServers: { kitdb: { command: "kd" } } });
      h.write(".claude/settings.json", { ...SETTINGS, enabledPlugins: { "kit@m": false } });
    });
    // A server of a plugin that is off is in no table but its plugin's: the row its details list.
    const kitRow = rowIn(pluginOff.inv, pluginOff.app, "plugins", "kit@m", "claude", "mcp");
    const [serverRow] = pluginContents(pluginOff.inv, kitRow).mcp;
    expect(serverRow?.name).toBe("plugin:kit:kitdb");
    expect(
      plan(pluginOff.ctx, "mcp", act("on", "here", [serverRow as ScopeRow])).refused.map((r) => [
        r.code,
        refusalText(r, "keys"),
      ]),
    ).toEqual([["plugin-item", "It comes with the plugin kit@m. Turn the plugin on or off in Plugins."]]);
  });
});

describe("plan: Codex MCP servers", () => {
  it("switches a user server off here in the project's config, where Codex trusts the project and it is not home", async () => {
    const { h, app, web, inv, ctx } = await seed();
    const docs = rowIn(inv, app, "global", "docs", "codex", "mcp");
    const projectConfig = path.join(app, ".codex", "config.toml");
    expect(plan(ctx, "mcp", act("off", "here", [docs])).changes).toEqual([
      {
        kind: "toml",
        file: projectConfig,
        edits: [{ op: "mcp-enabled", server: "docs", enabled: false }],
        expect: [{ type: "toml", path: ["mcp_servers", "docs", "enabled"], hash: null }],
        create: true,
        lines: [
          {
            file: projectConfig,
            change: "create",
            what: "mcp_servers.docs.enabled → false",
            tracked: false,
            rows: [docs.key],
          },
        ],
      },
    ]);
    expect(codes(plan({ ...ctx, project: web }, "mcp", act("off", "here", [docs])))).toEqual(["codex-untrusted"]);
    expect(codes(plan({ ...ctx, project: h.home }, "mcp", act("off", "here", [docs])))).toEqual(["codex-home-here"]);
    expect(plan(ctx, "mcp", act("off", "everywhere", [docs])).changes).toMatchObject([
      {
        kind: "toml",
        file: h.path(".codex", "config.toml"),
        edits: [{ op: "mcp-enabled", server: "docs", enabled: false }],
      },
    ]);
    expect(plan(ctx, "mcp", act("rm", "here", [docs])).changes).toMatchObject([
      {
        kind: "toml",
        file: h.path(".codex", "config.toml"),
        edits: [{ op: "mcp-delete", server: "docs" }],
        expect: [{ type: "toml", path: ["mcp_servers", "docs"], hash: valueHash({ command: "docs" }) }],
        lines: [{ what: "[mcp_servers.docs] deleted" }],
      },
    ]);
  });

  it("turns a user server back on here over the user config's off, rather than only clearing the project's", async () => {
    const { app, inv, ctx } = await seed((h, appDir, webDir) => {
      h.codex(
        "personal",
        ".codex",
        `[projects.'${appDir}']\ntrust_level = "trusted"\n\n[projects.'${webDir}']\ntrust_level = "untrusted"\n\n[mcp_servers.docs]\ncommand = "docs"\nenabled = false\n`,
      );
      h.write("repos/app/.codex/config.toml", "[mcp_servers.docs]\nenabled = false\n");
    });
    const docs = rowIn(inv, app, "global", "docs", "codex", "mcp");
    expect(plan(ctx, "mcp", act("on", "here", [docs])).changes).toMatchObject([
      {
        file: path.join(app, ".codex", "config.toml"),
        edits: [{ op: "mcp-enabled", server: "docs", enabled: true }],
        expect: [{ type: "toml", path: ["mcp_servers", "docs", "enabled"], hash: valueHash(false) }],
      },
    ]);
  });
});

describe("plan: Codex project servers and hooks", () => {
  const projectFiles: More = (h) => {
    h.write("repos/app/.codex/config.toml", '[mcp_servers.local-db]\ncommand = "db"\n');
    h.write("repos/web/.codex/config.toml", '[mcp_servers.web-db]\ncommand = "wdb"\n');
    h.write("repos/web/.codex/hooks.json", {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "web-stop" }] }] },
    });
  };

  it("switches a trusted project's own server in its own config, here only", async () => {
    const { app, inv, ctx } = await seed(projectFiles);
    const localDb = rowIn(inv, app, "project", "local-db", "codex", "mcp");
    const file = path.join(app, ".codex", "config.toml");
    expect(plan(ctx, "mcp", act("off", "here", [localDb])).changes).toEqual([
      {
        kind: "toml",
        file,
        edits: [{ op: "mcp-enabled", server: "local-db", enabled: false }],
        expect: [{ type: "toml", path: ["mcp_servers", "local-db", "enabled"], hash: null }],
        create: false,
        lines: [
          { file, change: "edit", what: "mcp_servers.local-db.enabled → false", tracked: false, rows: [localDb.key] },
        ],
      },
    ]);
    expect(codes(plan(ctx, "mcp", act("off", "everywhere", [localDb])))).toEqual(["codex-project-everywhere"]);
    expect(
      refusalText(plan(ctx, "mcp", act("off", "everywhere", [localDb])).refused[0] as Plan["refused"][number], "flags"),
    ).toBe("It is defined in this project only. Leave out --everywhere.");
  });

  it("writes nothing under the .codex folder of a project Codex does not trust", async () => {
    const { app, web, inv, ctx } = await seed(projectFiles);
    const webDb = rowsIn(inv, "codex", "mcp", "other", app, NOW, web).find((r) => r.name === "web-db") as ScopeRow;
    for (const verb of ["off", "on", "rm"] as const) {
      expect(codes(plan(ctx, "mcp", act(verb, "here", [webDb])))).toEqual(["codex-untrusted"]);
    }
    const webStop = rowsIn(inv, "codex", "hook", "other", app, NOW, web).find((r) => r.name === "Stop") as ScopeRow;
    expect(webStop.items[0]?.location.file).toBe(path.join(web, ".codex", "hooks.json"));
    expect(codes(plan(ctx, "hooks", act("off", "everywhere", [webStop])))).toEqual(["codex-untrusted"]);
    expect(codes(plan(ctx, "hooks", act("rm", "here", [webStop])))).toEqual(["codex-untrusted"]);
    expect(
      refusalText(plan(ctx, "hooks", act("rm", "here", [webStop])).refused[0] as Plan["refused"][number], "keys"),
    ).toBe("Codex does not trust this project, so it ignores its .codex folder. Trust the project in Codex first.");
  });
});

describe("plan: hooks and plugins", () => {
  it("turns a hook off only everywhere, taking it out and keeping it", async () => {
    const { h, app, inv, ctx } = await seed();
    const notifyA = hookRow(inv, app, "notify-a");
    expect(
      refusalText(plan(ctx, "hooks", act("off", "here", [notifyA])).refused[0] as Plan["refused"][number], "keys"),
    ).toBe("Claude Code has no per-project switch for hooks. Press g to turn it off everywhere.");
    const settings = h.path(".claude", "settings.json");
    const item = notifyA.items[0];
    const id = stashIdFor(item?.id ?? "", NOW);
    const p = plan(ctx, "hooks", act("off", "everywhere", [notifyA]));
    expect(p.changes).toEqual([
      {
        kind: "json",
        file: settings,
        edits: [{ op: "hook-remove", place: { base: "hooks", event: "Stop", group: 0, index: 0 } }],
        expect: [
          {
            type: "value",
            path: ["hooks", "Stop", 0, "hooks", 0],
            hash: valueHash({ type: "command", command: "notify-a" }),
          },
        ],
        create: false,
        lock: false,
        stash: {
          file: path.join(ctx.stashDir, stashFileName(id)),
          meta: {
            id,
            kind: "hook",
            tool: "claude",
            name: "Stop",
            file: settings,
            path: ["hooks", "Stop"],
            scope: "global",
            hook: { base: "hooks", event: "Stop", group: 0, index: 0 },
          },
        },
        lines: [
          {
            file: settings,
            change: "edit",
            what: "Stop hook taken out, kept by clausona",
            tracked: false,
            rows: [notifyA.key],
          },
        ],
      },
    ]);
    expect(p.question).toBe("Turn off the Stop hook in every project?");
    const kitHook = rowIn(inv, app, "loaded", "SessionStart", "claude", "hook");
    expect(codes(plan(ctx, "hooks", act("off", "everywhere", [kitHook])))).toEqual(["plugin-item"]);
  });

  it("takes two hooks of one group out last first, so each place still holds its hook", async () => {
    const { app, inv, ctx } = await seed();
    const rows = [hookRow(inv, app, "notify-a"), hookRow(inv, app, "notify-b")];
    const off = plan(ctx, "hooks", act("off", "everywhere", rows));
    expect(off.changes.map((c) => (c.kind === "json" ? c.edits : []))).toEqual([
      [{ op: "hook-remove", place: { base: "hooks", event: "Stop", group: 0, index: 1 } }],
      [{ op: "hook-remove", place: { base: "hooks", event: "Stop", group: 0, index: 0 } }],
    ]);
    expect(off.question).toBe("Turn off 2 hooks in every project?");
    const rm = plan(ctx, "hooks", act("rm", "here", rows));
    expect(rm.changes).toHaveLength(1);
    expect(rm.changes[0]).toMatchObject({
      edits: [
        { op: "hook-remove", place: { group: 0, index: 1 } },
        { op: "hook-remove", place: { group: 0, index: 0 } },
      ],
      lines: [{ what: "Stop hook deleted" }, { what: "Stop hook deleted" }],
    });
  });

  it("puts hooks clausona kept back first place first, and refuses one whose file is gone", async () => {
    const files: Record<string, string> = {};
    const { h, app, inv, ctx } = await seed((h) => {
      h.write(".claude/settings.json", { enabledPlugins: { "kit@m": true } });
      const kept = (command: string, index: number, file: string) => {
        const id = stashIdFor(`hook:claude:global:-:Stop#0.${index}:${command}`, NOW - DAY);
        files[command] = h.write(
          path.join(STASH, stashFileName(id)),
          stashText({
            version: 1,
            id,
            kind: "hook",
            tool: "claude",
            name: "Stop",
            file,
            path: ["hooks", "Stop"],
            scope: "global",
            hook: { base: "hooks", event: "Stop", group: 0, index },
            entry: { type: "command", command },
            stashedAt: new Date(NOW - DAY).toISOString(),
          }),
        );
      };
      kept("notify-a", 0, h.path(".claude", "settings.json"));
      kept("notify-b", 1, h.path(".claude", "settings.json"));
      kept("notify-gone", 0, h.path("gone", "settings.json"));
    });
    const [a, b, gone] = ["notify-a", "notify-b", "notify-gone"].map((command) => hookRow(inv, app, command));
    // A kept hook's row is that one copy: d on it deletes only what clausona kept.
    for (const row of [a, b, gone]) {
      expect(row?.items).toHaveLength(1);
      expect(row?.key).toBe(row?.items[0]?.id);
    }
    const settings = h.path(".claude", "settings.json");
    const on = plan(ctx, "hooks", act("on", "everywhere", [b as ScopeRow, a as ScopeRow]));
    expect(on.changes).toEqual(
      [
        [a, "notify-a", 0],
        [b, "notify-b", 1],
      ].map(([row, command, index]) => ({
        kind: "json",
        file: settings,
        edits: [{ op: "hook-restore", place: { base: "hooks", event: "Stop", group: 0, index } }],
        expect: [],
        create: false,
        lock: false,
        fromStash: files[command as string],
        lines: [
          {
            file: settings,
            change: "edit",
            what: "Stop hook put back",
            tracked: false,
            rows: [(row as ScopeRow).key],
          },
        ],
      })),
    );
    expect(on.question).toBe("Turn on 2 hooks in every project?");
    const refused = plan(ctx, "hooks", act("on", "everywhere", [gone as ScopeRow])).refused;
    expect(refused.map((r) => [r.code, refusalText(r, "keys"), refusalText(r, "flags")])).toEqual([
      [
        "stash-gone",
        `${tilde(h.path("gone", "settings.json"), inv.homeDir)}, where it came from, is gone. Press d to delete the copy clausona kept.`,
        `${tilde(h.path("gone", "settings.json"), inv.homeDir)}, where it came from, is gone. Delete the copy clausona kept: clausona hooks rm --id ${gone?.key}.`,
      ],
    ]);
    expect(plan(ctx, "hooks", act("rm", "here", [gone as ScopeRow])).changes).toMatchObject([
      { kind: "remove", what: "file", file: files["notify-gone"] },
    ]);
  });

  it("switches a plugin in this project's local settings or in user settings", async () => {
    const { h, app, inv, ctx } = await seed();
    const kit = rowIn(inv, app, "plugins", "kit@m");
    const local = path.join(app, ".claude", "settings.local.json");
    expect(plan(ctx, "skills", act("off", "here", [kit])).changes).toMatchObject([
      {
        file: local,
        edits: [{ op: "set", path: ["enabledPlugins", "kit@m"], value: false }],
        lines: [{ what: "enabledPlugins.kit@m → false" }],
      },
    ]);
    expect(plan(ctx, "skills", act("off", "here", [kit])).question).toBe("Turn off kit in this project?");
    expect(plan(ctx, "skills", act("off", "everywhere", [kit])).changes).toMatchObject([
      {
        file: h.path(".claude", "settings.json"),
        edits: [{ op: "set", path: ["enabledPlugins", "kit@m"], value: false }],
        expect: [{ type: "value", path: ["enabledPlugins", "kit@m"], hash: valueHash(true) }],
      },
    ]);
    expect(plan(ctx, "skills", act("on", "everywhere", [kit])).unchanged).toEqual([
      { rowKey: kit.key, name: "kit@m", why: "already on in every project" },
    ]);
  });
});

describe("keys and toggles", () => {
  it("lists the keys that apply to a row, and the reason for one that does not", async () => {
    const { app, inv, ctx } = await seed();
    const eli5 = keysFor(ctx, "skills", rowIn(inv, app, "global", "eli5"));
    expect(eli5.map((c) => c.key)).toEqual(["space", "g", "d", "v"]);
    expect(eli5.map((c) => ("label" in c ? c.label : c.refused))).toEqual([
      "off here",
      "off everywhere",
      "delete",
      "name only",
    ]);
    expect(actionsLine(eli5)).toBe("space off here · g off everywhere · d delete · v name only");
    const v = eli5[3];
    expect(v && "action" in v ? v.action : undefined).toMatchObject({
      verb: "visibility",
      reach: "here",
      level: "name-only",
    });

    const pdf = keysFor(ctx, "skills", rowIn(inv, app, "cloud", "pdf"));
    expect(pdf[2]).toEqual({ key: "d", refused: "It comes back from claude.ai. Press space to turn it off instead." });
    expect(actionsLine(pdf)).toBe("space off here · g off everywhere · v name only");

    const codex = keysFor(ctx, "skills", rowIn(inv, app, "global", "eli5", "codex"));
    expect(codex[0]).toEqual({ key: "space", refused: "Codex turns a user skill off everywhere or nowhere. Press g." });
    expect(codex[3]).toEqual({ key: "v", refused: "Only a Claude skill has visibility levels." });
    expect(actionsLine(codex)).toBe("g off everywhere · d delete");
  });

  it("toggles on where a row is off at that reach, else off", async () => {
    const { app, inv } = await seed((h) =>
      h.write("repos/app/.claude/settings.local.json", { skillOverrides: { eli5: "off" } }),
    );
    const eli5 = rowIn(inv, app, "global", "eli5");
    expect(toggleVerb(inv, eli5, app, "here")).toBe("on");
    expect(toggleVerb(inv, eli5, app, "everywhere")).toBe("off");
    const github = rowIn(inv, app, "global", "github", "claude", "mcp");
    expect(toggleVerb(inv, github, app, "here")).toBe("off");
    expect(toggleVerb(inv, github, app, "here", ["claude:work"])).toBe("on");
  });

  it("goes round the visibility levels, names each command's kind, and words every refusal", () => {
    expect(NEXT_VISIBILITY).toEqual({
      on: "name-only",
      "name-only": "user-invocable-only",
      "user-invocable-only": "off",
      off: "on",
    });
    expect(COMMAND_OF).toEqual({ skill: "skills", mcp: "mcp", hook: "hooks" });
    expect(Object.keys(REFUSALS)).toEqual([...REFUSAL_CODES]);
  });

  it("says why an apply stopped, in either voice", () => {
    const home = path.join(path.sep, "home", "me");
    const file = path.join(home, ".claude.json");
    const shown = `~${path.sep}.claude.json`;
    expect(stopText({ file, reason: "changed" }, "keys", home, "mcp")).toBe(
      `${shown} changed since it was read. Press r and try again.`,
    );
    expect(stopText({ file, reason: "changed" }, "flags", home, "mcp")).toBe(
      `${shown} changed since it was read. Run the command again.`,
    );
    expect(stopText({ file, reason: "locked" }, "flags", home, "mcp")).toBe(
      `Claude Code is saving ${shown}. Try again in a moment.`,
    );
    const id = "mcp:claude:account:stash-x-1:figma";
    const conflict = { file, reason: "conflict" as const, name: "figma", rowKey: id };
    const byId = `figma is back in ${shown} already. Delete the copy clausona kept: clausona mcp rm --id ${id}.`;
    expect(stopText(conflict, "flags", home, "mcp")).toBe(byId);
    // The server back in the account's file shares the row with the kept copy: d would take both.
    expect(stopText(conflict, "keys", home, "mcp")).toBe(byId);
    expect(stopText({ file, reason: "conflict", name: "figma" }, "flags", home, "mcp")).toBe(
      `figma is back in ${shown} already. Delete the copy clausona kept: clausona mcp rm --id '<id>'.`,
    );
    const hooksFile = path.join(home, ".claude", "settings.json");
    expect(stopText({ file: hooksFile, reason: "conflict", name: "Stop" }, "keys", home, "hooks")).toBe(
      `Stop is back in ~${path.sep}${path.join(".claude", "settings.json")} already. Press d to delete the copy clausona kept.`,
    );
    expect(stopText({ file, reason: "failed", detail: "EACCES" }, "keys", home, "mcp")).toBe(
      `Could not change ${shown}: EACCES.`,
    );
  });
});
