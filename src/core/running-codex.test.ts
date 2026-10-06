import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { codexHomesInPsLine, normalizeHome } from "./running-codex.js";

describe("codexHomesInPsLine", () => {
  it("reads CODEX_HOME out of the environment ps -E prints after the command", () => {
    expect(codexHomesInPsLine("/opt/codex/codex resume CODEX_HOME=/Users/me/.codex-work/ PATH=/usr/bin")).toEqual([
      "/Users/me/.codex-work/",
    ]);
    expect(codexHomesInPsLine("codex TERM=xterm CODEX_HOME=~/.codex-work")).toEqual(["~/.codex-work"]);
  });

  it("keeps a value with a space in it whole, up to the next variable", () => {
    expect(codexHomesInPsLine("codex CODEX_HOME=/Users/me/My Codex HOME=/Users/me")).toEqual(["/Users/me/My Codex"]);
  });

  it("finds none where there is none", () => {
    expect(codexHomesInPsLine("codex SUPERSET_CODEX_HOME=/x PATH=/usr/bin")).toEqual([]);
  });
});

describe("normalizeHome", () => {
  it("spells a home one way: ~ expanded, a trailing separator and relative parts resolved", async () => {
    const nowhere = path.join(path.parse(process.cwd()).root, "nowhere-clausona", "codex-work");
    expect(await normalizeHome(`${nowhere}${path.sep}`)).toBe(nowhere);
    expect(await normalizeHome(path.join(nowhere, "..", "codex-work"))).toBe(nowhere);
    expect(await normalizeHome("~/nowhere-clausona-codex")).toBe(path.join(homedir(), "nowhere-clausona-codex"));
  });
});
