// Adds fictional skills, MCP servers, hooks and plugins to the demo home that seed.mjs built,
// for the Extensions screenshots (scripts/demo/extensions-shots.mjs). Container only, like seed.mjs.
import { mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

const home = process.env.HOME;
if (process.env.CLAUSONA_DEMO !== "1" || !home) {
  console.error("seed-extensions.mjs only runs inside the demo container.");
  process.exit(1);
}
const DAY = 86_400_000;
const now = Date.now();
const write = (rel, content) => {
  const file = path.join(home, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  return file;
};
const skill = (dir, name, description, body = "Steps.") =>
  write(`${dir}/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
const mergeJson = (rel, patch) => {
  const file = path.join(home, rel);
  let current = {};
  try {
    current = JSON.parse(readFileSync(file, "utf8"));
  } catch {}
  write(rel, { ...current, ...patch });
};

const app = path.join(home, "app");
const web = path.join(home, "web");
mkdirSync(path.join(web, ".git"), { recursive: true });
mkdirSync(path.join(app, ".git"), { recursive: true });

// Global skills, one copied for Codex as is and one that drifted.
skill(".claude/skills", "eli5", "Explain any topic at the reader's level");
skill(".agents/skills", "eli5", "Explain any topic at the reader's level");
skill(".claude/skills", "plan-review", "Review an implementation plan", "Claude copy");
skill(".agents/skills", "plan-review", "Review an implementation plan", "Codex copy, edited later");
skill(".claude/skills", "sentry-cli", "Query Sentry issues from the CLI");
skill(".claude/skills", "changelog", "Draft a changelog entry");
symlinkSync(path.join(home, "old-skills", "gone"), path.join(home, ".claude/skills/gone-helper"));
// claude.ai skills synced to the personal account (uuids from seed.mjs).
skill(
  ".claude/skills/synced/00000000-0000-4000-8000-00000000a1e2_00000000-0000-4000-8000-00000000a1e1",
  "pdf",
  "Read and fill PDF forms",
);

// Projects.
skill("app/.claude/skills", "deploy-check", "Check a deploy before it ships");
skill("app/.claude/skills", "eli5", "Project copy of eli5");
skill("app/.agents/skills", "app-lint", "Lint the app the team's way");
// A project skill nobody has used, made 30 days ago. The cleanup rule reads a folder's birth
// time, which no call can set back, and the container's file system keeps one. So
// extensions-shots.mjs mounts this one folder from the host: through that mount the container
// sees no birth time, and the rule reads the modification time set here instead.
const unusedSkill = path.dirname(skill("app/.claude/skills", "db-migrate", "Run the app's database migrations"));
const monthAgo = (now - 30 * DAY) / 1000;
utimesSync(unusedSkill, monthAgo, monthAgo);
write("app/.mcp.json", { mcpServers: { "docs-search": { command: "npx", args: ["-y", "docs-search-mcp"] } } });
// A parent folder's .mcp.json: Claude Code reads it in every project below, here ~/app.
write(".mcp.json", { mcpServers: { notes: { command: "notes-mcp", args: ["--dir", "~/notes"] } } });
write("app/.claude/settings.local.json", {
  skillOverrides: { changelog: "user-invocable-only" },
  enabledMcpjsonServers: ["docs-search", "notes"],
});
skill("web/.claude/skills", "storybook", "Write a Storybook story");
skill("web/.claude/skills", "a11y-audit", "Audit a page for accessibility");
write("web/.claude/settings.json", {
  hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "format-changed" }] }] },
});
write("web/.claude/settings.local.json", '{ "skillOverrides": ');

// Two plugins: one with skills and a hook, on, and one with skills, off.
const sp = path.join(home, ".claude/plugins/cache/claude-plugins-official/superpowers/5.0.0");
const pr = path.join(home, ".claude/plugins/cache/acme-plugins/pr-tools/1.2.0");
write(".claude/plugins/installed_plugins.json", {
  version: 2,
  plugins: {
    "superpowers@claude-plugins-official": [{ scope: "user", installPath: sp, version: "5.0.0" }],
    "pr-tools@acme-plugins": [{ scope: "user", installPath: pr, version: "1.2.0" }],
  },
});
for (const name of ["brainstorming", "writing-plans", "systematic-debugging", "test-driven-development"]) {
  skill(path.relative(home, path.join(sp, "skills")), name, `superpowers ${name.replaceAll("-", " ")}`);
}
write(path.relative(home, path.join(sp, ".claude-plugin/plugin.json")), {
  name: "superpowers",
  description: "Core skills library",
});
write(path.relative(home, path.join(sp, "hooks/hooks.json")), {
  hooks: { SessionStart: [{ hooks: [{ type: "command", command: "superpowers session-start" }] }] },
});
skill(path.relative(home, path.join(pr, "skills")), "pr-summary", "Summarize a pull request");
skill(path.relative(home, path.join(pr, "skills")), "pr-checklist", "Check a pull request before review");
write(path.relative(home, path.join(pr, ".claude-plugin/plugin.json")), {
  name: "pr-tools",
  description: "Pull request helpers",
});

// Shared settings: one plugin on and one off, two hooks.
mergeJson(".claude/settings.json", {
  enabledPlugins: { "superpowers@claude-plugins-official": true, "pr-tools@acme-plugins": false },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard-shell --strict" }] }],
    Stop: [{ hooks: [{ type: "command", command: "notify-done" }] }],
  },
});

// Accounts: MCP servers that differ by account, local servers, usage.
mergeJson(".claude.json", {
  mcpServers: { github: { command: "npx", args: ["-y", "github-mcp"], env: { GITHUB_TOKEN: "demo-placeholder" } } },
  skillUsage: {
    eli5: { usageCount: 26, lastUsedAt: now - 2 * DAY },
    "sentry-cli": { usageCount: 3, lastUsedAt: now - 140 * DAY },
    "superpowers:brainstorming": { usageCount: 49, lastUsedAt: now - DAY },
  },
});
const personal = JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8"));
personal.projects[app] = {
  ...personal.projects[app],
  mcpServers: { "postgres-dev": { command: "pg-mcp", args: ["--dsn", "postgres://demo@localhost/app"] } },
};
personal.projects[web] = { hasTrustDialogAccepted: true };
writeFileSync(path.join(home, ".claude.json"), `${JSON.stringify(personal, null, 2)}\n`);
const workFile = path.join(home, ".claude-work/.claude.json");
const work = JSON.parse(readFileSync(workFile, "utf8"));
work.mcpServers = {
  linear: { type: "http", url: "https://mcp.linear.example/mcp" },
  github: { command: "npx", args: ["-y", "github-mcp"] },
};
work.projects[app] = { ...work.projects[app], disabledMcpServers: ["github"] };
work.skillUsage = {
  eli5: { usageCount: 181, lastUsedAt: now - 3 * 3_600_000 },
  changelog: { usageCount: 12, lastUsedAt: now - 9 * DAY },
};
writeFileSync(workFile, `${JSON.stringify(work, null, 2)}\n`);

// Codex: servers, a skill switch, a hook, the app project trusted.
const codexConfig = path.join(home, ".codex/config.toml");
writeFileSync(
  codexConfig,
  `${readFileSync(codexConfig, "utf8")}\n[projects."${app}"]\ntrust_level = "trusted"\n\n[mcp_servers.docs]\ncommand = "npx"\nargs = ["-y", "docs-mcp"]\n\n[mcp_servers.legacy-search]\ncommand = "legacy"\nenabled = false\n\n[[skills.config]]\nname = "release-notes"\nenabled = false\n`,
);
write(".codex/hooks.json", { hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-done --codex" }] }] } });

console.log("seeded extensions");
