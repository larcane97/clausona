import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

/** A seam into `rename`: the next `exdev` calls fail as a move across file systems does. */
const fsHooks = vi.hoisted(() => ({ exdev: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const rename: typeof actual.rename = async (from, to) => {
    if (fsHooks.exdev > 0) {
      fsHooks.exdev -= 1;
      throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
    }
    return actual.rename(from, to);
  };
  return { ...actual, default: { ...actual, rename }, rename };
});

import { hashTree, samePath } from "../read.js";
import { TestHome } from "../test-home.js";
import {
  ensureDir,
  entryKind,
  makeLink,
  moveTo,
  readLinkInfo,
  readMaybe,
  realOrSelf,
  removeLink,
  removeTree,
  writeAtomic,
  writePrivate,
} from "./fs.js";

const homes: TestHome[] = [];
afterEach(() => {
  fsHooks.exdev = 0;
  for (const home of homes.splice(0)) home.dispose();
});

function home(): TestHome {
  const h = new TestHome();
  homes.push(h);
  return h;
}

const mode = (p: string) => statSync(p).mode & 0o777;
const onWindows = process.platform === "win32";

describe("writeAtomic", () => {
  it.skipIf(onWindows)("writes a linked file through its link, which stays a link", async () => {
    const h = home();
    h.write("dotfiles/settings.json", { theme: "dark" });
    h.link("dotfiles/settings.json", ".claude/settings.json");
    const link = h.path(".claude", "settings.json");

    const real = await realOrSelf(link);
    expect(real).toBe(realpathSync(h.path("dotfiles", "settings.json")));
    await writeAtomic(real, '{\n  "theme": "light"\n}\n', 0o644);

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(h.path("dotfiles", "settings.json"), "utf8")).toBe('{\n  "theme": "light"\n}\n');
    // The temp file went next to the real file, and is gone once renamed over it.
    expect(readdirSync(h.path("dotfiles"))).toEqual(["settings.json"]);
    expect((await readMaybe(link))?.real).toBe(real);
  });

  it.skipIf(onWindows)("keeps a file's mode, and writes private files 0600 in 0700 folders", async () => {
    const h = home();
    const file = h.write("secret.json", "{}\n");
    chmodSync(file, 0o600);
    const read = await readMaybe(file);
    if (!read) throw new Error("not read");
    await writeAtomic(read.real, '{ "a": 1 }\n', read.mode & 0o777);
    expect(mode(file)).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe('{ "a": 1 }\n');

    await writePrivate(h.path("private", "a", "b.json"), "x");
    expect(mode(h.path("private", "a", "b.json"))).toBe(0o600);
    expect(mode(h.path("private", "a"))).toBe(0o700);
    expect(mode(h.path("private"))).toBe(0o700);
  });

  it("reads nothing where nothing is, and names the path itself as where a new file goes", async () => {
    const h = home();
    expect(await readMaybe(h.path("nope.json"))).toBeUndefined();
    expect(await realOrSelf(h.path("nope", "new.json"))).toBe(h.path("nope", "new.json"));
    expect(await entryKind(h.path("nope"))).toBe("missing");
  });

  it("makes the folders a path needs and says which, outermost first", async () => {
    const h = home();
    expect(await ensureDir(h.path("a", "b", "c"))).toEqual([h.path("a"), h.path("a", "b"), h.path("a", "b", "c")]);
    expect(await ensureDir(h.path("a", "b"))).toEqual([]);
    expect(await entryKind(h.path("a", "b", "c"))).toBe("dir");
  });
});

describe("links", () => {
  // h.link makes a junction on Windows and a directory symlink elsewhere, so this runs on windows-latest too.
  it("removes a linked skill folder's link only, and puts it back where it led", async () => {
    const h = home();
    h.skill("shared", "notes");
    h.link("shared/notes", ".claude/skills/notes");
    const link = h.path(".claude", "skills", "notes");
    expect(await entryKind(link)).toBe("link");
    const info = await readLinkInfo(link);
    expect(samePath(info.target, h.path("shared", "notes"))).toBe(true);
    expect(info.type).toBe(process.platform === "win32" ? "junction" : "dir");

    await removeLink(link);
    expect(await entryKind(link)).toBe("missing");
    expect(existsSync(h.path("shared", "notes", "SKILL.md"))).toBe(true);

    await makeLink(info.target, link, info.type);
    expect(realpathSync(link)).toBe(realpathSync(h.path("shared", "notes")));
    expect(existsSync(h.path("shared", "notes", "SKILL.md"))).toBe(true);
  });
});

describe("moveTo", () => {
  it("copies and removes a folder that cannot be renamed across file systems", async () => {
    const h = home();
    h.skill("skills", "old-one", "old", "a body");
    h.write("skills/old-one/assets/data.txt", "data");
    const from = h.path("skills", "old-one");
    const before = await hashTree(from);
    mkdirSync(h.path("backup"));
    const to = h.path("backup", "1");

    fsHooks.exdev = 1;
    await moveTo(from, to);

    expect(fsHooks.exdev).toBe(0);
    expect(existsSync(from)).toBe(false);
    expect(await hashTree(to)).toBe(before);
  });

  it.skipIf(onWindows)("keeps a link inside the folder a link, without following it", async () => {
    const h = home();
    h.skill("skills", "old-one");
    h.write("elsewhere/kept.txt", "kept");
    h.link("elsewhere", "skills/old-one/linked");
    mkdirSync(h.path("backup"));

    fsHooks.exdev = 1;
    await moveTo(h.path("skills", "old-one"), h.path("backup", "1"));

    expect(lstatSync(h.path("backup", "1", "linked")).isSymbolicLink()).toBe(true);
    expect(readFileSync(h.path("elsewhere", "kept.txt"), "utf8")).toBe("kept");
  });
});

describe("removeTree", () => {
  it("removes only a real folder inside the root it is given", async () => {
    const h = home();
    h.write("root/op/manifest.json", "{}");
    h.write("outside/keep.txt", "keep");
    h.link("outside", "root/linked");

    await expect(removeTree(h.path("outside"), h.path("root"))).rejects.toThrow();
    await expect(removeTree(h.path("root", "linked"), h.path("root"))).rejects.toThrow();
    await expect(removeTree(h.path("root"), h.path("root"))).rejects.toThrow();
    expect(readFileSync(h.path("outside", "keep.txt"), "utf8")).toBe("keep");

    await removeTree(h.path("root", "op"), h.path("root"));
    expect(existsSync(h.path("root", "op"))).toBe(false);
    expect(existsSync(h.path("root", "linked"))).toBe(true);
  });
});
