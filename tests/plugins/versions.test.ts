import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { SPAWN_TIMEOUT_MS, SPAWNING_TEST_TIMEOUT_MS } from "../../src/test-timeouts.js";

// Every case runs git.
vi.setConfig({ testTimeout: SPAWNING_TEST_TIMEOUT_MS });

// Claude Code updates an installed plugin only when its plugin.json names another version, so
// users keep the cached copy however many commits change the plugin. A plugin whose files changed
// since the last release needs a new version before the next one, and this fails until it has
// one. The README and evals never reach a user's machine, so they may change freely.

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: SPAWN_TIMEOUT_MS });
}

function tryGit(...args: string[]): string | undefined {
  const r = spawnSync("git", args, { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

function lines(out: string): string[] {
  return out.split(/\r?\n/).filter(Boolean);
}

function manifest(plugin: string): string {
  return `plugins/${plugin}/.claude-plugin/plugin.json`;
}

function version(json: string): string {
  return (JSON.parse(json) as { version: string }).version;
}

// The latest release tag reachable from HEAD, or why there is nothing to compare with.
function lastRelease(): { tag: string } | { skip: string } {
  const shallow = tryGit("rev-parse", "--is-shallow-repository");
  if (shallow === undefined) return { skip: "not a git checkout" };
  if (shallow === "true") return { skip: "a shallow clone has no release to compare with; fetch the full history" };
  const tag = tryGit("describe", "--tags", "--abbrev=0", "--match", "v*", "HEAD");
  if (!tag) return { skip: "no v* release tag in this checkout's history" };
  return { tag };
}

const release = lastRelease();

describe("plugin versions", () => {
  if ("skip" in release) {
    it("change wherever a plugin changed since the last release", (ctx) => ctx.skip(release.skip));
    return;
  }
  const { tag } = release;
  // A plugin that is new since the tag has no released version to differ from.
  const released = new Set(lines(git("ls-tree", "--name-only", `${tag}:plugins`)));
  const plugins = readdirSync("plugins").filter((name) => released.has(name) && existsSync(manifest(name)));

  it.each(plugins)(`%s has a new version if it changed since ${tag}`, (plugin) => {
    const changed = lines(
      git(
        "diff",
        "--name-only",
        tag,
        "--",
        `plugins/${plugin}`,
        `:(exclude)plugins/${plugin}/README.md`,
        `:(exclude)plugins/${plugin}/evals`,
      ),
    );
    if (changed.length === 0) return;
    expect(
      version(readFileSync(manifest(plugin), "utf8")),
      `${plugin} changed since ${tag} (${changed.join(", ")}); ` +
        `bump "version" in ${manifest(plugin)} so that claude plugin update installs it`,
    ).not.toBe(version(git("show", `${tag}:${manifest(plugin)}`)));
  });
});
