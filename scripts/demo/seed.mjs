// Builds the fictional clausona setup the README demo is recorded against.
//
// Not meant to be run by hand: scripts/demo/demo.tape runs it inside a throwaway container
// (see the comment at the top of that file), where HOME is an empty /Users/alex and there is
// no network. It refuses to run anywhere else - it writes account files into $HOME.
//
//   node seed.mjs <path to dist/index.js>
//
// Every account, email and number here is made up. Each Claude Code account is the state a
// signed-in, already-onboarded account leaves in its config dir, so the real `claude` in the
// image opens on it with no prompts; its credential is a placeholder, which works because the
// container has no network to try it on. The accounts are registered by the real
// `clausona init --auto`, so the profiles, shared links and health checks are the product's own;
// only the two things that normally come from outside are written directly:
//   - ~/.clausona/quota.json, the plan-quota cache, stamped with the current time. A reading
//     under 5 minutes old is served without touching the network, so `list` and the dashboard
//     show these numbers exactly as they would show a live reading.
//   - ~/.clausona/usage.json, the cost records the shell hook appends after each `claude` run.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const clausona = process.argv[2];
const home = process.env.HOME;

if (process.env.CLAUSONA_DEMO !== "1" || !home || !clausona) {
  console.error("seed.mjs only runs inside the demo container (see scripts/demo/demo.tape).");
  process.exit(1);
}
for (const name of [".clausona", ".claude", ".claude.json", ".codex"]) {
  if (existsSync(path.join(home, name))) {
    console.error(`seed.mjs: ${path.join(home, name)} already exists; it only seeds an empty HOME.`);
    process.exit(1);
  }
}

const now = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
// Not a credential: a placeholder no endpoint would accept, and the container has no network.
const PLACEHOLDER = "demo-placeholder";

function write(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
}

// ─── Claude Code accounts ────────────────────────────────────────────
// A signed-in account is its .claude.json (who, and Claude Code's own state) plus a stored
// credential; outside macOS Claude Code keeps that in .credentials.json. The state is what an
// account that has been used for a while holds: onboarding done, a theme picked, and the demo's
// project trusted - so the real `claude` opens straight onto its welcome screen.
const PROJECT = path.join(home, "app");
const claudeVersion = process.env.CLAUDE_CODE_VERSION;

