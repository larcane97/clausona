import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderDoctor } from "./lib/format.js";

/**
 * doctor with a profiles.json it cannot use. loadRegistry reads such a file exactly as it
 * reads no file, so doctor used to print an empty report - nothing wrong - for a registry
 * that had broken.
 *
 * HOME is the seam, as in src/commands.shell-env.test.ts. No profile is ever registered
 * here, so nothing can reach a tool, a credential store or a key command.
 */

const temps: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** What a key command looks like in profiles.json, which doctor must never quote. */
const KEY_COMMAND = "op read op://vault/gw/key";

/**
 * `write` puts something at profiles.json's path, or leaves it out: the "clausona was never
 * initialised" case.
 */
async function doctorWith(write?: (registryPath: string) => void) {
  const home = mkdtempSync(path.join(tmpdir(), "clausona-doctor-"));
  temps.push(home);
  mkdirSync(path.join(home, ".clausona"));
  write?.(path.join(home, ".clausona", "profiles.json"));

  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.resetModules();
  const { runCommand } = await import("./commands.js");
  return (...args: string[]) => runCommand("doctor", args);
}

/** The message a rejected command produced. */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the command to be rejected");
}

const SHOWN_PATH = path.join("~", ".clausona", "profiles.json");

describe("doctor with a profiles.json it cannot read", () => {
  // JSON.parse's own message for the first would quote the start of the file.
  it.each([
    ["is not valid JSON", "it is not valid JSON", (p: string) => writeFileSync(p, `${KEY_COMMAND}\n{"version": 2,`)],
    ["holds null", "it is not a JSON object", (p: string) => writeFileSync(p, "null")],
    ["holds a list", "it is not a JSON object", (p: string) => writeFileSync(p, '["claude:work"]')],
    ["is a directory", "it could not be opened (EISDIR)", (p: string) => mkdirSync(p)],
  ])("says so in one line when it %s", async (_, reason, write) => {
    const doctor = await doctorWith(write);

    const message = await failure(doctor());

    expect(message).toContain(`${SHOWN_PATH} could not be read: ${reason}`);
    expect(message).toContain("'clausona init'");
    expect(message).not.toContain("\n");
    expect(message).not.toContain("op read");
  });

  it("says the same with --json rather than printing an empty list", async () => {
    const doctor = await doctorWith((p) => writeFileSync(p, `${KEY_COMMAND}\n{"version": 2,`));

    const message = await failure(doctor("--json"));

    expect(message).toContain(`${SHOWN_PATH} could not be read: it is not valid JSON`);
    expect(message).not.toContain("op read");
  });
});

describe("doctor with no profiles.json at all", () => {
  it("prints the empty report it always has", async () => {
    const doctor = await doctorWith();

    expect(await doctor()).toBe(renderDoctor([]));
    expect(await doctor("--json")).toBe("[]");
  });
});
