import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Where spawn would find `name`: the first executable file of that name in a PATH entry, the
 * lookup execvp does. Only resolved, never run - unguarded, this is the real binary.
 */
function resolveOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

// vitest.global-setup.ts puts the stand-ins first on PATH for the whole run, so no test can
// reach the user's real Keychain or Secret Service. Windows uses neither binary.
describe.skipIf(process.platform === "win32")("the credential stores every test sees", () => {
  const shimDir = process.env.CLAUSONA_TEST_SHIM_DIR ?? "<no stand-in directory>";

  it.each(["security", "secret-tool"])("resolves %s to the suite's stand-in", (name) => {
    expect(resolveOnPath(name)).toBe(path.join(shimDir, name));
  });

  it("answers as the real binaries do for an item that is not there", () => {
    const security = spawnSync(path.join(shimDir, "security"), ["find-generic-password", "-s", "clausona-isolation"], {
      encoding: "utf8",
    });
    expect(security.status).toBe(44);
    expect(security.stderr).toContain("could not be found");

    const secretTool = spawnSync(path.join(shimDir, "secret-tool"), ["lookup", "clausona", "isolation"], {
      encoding: "utf8",
    });
    expect(secretTool.status).toBe(1);
    expect(secretTool.stdout).toBe("");
  });
});
