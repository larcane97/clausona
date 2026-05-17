import { describe, expect, it } from "vitest";
import { renderShellInit } from "./shell.js";

describe("renderShellInit", () => {
  const out = renderShellInit();

  it("defines _clausona_resolve helper that takes a tool argument", () => {
    expect(out).toMatch(/_clausona_resolve\(\)\s*\{/);
    expect(out).toMatch(/local tool=\$1/);
  });

  it("defines a claude() wrapper that sets CLAUDE_CONFIG_DIR", () => {
    expect(out).toMatch(/^claude\(\)\s*\{/m);
    expect(out).toMatch(/CLAUDE_CONFIG_DIR/);
    expect(out).toMatch(/_clausona_resolve claude/);
    expect(out).toMatch(/clausona _track-usage/);
  });

  it("defines a codex() wrapper that sets CODEX_HOME", () => {
    expect(out).toMatch(/^codex\(\)\s*\{/m);
    expect(out).toMatch(/CODEX_HOME/);
    expect(out).toMatch(/_clausona_resolve codex/);
  });

  it("does NOT include _track-usage in codex wrapper (claude only in v1)", () => {
    const codexBlock = out.split(/^codex\(\)\s*\{/m)[1] ?? "";
    expect(codexBlock).not.toMatch(/_track-usage/);
  });

  it("retains csn alias", () => {
    expect(out).toMatch(/alias csn=clausona/);
  });

  it("does not use ! operator in inline node script (zsh history-expansion safe)", () => {
    // The inline node script in _clausona_resolve must not use `!` operators
    // because zsh history-expands them inside double-quoted strings at function
    // definition time, corrupting the script.
    // Extract the node -e "..." script directly from the full output.
    // The script starts after `node -e "` and ends before `" 2>/dev/null`.
    const nodeMatch = out.match(/node -e "([\s\S]*?)" 2>\/dev\/null/);
    expect(nodeMatch).not.toBeNull();
    expect(nodeMatch?.[1]).not.toMatch(/!/);
  });
});
