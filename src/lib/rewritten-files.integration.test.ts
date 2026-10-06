import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Files a tool saves by renaming a new one over the old (#75), shared from the primary.
 *
 * Windows makes a file symlink only with Developer Mode or the "Create symbolic links"
 * privilege, and clausona falls back to a hard link without it - which such a save splits.
 * That fallback is reachable on any OS here: fs.symlink refuses a file symlink with EPERM, as
 * Windows does, and process.platform reads win32 while clausona links. Directories still get
 * their junction (a plain symlink off Windows), which Windows grants without the privilege.
 *
 * HOME is a temp directory, with the module graph imported again so ~/.clausona resolves into it.
 */

const temps: string[] = [];
const realPlatform = process.platform;
const refusal = { fileSymlinks: false };

afterEach(async () => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  refusal.fileSymlinks = false;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs `fn` as Windows would see it: file symlinks refused unless `symlinks` is true. */
async function asWindows<T>(fn: () => Promise<T>, { symlinks = false } = {}): Promise<T> {
  refusal.fileSymlinks = !symlinks;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    refusal.fileSymlinks = false;
  }
}

async function harness() {
  const home = mkdtempSync(path.join(tmpdir(), "clausona-rewritten-"));
  temps.push(home);
  const primary = path.join(home, ".codex");
  const work = path.join(home, ".codex-work");
  mkdirSync(path.join(primary, "skills"), { recursive: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(path.join(home, ".clausona"), { recursive: true });
  for (const [name, content] of Object.entries({
    "config.toml": 'model = "primary"\n',
    "work.config.toml": "[profiles.work]\n",
    "hooks.json": "{}\n",
    "AGENTS.md": "# shared\n",
  })) {
    writeFileSync(path.join(primary, name), content);
  }
  writeFileSync(
    path.join(home, ".clausona", "profiles.json"),
    JSON.stringify({
      version: 2,
      primarySources: { codex: primary },
      activeProfiles: { codex: "codex:default" },
      profiles: {
        "codex:default": { tool: "codex", configDir: primary, email: "a", isPrimary: true },
        "codex:work": { tool: "codex", configDir: work, email: "b" },
      },
    }),
  );

  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.resetModules();
  vi.doMock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    const symlink = async (target: string, linkPath: string, type?: string) => {
      if (refusal.fileSymlinks && type === "file") {
        throw Object.assign(new Error(`EPERM: operation not permitted, symlink '${target}' -> '${linkPath}'`), {
          code: "EPERM",
        });
      }
      return actual.symlink(target, linkPath, type as Parameters<typeof actual.symlink>[2]);
    };
    return { ...actual, symlink, default: { ...actual, symlink } };
  });
  const service = await import("./service.js");
  const { codexAdapter } = await import("../tools/codex.js");
  return {
    home,
    primary,
    work,
    service,
    link: () => service.setupSharedLinks(codexAdapter, work, primary, false, path.join(home, "backup")),
  };
}

const inode = (file: string) => statSync(file, { bigint: true }).ino;
/** What setupSharedLinks has moved into the backup directory. */
const backups = (home: string) => {
  try {
    return readdirSync(path.join(home, "backup"));
  } catch {
    return [];
  }
};

describe("sharing a file the tool saves whole, where Windows refuses a symlink", () => {
  it("keeps the profile's own copy rather than hard-linking it", async () => {
    const h = await harness();
    writeFileSync(path.join(h.work, "config.toml"), 'model = "mine"\n');
    const before = inode(path.join(h.work, "config.toml"));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await asWindows(h.link);

    const own = (name: string) => path.join(h.work, name);
    const primarys = (name: string) => path.join(h.primary, name);
    // What the profile had stays where it was, untouched and not backed up, and nothing it
    // lacked is hard-linked: a copy is all a file saved whole can be without a symlink.
    expect(readFileSync(own("config.toml"), "utf8")).toBe('model = "mine"\n');
    expect(inode(own("config.toml"))).toBe(before);
    expect(backups(h.home).filter((name) => name.startsWith("config.toml"))).toEqual([]);
    for (const name of ["config.toml", "work.config.toml", "hooks.json"]) {
      expect(inode(own(name)), name).not.toBe(inode(primarys(name)));
    }
    expect(readFileSync(own("hooks.json"), "utf8")).toBe("{}\n");
    // Everything else is shared as before: a hard link for a file, a junction for a directory.
    expect(inode(own("AGENTS.md"))).toBe(inode(primarys("AGENTS.md")));
    expect(lstatSync(own("skills")).isSymbolicLink()).toBe(true);
  });

  it.skipIf(realPlatform === "win32")(
    "links such a file by a symlink once symlinks can be made, backing up what stood there",
    async () => {
      const h = await harness();
      linkSync(path.join(h.primary, "config.toml"), path.join(h.work, "config.toml"));
      writeFileSync(path.join(h.work, "hooks.json"), '{"mine": true}\n');

      await asWindows(h.link, { symlinks: true });

      // A hard link made before this fix, and the profile's own file, both become symlinks;
      // the profile's file goes into a timestamped backup like anything else replaced.
      expect(lstatSync(path.join(h.work, "config.toml")).isSymbolicLink()).toBe(true);
      expect(lstatSync(path.join(h.work, "hooks.json")).isSymbolicLink()).toBe(true);
      const [hooksBackup, ...more] = backups(h.home).filter((name) => name.startsWith("hooks.json."));
      expect(more).toEqual([]);
      expect(readFileSync(path.join(h.home, "backup", hooksBackup ?? "missing"), "utf8")).toBe('{"mine": true}\n');
      // Nothing of the staged link is left beside it.
      expect(readdirSync(h.work).filter((name) => name.includes("clausona-link"))).toEqual([]);
    },
  );

  it("is reported by doctor as needing a symlink", async () => {
    const h = await harness();
    // One hard link made before this fix, and one copy left where no symlink could be made.
    linkSync(path.join(h.primary, "config.toml"), path.join(h.work, "config.toml"));
    writeFileSync(path.join(h.work, "hooks.json"), "{}\n");

    const results = await asWindows(() => h.service.doctorProfiles());

    const issues = results.find((result) => result.name === "codex:work")?.issues ?? [];
    const needs = (name: string) =>
      issues.find((issue) => issue.kind === "needs_symlink" && issue.message.startsWith(`${name} `));
    expect(needs("config.toml")?.message).toContain("is shared by a hard link");
    expect(needs("hooks.json")?.message).toContain("is this profile's own copy");
    expect(needs("hooks.json")?.message).toContain("Developer Mode");
    expect([needs("config.toml")?.severity, needs("hooks.json")?.severity]).toEqual(["warning", "warning"]);
    // Said in place of the generic override, not as well as it.
    expect(issues.some((issue) => issue.kind === "local_override" && issue.message.startsWith("hooks.json"))).toBe(
      false,
    );
  });
});
