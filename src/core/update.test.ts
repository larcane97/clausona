import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkLatestTag,
  compareVersions,
  type FetchLike,
  findUpdate,
  installTarget,
  isNewer,
  performUpdate,
  reinstallCommand,
  replaceFile,
  tagFromLocation,
} from "./update.js";

describe("compareVersions", () => {
  it.each([
    ["0.2.5-beta", "0.3.0-beta", -1],
    ["0.3.0-beta", "0.3.0", -1],
    ["0.3.0", "0.3.0-beta", 1],
    ["0.3.0-beta.1", "0.3.0-beta.2", -1],
    ["0.3.0-beta.2", "0.3.0-beta.10", -1],
    ["0.3.0-beta", "0.3.0-beta.1", -1],
    ["0.3.0-1", "0.3.0-beta", -1],
    ["v0.3.1-beta", "0.3.1-beta", 0],
    ["0.10.0", "0.9.0", 1],
    ["1.0.0", "0.99.99", 1],
  ])("%s against %s is %i", (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });

  it.each(["", "latest", "nightly", "0.3", "0.3.0.1", "v", "0.3.0-"])("does not read %j as a version", (bad) => {
    expect(compareVersions(bad, "0.3.0")).toBeNull();
    expect(isNewer(bad, "0.3.0")).toBe(false);
  });
});

describe("tagFromLocation", () => {
  it.each([
    ["https://github.com/larcane97/clausona/releases/tag/v0.3.1-beta", "v0.3.1-beta"],
    ["/larcane97/clausona/releases/tag/v0.3.1-beta", "v0.3.1-beta"],
    ["https://github.com/larcane97/clausona/releases/tag/v0.3.1-beta/", "v0.3.1-beta"],
    ["https://github.com/larcane97/clausona/releases/tag/v0.3.1%2Bbuild.1", "v0.3.1+build.1"],
  ])("reads %s", (location, tag) => {
    expect(tagFromLocation(location)).toBe(tag);
  });

  it.each([
    null,
    "",
    "https://github.com/larcane97/clausona/releases",
    "https://github.com/login?return_to=%2Flarcane97",
    "https://github.com/larcane97/clausona/releases/tag/%E0%A4%A",
  ])("finds no tag in %j", (location) => {
    expect(tagFromLocation(location)).toBeNull();
  });
});

/** A request that never answers, and fails the way fetch does once its signal aborts. */
const hanging: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason));
  });

