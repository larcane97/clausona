import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SPAWN_TIMEOUT_MS, SPAWNING_TEST_TIMEOUT_MS } from "../src/test-timeouts.js";

// Every case runs node on the script, which runs the bundle it is given.
vi.setConfig({ testTimeout: SPAWNING_TEST_TIMEOUT_MS });

// scripts/npm-package.mjs writes what release.yml publishes to npm as `clausona`. npm installs
// whatever that package.json says, on every machine that installs it: these hold it to the bundle
// alone, with nothing to install and nothing run at install time.

const { version, description } = JSON.parse(readFileSync("package.json", "utf8")) as {
  version: string;
  description: string;
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clausona-npm-package-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for the bundle: a node script that answers --version as clausona does. */
function bundle(reports: string): string {
  const file = path.join(dir, "clausona.js");
  writeFileSync(file, `#!/usr/bin/env node\nconsole.log("  clausona ${reports}");\n`);
  return file;
}

function pack(bundlePath: string, out = path.join(dir, "npm")) {
  const run = spawnSync(process.execPath, ["scripts/npm-package.mjs", "--bundle", bundlePath, "--out", out], {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
  return { status: run.status, stderr: run.stderr, out };
}

describe("the npm package", () => {
  it("is the bundle, README and LICENSE, with a package.json that installs nothing else", () => {
    const source = bundle(`v${version}`);
    const { status, stderr, out } = pack(source);

    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(readdirSync(out).sort()).toEqual(["LICENSE", "README.md", "clausona.js", "package.json"]);
    expect(readFileSync(path.join(out, "clausona.js"))).toEqual(readFileSync(source));
    expect(readFileSync(path.join(out, "LICENSE"), "utf8")).toBe(readFileSync("LICENSE", "utf8"));

    const manifest = JSON.parse(readFileSync(path.join(out, "package.json"), "utf8"));
    expect(manifest).toMatchObject({
      name: "clausona",
      version,
      description,
      license: "MIT",
      // npm's trusted publishing compares this with the repository the workflow runs in.
      repository: { type: "git", url: "git+https://github.com/larcane97/clausona.git" },
      // The bundle is an ES module; without it Node warns on every start, or refuses to run it.
      type: "module",
      bin: { clausona: "clausona.js" },
      files: ["clausona.js"],
      engines: { node: ">=20" },
    });
    expect(manifest).not.toHaveProperty("dependencies");
    expect(manifest).not.toHaveProperty("scripts");
    expect(manifest).not.toHaveProperty("private");
  });

  // npmjs.com shows the README without the repository's files beside it.
  it("links the README's docs and images absolutely, at the release's tag", () => {
    const { status, out } = pack(bundle(`v${version}`));
    expect(status).toBe(0);
    const readme = readFileSync(path.join(out, "README.md"), "utf8");

    const targets = [...readme.matchAll(/\]\(([^)\s]+)\)/g), ...readme.matchAll(/\b(?:src|href)="([^"]+)"/g)].map(
      (match) => match[1] ?? "",
    );
    const relative = targets.filter((target) => !/^(?:https?:|mailto:|#)/.test(target));
    expect(relative).toEqual([]);
    expect(readme).toContain(`https://raw.githubusercontent.com/larcane97/clausona/v${version}/assets/demo.gif`);
    expect(readme).toContain(`https://github.com/larcane97/clausona/blob/v${version}/docs/routing.md`);
  });

  it("refuses a bundle that reports another version, and writes nothing", () => {
    const { status, stderr, out } = pack(bundle("v0.0.1-beta"));

    expect(status).toBe(1);
    expect(stderr).toContain(`reports v0.0.1-beta, but package.json is ${version}`);
    expect(() => readdirSync(out)).toThrow();
  });

  it("will not empty an --out that holds files it did not write", () => {
    const out = path.join(dir, "elsewhere");
    mkdirSync(out);
    writeFileSync(path.join(out, "notes.txt"), "keep me\n");

    const { status, stderr } = pack(bundle(`v${version}`), out);

    expect(status).toBe(1);
    expect(stderr).toContain("notes.txt");
    expect(readFileSync(path.join(out, "notes.txt"), "utf8")).toBe("keep me\n");
  });

  it("will not write over the bundle it was given", () => {
    const source = bundle(`v${version}`);

    const { status, stderr } = pack(source, dir);

    expect(status).toBe(1);
    expect(stderr).toContain("holds the bundle itself");
    expect(readFileSync(source, "utf8")).toContain(`clausona v${version}`);
  });
});
