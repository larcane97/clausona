// Adds a third Claude Code account and route `main` to the demo home that seed.mjs built, for
// the routing GIF (scripts/demo/routing.tape). Container only, like seed.mjs.
//
//   node seed-routing.mjs <path to dist/index.js>
//
// A route needs accounts to choose among: with seed.mjs's two, one of them over the cut, there is
// no turn to take. This one, `team`, is under the cut like `work`, so `clausona run --route main`
// lands on work and then on team. It is set up the way seed.mjs sets up `work` - a signed-in,
// onboarded config dir with a placeholder credential - and registered by the real
// `clausona init --auto`, which keeps the profiles already there under their names. The route is
// made by the real `clausona route add main`. Only its plan-quota reading is written directly,
// next to the others, as seed.mjs writes them.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const clausona = process.argv[2];
const home = process.env.HOME;

if (process.env.CLAUSONA_DEMO !== "1" || !home || !clausona) {
  console.error("seed-routing.mjs only runs inside the demo container (see scripts/demo/routing.tape).");
  process.exit(1);
}
const registryPath = path.join(home, ".clausona", "profiles.json");
const quotaPath = path.join(home, ".clausona", "quota.json");
if (!existsSync(registryPath) || !existsSync(quotaPath)) {
  console.error("seed-routing.mjs: run seed.mjs first; this adds to the home it builds.");
  process.exit(1);
}
const configDir = path.join(home, ".claude-team");
if (existsSync(configDir)) {
  console.error(`seed-routing.mjs: ${configDir} already exists; it only adds to a fresh demo home.`);
  process.exit(1);
}

const now = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
// Not a credential: a placeholder no endpoint would accept, and the container has no network.
const PLACEHOLDER = "demo-placeholder";
const claudeVersion = process.env.CLAUDE_CODE_VERSION;

function write(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
}

// ─── The account ─────────────────────────────────────────────────────
write(path.join(configDir, ".claude.json"), {
  numStartups: 17,
  theme: "dark",
  hasCompletedOnboarding: true,
  hasSeenAutoDefaultNotice: true,
  ...(claudeVersion ? { lastOnboardingVersion: claudeVersion, lastReleaseNotesSeen: claudeVersion } : {}),
  oauthAccount: {
    accountUuid: "00000000-0000-4000-8000-00000000d0a1",
    emailAddress: "alex@team.example",
    displayName: "Alex",
    organizationUuid: "00000000-0000-4000-8000-00000000d0a2",
  },
  projects: {
    [path.join(home, "app")]: { allowedTools: [], hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
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

execFileSync(process.execPath, [clausona, "init", "--auto"], { stdio: ["ignore", "ignore", "inherit"] });
const registry = JSON.parse(readFileSync(registryPath, "utf8"));
const ids = Object.keys(registry.profiles).sort();
const expected = ["claude:personal", "claude:team", "claude:work", "codex:personal", "codex:team"];
if (ids.join() !== expected.join()) throw new Error(`init registered ${ids.join(", ")}, not ${expected.join(", ")}`);

// ─── Its plan quota, next to seed.mjs's readings ─────────────────────
// Under the 80% cut like work, and fuller, so a first run on a route nobody has used goes to work.
const quota = JSON.parse(readFileSync(quotaPath, "utf8"));
quota.profiles["claude:team"] = {
  session: { usedPercent: 22, resetsAt: iso(now + 2 * HOUR + 47 * MIN) },
  weekly: { usedPercent: 41, resetsAt: iso(now + 5 * DAY + 3 * HOUR) },
  state: "ok",
  fetchedAt: now,
};
writeFileSync(quotaPath, `${JSON.stringify(quota, null, 2)}\n`);

// ─── Route main: every Claude Code account, taking turns ─────────────
execFileSync(process.execPath, [clausona, "route", "add", "main"], { stdio: ["ignore", "ignore", "inherit"] });

console.log("seeded claude:team and route main");