describe("checkLatestTag", () => {
  it("reads the tag the latest-release redirect points at", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push([url, init]);
      return new Response(null, {
        status: 302,
        headers: { location: "https://github.com/larcane97/clausona/releases/tag/v0.3.1-beta" },
      });
    };

    expect(await checkLatestTag({ fetch })).toBe("v0.3.1-beta");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("https://github.com/larcane97/clausona/releases/latest");
    expect(calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("is null for an answer that is not a redirect", async () => {
    expect(await checkLatestTag({ fetch: async () => new Response("ok", { status: 200 }) })).toBeNull();
  });

  it("is null for a redirect without a location", async () => {
    expect(await checkLatestTag({ fetch: async () => new Response(null, { status: 302 }) })).toBeNull();
  });

  it("is null when the request fails", async () => {
    const fetch: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await checkLatestTag({ fetch })).toBeNull();
  });

  it("is null when GitHub does not answer in time", async () => {
    const started = Date.now();

    expect(await checkLatestTag({ fetch: hanging, timeoutMs: 20 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("still gives up in time when the caller has not", async () => {
    const started = Date.now();

    expect(await checkLatestTag({ fetch: hanging, timeoutMs: 20, signal: new AbortController().signal })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  // csn quitting while the check waits: the check must not hold the shell prompt for its 3 s.
  it.each([
    ["before it asks", (controller: AbortController) => controller.abort()],
    ["while it waits", (controller: AbortController) => setTimeout(() => controller.abort(), 20)],
  ])("is null at once when the caller gives up %s", async (_when, giveUp) => {
    const controller = new AbortController();
    giveUp(controller);
    const started = Date.now();

    expect(await checkLatestTag({ fetch: hanging, signal: controller.signal })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("findUpdate", () => {
  it("offers a later release", async () => {
    const offer = await findUpdate({
      current: "0.3.0-beta",
      target: "/home/u/.local/share/clausona/index.js",
      check: async () => "v0.3.1-beta",
    });

    expect(offer).toEqual({
      current: "0.3.0-beta",
      latest: "0.3.1-beta",
      tag: "v0.3.1-beta",
      target: "/home/u/.local/share/clausona/index.js",
    });
  });

  it.each([
    ["the same release", "0.3.0-beta", "v0.3.0-beta"],
    ["an older release", "0.3.0-beta", "v0.2.5-beta"],
    ["a tag that is not a version", "0.3.0-beta", "nightly"],
    ["a local build ahead of the release", "0.4.0-dev", "v0.3.1-beta"],
    ["no answer", "0.3.0-beta", null],
  ])("offers nothing for %s", async (_case, current, tag) => {
    expect(await findUpdate({ current, target: "/x/index.js", check: async () => tag })).toBeNull();
  });

  it("hands the caller's signal to the check", async () => {
    const { signal } = new AbortController();
    const check = vi.fn(async (_signal?: AbortSignal) => null);

    await findUpdate({ current: "0.3.0-beta", target: "/x/index.js", check, signal });
    expect(check).toHaveBeenCalledWith(signal);
  });
});

describe("reinstallCommand", () => {
  it("is the README's installer line for the platform", () => {
    expect(reinstallCommand("darwin")).toBe(
      "curl -fsSL https://github.com/larcane97/clausona/releases/latest/download/install.sh | bash",
    );
    expect(reinstallCommand("linux")).toBe(reinstallCommand("darwin"));
    expect(reinstallCommand("win32")).toBe(
      "irm https://github.com/larcane97/clausona/releases/latest/download/install.ps1 | iex",
    );
  });
});

describe("installTarget", () => {
  const platform = process.platform;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "clausona-target-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** The variable the installer reads, pointed at `dir`. */
  function dataEnv(dir: string): NodeJS.ProcessEnv {
    return platform === "win32" ? { LOCALAPPDATA: dir } : { XDG_DATA_HOME: dir };
  }

  /** An install laid out as the installer lays it out, under `root`. */
  function install(): string {
    const file = path.join(root, "clausona", "index.js");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "// bundle\n");
    return file;
  }

  it("is the installed file when that is what runs", () => {
    const file = install();
    expect(installTarget({ entryPath: file, platform, env: dataEnv(root), homeDir: root })).toBe(file);
  });

  it("is null for a bundle run from anywhere else", () => {
    install();
    const elsewhere = path.join(root, "checkout", "dist", "index.js");
    mkdirSync(path.dirname(elsewhere), { recursive: true });
    writeFileSync(elsewhere, "// build\n");

    expect(installTarget({ entryPath: elsewhere, platform, env: dataEnv(root), homeDir: root })).toBeNull();
  });

  it("is null when nothing is installed", () => {
    const entryPath = path.join(root, "clausona", "index.js");
    expect(installTarget({ entryPath, platform, env: dataEnv(root), homeDir: root })).toBeNull();
  });

  it("is null without an entry path", () => {
    install();
    expect(installTarget({ entryPath: undefined, platform, env: dataEnv(root), homeDir: root })).toBeNull();
  });

  it.skipIf(process.platform === "win32")("is null when the installed index.js is a symlink", () => {
    const build = path.join(root, "checkout", "index.js");
    mkdirSync(path.dirname(build), { recursive: true });
    writeFileSync(build, "// build\n");
    const link = path.join(root, "clausona", "index.js");
    mkdirSync(path.dirname(link));
    symlinkSync(build, link);

    expect(installTarget({ entryPath: link, platform, env: dataEnv(root), homeDir: root })).toBeNull();
  });

  it.skipIf(process.platform === "win32")("matches through a symlinked data directory", () => {
    const realData = path.join(root, "real-data");
    const file = path.join(realData, "clausona", "index.js");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "// bundle\n");
    const linkedData = path.join(root, "linked-data");
    symlinkSync(realData, linkedData);

    expect(installTarget({ entryPath: file, platform, env: dataEnv(linkedData), homeDir: root })).toBe(
      path.join(linkedData, "clausona", "index.js"),
    );
  });
});

describe("replaceFile", () => {
  const refusal = (code: string) => Object.assign(new Error(`${code}: rename refused`), { code });

  it("retries while Windows refuses the rename, then succeeds", async () => {
    const rename = vi
      .fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValueOnce(refusal("EPERM"))
      .mockRejectedValueOnce(refusal("EBUSY"))
      .mockResolvedValueOnce(undefined);

    await replaceFile("a", "b", { platform: "win32", delaysMs: [0, 0, 0], rename });
    expect(rename).toHaveBeenCalledTimes(3);
  });

  it("gives up after the last retry", async () => {
    const rename = vi.fn<(from: string, to: string) => Promise<void>>().mockRejectedValue(refusal("EPERM"));

    await expect(replaceFile("a", "b", { platform: "win32", delaysMs: [0, 0, 0], rename })).rejects.toThrow("EPERM");
    expect(rename).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["EPERM on POSIX", "linux", "EPERM"],
    ["EACCES on Windows", "win32", "EACCES"],
  ] as const)("does not retry %s", async (_case, platform, code) => {
    const rename = vi.fn<(from: string, to: string) => Promise<void>>().mockRejectedValue(refusal(code));

    await expect(replaceFile("a", "b", { platform, delaysMs: [0, 0, 0], rename })).rejects.toThrow(code);
    expect(rename).toHaveBeenCalledTimes(1);
  });
});

describe("performUpdate", () => {
  const OLD = "// the installed bundle\n";
  const TAG = "v0.3.1-beta";
  let dir: string;
  let target: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "clausona-update-"));
    target = path.join(dir, "index.js");
    writeFileSync(target, OLD);
  });

  afterEach(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });

  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

  /**
   * A release bundle that answers `--version` the way clausona does, colours included - a user's
   * FORCE_COLOR reaches the child, and `\bv` does not match right after an escape code's `m`.
   */
  const bundleReporting = (version: string) =>
    `console.log("  \\x1b[38;2;129;140;248mclausona\\x1b[39m \\x1b[38;2;113;113;122mv${version}\\x1b[39m");\n`;

  /** A GitHub release serving `files` by name; a number is a status with an empty body. */
  function release(files: Record<string, string | number>) {
    const urls: string[] = [];
    const fetch: FetchLike = async (url) => {
      urls.push(url);
      const body = files[url.slice(url.lastIndexOf("/") + 1)];
      if (body === undefined) return new Response("Not Found", { status: 404 });
      if (typeof body === "number") return new Response("", { status: body });
      return new Response(body, { status: 200 });
    };
    return { fetch, urls };
  }

  function leftovers(): string[] {
    return readdirSync(dir).filter((name) => name !== "index.js");
  }

  async function expectUntouched(update: Promise<void>, message: RegExp) {
    await expect(update).rejects.toThrow(message);
    expect(readFileSync(target, "utf8")).toBe(OLD);
    expect(leftovers()).toEqual([]);
  }

  it("replaces the installed bundle with the release's", async () => {
    const bundle = bundleReporting("0.3.1-beta");
    const { fetch, urls } = release({
      "clausona.js": bundle,
      "clausona.js.sha256": `${sha256(bundle)}  clausona.js\n`,
    });

    await performUpdate({ tag: TAG, target, fetch });

    expect(readFileSync(target, "utf8")).toBe(bundle);
    expect(leftovers()).toEqual([]);
    expect(urls).toEqual([
      "https://github.com/larcane97/clausona/releases/download/v0.3.1-beta/clausona.js",
      "https://github.com/larcane97/clausona/releases/download/v0.3.1-beta/clausona.js.sha256",
    ]);
  });

  it("accepts a checksum in upper case with CRLF and a binary marker", async () => {
    const bundle = bundleReporting("0.3.1-beta");
    const { fetch } = release({
      "clausona.js": bundle,
      "clausona.js.sha256": `${sha256(bundle).toUpperCase()} *clausona.js\r\n`,
    });

    await performUpdate({ tag: TAG, target, fetch });
    expect(readFileSync(target, "utf8")).toBe(bundle);
  });

  it("refuses a download that does not match its checksum", async () => {
    const { fetch } = release({
      "clausona.js": bundleReporting("0.3.1-beta"),
      "clausona.js.sha256": `${sha256("something else")}  clausona.js\n`,
    });
    await expectUntouched(performUpdate({ tag: TAG, target, fetch }), /does not match its published checksum/);
  });

  it("refuses a release without a checksum", async () => {
    const { fetch } = release({ "clausona.js": bundleReporting("0.3.1-beta") });
    await expectUntouched(
      performUpdate({ tag: TAG, target, fetch }),
      /Could not download the checksum for v0\.3\.1-beta: HTTP 404/,
    );
  });

  it("refuses a checksum file with no digest in it", async () => {
    const { fetch } = release({
      "clausona.js": bundleReporting("0.3.1-beta"),
      "clausona.js.sha256": "not a checksum\n",
    });
    await expectUntouched(performUpdate({ tag: TAG, target, fetch }), /is not a SHA-256 digest/);
  });

  it("fails when the bundle cannot be downloaded", async () => {
    const { fetch } = release({ "clausona.js": 500 });
    await expectUntouched(
      performUpdate({ tag: TAG, target, fetch }),
      /Could not download clausona v0\.3\.1-beta: HTTP 500/,
    );
  });

  it("refuses a bundle that reports another version", async () => {
    const bundle = bundleReporting("0.3.0-beta");
    const { fetch } = release({ "clausona.js": bundle, "clausona.js.sha256": `${sha256(bundle)}  clausona.js\n` });
    await expectUntouched(performUpdate({ tag: TAG, target, fetch }), /reports v0\.3\.0-beta, not v0\.3\.1-beta/);
  });

  it("refuses a bundle that does not run", async () => {
    const bundle = "process.exit(3);\n";
    const { fetch } = release({ "clausona.js": bundle, "clausona.js.sha256": `${sha256(bundle)}  clausona.js\n` });
    await expectUntouched(performUpdate({ tag: TAG, target, fetch }), /exited with 3/);
  });

  // Ctrl+C on the dashboard while it installs: the download stops then, not at its 30 s timeout.
  it("stops a download at once when the caller gives up", async () => {
    const controller = new AbortController();
    const urls: string[] = [];
    const fetch: FetchLike = (url, init) => {
      urls.push(url);
      return hanging(url, init);
    };

    const update = performUpdate({ tag: TAG, target, fetch, signal: controller.signal });
    expect(urls).toHaveLength(1);
    controller.abort();

    await expectUntouched(update, /Could not download clausona v0\.3\.1-beta/);
  });

  it("swaps nothing in when the caller gives up after the downloads", async () => {
    const bundle = bundleReporting("0.3.1-beta");
    const controller = new AbortController();
    const served = release({ "clausona.js": bundle, "clausona.js.sha256": `${sha256(bundle)}  clausona.js\n` });
    // The checksum is the last download, and it arrives whole: only the write and the swap are left to stop.
    const fetch: FetchLike = async (url, init) => {
      const response = await served.fetch(url, init);
      if (url.endsWith(".sha256")) controller.abort();
      return response;
    };

    const error = await performUpdate({ tag: TAG, target, fetch, signal: controller.signal }).catch((e) => e);

    expect(served.urls).toHaveLength(2);
    // The abort itself, not a "Could not replace" that would blame the file.
    expect(error).toBe(controller.signal.reason);
    expect(readFileSync(target, "utf8")).toBe(OLD);
    expect(leftovers()).toEqual([]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fails without touching anything when the directory cannot be written",
    async () => {
      const bundle = bundleReporting("0.3.1-beta");
      const { fetch } = release({ "clausona.js": bundle, "clausona.js.sha256": `${sha256(bundle)}  clausona.js\n` });
      chmodSync(dir, 0o555);

      await expect(performUpdate({ tag: TAG, target, fetch })).rejects.toThrow(
        /Could not replace .*index\.js: .*EACCES/,
      );
      chmodSync(dir, 0o755);
      expect(readFileSync(target, "utf8")).toBe(OLD);
      expect(leftovers()).toEqual([]);
    },
  );
});
