import { describe, expect, it, vi } from "vitest";

import { runCommand, runUpdateCommand, type UpdateCommandDeps } from "./commands.js";
import { stripAnsi } from "./lib/cli-style.js";

const TARGET = "/home/u/.local/share/clausona/index.js";

/** A clausona at 0.3.0-beta, installed by the installer, with 0.3.1-beta out and a terminal to ask on. */
function setup(overrides: Partial<UpdateCommandDeps> = {}) {
  const install = vi.fn(async (_tag: string, _target: string) => {});
  const confirm = vi.fn(async (_question: string) => true);
  const checkLatest = vi.fn(async (): Promise<string | null> => "v0.3.1-beta");
  const deps: UpdateCommandDeps = {
    current: "0.3.0-beta",
    target: TARGET,
    platform: "linux",
    interactive: true,
    checkLatest,
    confirm,
    install,
    ...overrides,
  };
  return { deps, install, confirm, checkLatest };
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the command to be rejected");
}

describe("clausona update", () => {
  it("says so when already up to date", async () => {
    const { deps, install, confirm } = setup({ checkLatest: async () => "v0.3.0-beta" });

    expect(stripAnsi(await runUpdateCommand([], deps))).toContain("Already up to date (v0.3.0-beta)");
    expect(confirm).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("asks first, and a yes installs the offered tag", async () => {
    const { deps, install, confirm } = setup();

    const out = stripAnsi(await runUpdateCommand([], deps));

    expect(stripAnsi(confirm.mock.calls[0]?.[0] ?? "")).toContain("Update v0.3.0-beta → v0.3.1-beta? (Y/n)");
    expect(install).toHaveBeenCalledWith("v0.3.1-beta", TARGET);
    expect(out).toContain("Updated v0.3.0-beta → v0.3.1-beta");
    expect(out).toContain("Open a new shell");
  });

  it("leaves everything alone on a no", async () => {
    const { deps, install } = setup({ confirm: async () => false });

    expect(stripAnsi(await runUpdateCommand([], deps))).toContain("Cancelled.");
    expect(install).not.toHaveBeenCalled();
  });

  it.each(["--yes", "-y"])("skips the question with %s", async (flag) => {
    const { deps, install, confirm } = setup({ interactive: false });

    await runUpdateCommand([flag], deps);

    expect(confirm).not.toHaveBeenCalled();
    expect(install).toHaveBeenCalledWith("v0.3.1-beta", TARGET);
  });

  it("will not take a script's input as the answer", async () => {
    const { deps, install, confirm } = setup({ interactive: false });

    expect(await failure(runUpdateCommand([], deps))).toContain(
      "Run 'clausona update --yes' to update non-interactively.",
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("says when GitHub cannot be reached", async () => {
    const { deps } = setup({ checkLatest: async () => null });
    expect(await failure(runUpdateCommand([], deps))).toBe("Could not reach GitHub to check for updates.");
  });

  it.each([
    ["linux", "curl -fsSL https://github.com/larcane97/clausona/releases/latest/download/install.sh | bash"],
    ["win32", "irm https://github.com/larcane97/clausona/releases/latest/download/install.ps1 | iex"],
  ] as const)("points a copy the installer did not make at the installer on %s", async (platform, command) => {
    const { deps, checkLatest, install } = setup({ target: null, platform });

    const message = await failure(runUpdateCommand([], deps));

    expect(message).toContain("not installed by the installer");
    expect(message).toContain(command);
    expect(checkLatest).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("passes an install failure through as the command's error", async () => {
    const { deps } = setup({
      install: async () => {
        throw new Error("The download of v0.3.1-beta does not match its published checksum.");
      },
    });
    expect(await failure(runUpdateCommand(["--yes"], deps))).toBe(
      "The download of v0.3.1-beta does not match its published checksum.",
    );
  });

  it("is listed, has help, and refuses an unknown option", async () => {
    expect(stripAnsi(await runCommand("help", []))).toContain("update");
    expect(stripAnsi(await runCommand("update", ["--help"]))).toContain("clausona update [--yes]");
    expect(await failure(runCommand("update", ["--bogus"]))).toContain("Unknown option: --bogus");
  });
});