function claudeAccount(configDir, jsonPath, account) {
  write(jsonPath, {
    numStartups: 42,
    theme: "dark",
    hasCompletedOnboarding: true,
    // The one-time "Auto mode is now Claude Code's default permission mode." announcement.
    hasSeenAutoDefaultNotice: true,
    ...(claudeVersion ? { lastOnboardingVersion: claudeVersion, lastReleaseNotesSeen: claudeVersion } : {}),
    oauthAccount: account,
    projects: {
      [PROJECT]: { allowedTools: [], hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    },
  });
  write(path.join(configDir, ".credentials.json"), {
    claudeAiOauth: {
      accessToken: PLACEHOLDER,
      refreshToken: PLACEHOLDER,
      expiresAt: now + 365 * DAY,
      scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
      subscriptionType: "max",
    },
  });
}

// The primary config dir: what every other Claude profile shares.
write(path.join(home, ".claude", "settings.json"), { theme: "dark" });
write(path.join(home, ".claude", "CLAUDE.md"), "# House rules\n\n- Run the tests before calling it done.\n");
write(path.join(home, ".claude", "commands", "review.md"), "Review the staged diff.\n");
claudeAccount(path.join(home, ".claude"), path.join(home, ".claude.json"), {
  accountUuid: "00000000-0000-4000-8000-00000000a1e1",
  emailAddress: "alex@home.example",
  displayName: "Alex",
  organizationUuid: "00000000-0000-4000-8000-00000000a1e2",
});
claudeAccount(path.join(home, ".claude-work"), path.join(home, ".claude-work", ".claude.json"), {
  accountUuid: "00000000-0000-4000-8000-00000000c0a1",
  emailAddress: "alex@work.example",
  displayName: "Alex",
  organizationUuid: "00000000-0000-4000-8000-00000000c0a2",
  organizationName: "Acme Corp",
});
write(path.join(PROJECT, "README.md"), "# app\n");

// ─── Codex accounts ──────────────────────────────────────────────────
// Codex names its account in the id_token inside auth.json. Only the payload is read, so the
// token is an unsigned one assembled here.
function unsignedJwt(payload) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part(payload)}.`;
}

function codexAccount(configDir, email) {
  write(path.join(configDir, "auth.json"), {
    auth_mode: "chatgpt",
    tokens: {
      id_token: unsignedJwt({ email }),
      access_token: PLACEHOLDER,
      refresh_token: PLACEHOLDER,
      account_id: `acct-${email.split("@")[1].split(".")[0]}`,
    },
    last_refresh: iso(now - HOUR),
  });
}

write(path.join(home, ".codex", "config.toml"), 'approval_policy = "on-request"\n');
write(path.join(home, ".codex", "skills", "release-notes", "SKILL.md"), "# Release notes\n");
codexAccount(path.join(home, ".codex"), "alex@home.example");
codexAccount(path.join(home, ".codex-team"), "alex@team.example");

// ─── Register them the way a user would ──────────────────────────────
execFileSync(process.execPath, [clausona, "init", "--auto"], { stdio: ["ignore", "ignore", "inherit"] });

// `init --auto` has nobody to ask, so it names each primary dir `default`. The demo calls them
// `personal`, as the interactive init would let you. A primary has no backup directory, so
// its id is only this key in profiles.json and in usage.json (rewritten below).
const registryPath = path.join(home, ".clausona", "profiles.json");
const registry = JSON.parse(readFileSync(registryPath, "utf8"));
const renamed = { "claude:default": "claude:personal", "codex:default": "codex:personal" };
const order = ["claude:personal", "claude:work", "codex:personal", "codex:team"];
const profiles = Object.fromEntries(Object.entries(registry.profiles).map(([id, p]) => [renamed[id] ?? id, p]));
if (order.some((id) => !profiles[id]) || Object.keys(profiles).length !== order.length) {
  throw new Error(`init registered ${Object.keys(profiles).join(", ")}, not ${order.join(", ")}`);
}
registry.profiles = Object.fromEntries(order.map((id) => [id, profiles[id]]));
registry.activeProfiles = { claude: "claude:personal", codex: "codex:personal" };
writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });

// ─── Cost records (Claude only) ──────────────────────────────────────
const record = (ts, cost, inputTokens, outputTokens) => ({ ts: iso(ts), cost, inputTokens, outputTokens });
const startOfToday = new Date(now);
startOfToday.setHours(0, 0, 0, 0);
const earlierToday = (minutesAgo) => Math.max(startOfToday.getTime(), now - minutesAgo * MIN);
write(path.join(home, ".clausona", "usage.json"), {
  "claude:personal": {
    records: [
      record(now - 12 * DAY, 18.2, 4_870_000, 142_000),
      record(now - 9 * DAY, 9.75, 2_610_000, 81_000),
      record(now - DAY, 7.9, 2_120_000, 66_800),
      record(earlierToday(190), 6.4, 1_720_000, 55_000),
      record(earlierToday(95), 4.12, 1_104_000, 38_400),
      record(earlierToday(20), 2.87, 766_000, 24_900),
    ],
    seenSessions: {},
  },
  "claude:work": {
    records: [
      record(now - 10 * DAY, 22.1, 5_930_000, 171_000),
      record(now - DAY, 11.2, 3_010_000, 94_500),
      record(earlierToday(240), 5.6, 1_502_000, 47_300),
      record(earlierToday(60), 3.05, 818_000, 26_200),
    ],
    seenSessions: {},
  },
});

// ─── Plan quota, as the last reading left it ─────────────────────────
// `fetchedAt: now` makes it the fresh reading clausona serves for the next 5 minutes.
const reading = (sessionUsed, sessionResetsIn, weeklyUsed, weeklyResetsIn) => ({
  session: { usedPercent: sessionUsed, resetsAt: iso(now + sessionResetsIn) },
  weekly: { usedPercent: weeklyUsed, resetsAt: iso(now + weeklyResetsIn) },
  state: "ok",
  fetchedAt: now,
});
write(path.join(home, ".clausona", "quota.json"), {
  version: 1,
  cooldowns: {},
  profiles: {
    "claude:personal": reading(96, HOUR + 18 * MIN, 81, 2 * DAY + 5 * HOUR),
    "claude:work": reading(12, 3 * HOUR + 41 * MIN, 34, 4 * DAY + 7 * HOUR),
    "codex:personal": reading(27, 2 * HOUR + 6 * MIN, 58, 3 * DAY + 2 * HOUR),
    "codex:team": reading(4, 4 * HOUR + 32 * MIN, 9, 6 * DAY + 9 * HOUR),
  },
});

console.log(`seeded ${order.length} profiles in ${home}`);
