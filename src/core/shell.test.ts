import { describe, expect, it } from "vitest";
import {
  isPosixEnvName,
  renderPosixExports,
  renderPosixShellInit,
  renderPowerShellInit,
  renderShellInit,
} from "./shell.js";

describe("renderShellInit", () => {
  const out = renderPosixShellInit();

  it("no longer defines the inline node resolver", () => {
    expect(out).not.toMatch(/_clausona_resolve/);
    expect(out).not.toMatch(/node -e/);
  });

  it("evaluates _shell-env inside a subshell so exports do not leak", () => {
    const claudeBlock = out.split(/^claude\(\)\s*\{/m)[1]?.split(/^\}/m)[0] ?? "";
    expect(claudeBlock).toMatch(/\(\s*\n\s*eval "\$\(clausona _shell-env claude\)"/);
    expect(claudeBlock).not.toMatch(/unset CLAUDE_CONFIG_DIR/);
  });

  it("steps aside when the user set CLAUDE_CONFIG_DIR themselves", () => {
    expect(out).toMatch(/if \[\[ -n "\$\{CLAUDE_CONFIG_DIR:-\}" \]\]/);
  });

  it("runs _sync-plugins inside the subshell, where CLAUDE_CONFIG_DIR is set", () => {
    const claudeBlock = out.split(/^claude\(\)\s*\{/m)[1]?.split(/^\}/m)[0] ?? "";
    // From the subshell's opening paren to the `)` that closes it on its own line.
    const subshell =
      claudeBlock
        .split("(")
        .slice(1)
        .join("(")
        .split(/^\s*\)/m)[0] ?? "";
    expect(subshell).toMatch(/clausona _sync-plugins/);
    // _track-usage belongs after the subshell, so it still runs once the variables are gone.
    expect(subshell).not.toMatch(/clausona _track-usage/);
  });

  it("keeps _track-usage outside the subshell and claude-only", () => {
    expect(out).toMatch(/clausona _track-usage/);
    const codexBlock = out.split(/^codex\(\)\s*\{/m)[1] ?? "";
    expect(codexBlock).not.toMatch(/_track-usage/);
  });

  it("defines a codex wrapper on the same mechanism", () => {
    const codexBlock = out.split(/^codex\(\)\s*\{/m)[1] ?? "";
    expect(codexBlock).toMatch(/clausona _shell-env codex/);
  });

  it("retains csn alias", () => {
    expect(out).toMatch(/alias csn=clausona/);
  });

  /**
   * This scan is the only effective guard against the history-expansion class of bug: the
   * interactive-zsh smoke test cannot catch it, because zsh does not history-expand a `-c`
   * script whether or not `-i` is passed.
   *
   * It pairs double quotes left-to-right within a line, which is exact only while the script
   * holds no `"` outside a double-quoted region and no such region spanning a newline. Both
   * assumptions are asserted rather than assumed: an odd total means some `"` is a literal
   * inside single quotes and the pairing has slipped, and a fragment count below half the
   * total means a region was skipped - each fails loudly instead of silently narrowing what
   * the `!` check below looks at.
   */
  it("does not use ! inside double-quoted strings (zsh history expansion)", () => {
    const quotes = (out.match(/"/g) ?? []).length;
    expect(quotes % 2, `odd number of double quotes (${quotes}): the pairing below is unreliable`).toBe(0);

    const doubleQuoted = out.match(/"[^"\n]*"/g) ?? [];
    expect(doubleQuoted.length, "a double-quoted region spans a newline and is not scanned").toBe(quotes / 2);

    for (const fragment of doubleQuoted) expect(fragment).not.toMatch(/!/);
  });

  it("selects PowerShell integration on Windows", () => {
    expect(renderShellInit("win32")).toBe(renderPowerShellInit());
    expect(renderShellInit("darwin")).toBe(renderPosixShellInit());
  });
});

describe("renderPowerShellInit", () => {
  const out = renderPowerShellInit();

  it("consumes the JSON form and restores every variable it set", () => {
    // One helper serves both tools, so the tool name is the $Tool parameter.
    expect(out).toMatch(/& clausona _shell-env \$Tool --json/);
    expect(out).toMatch(/Invoke-ClausonaTool -Tool claude/);
    expect(out).toMatch(/ConvertFrom-Json/);
    expect(out).toMatch(/finally/);
  });

  it("avoids the null-coalescing operator (PowerShell 5.1 floor)", () => {
    expect(out).not.toMatch(/\?\?/);
    // 5.1 has neither `??` nor `?:` nor `?.`, and the script has never needed a `?` for
    // anything else, so the cheapest way to keep all three out is to allow none of them.
    expect(out).not.toContain("?");
  });

  // Task 4 emits a warning on every _shell-env run so a broken profile keeps announcing
  // itself. Merging stderr into stdout would corrupt the JSON, so it is captured and
  // replayed instead - and discarding it, as `2>$null` did, voided the contract on Windows.
  it("replays _shell-env warnings to stderr instead of discarding them", () => {
    expect(out).not.toMatch(/_shell-env \$Tool --json 2>\$null/);
    expect(out).toMatch(/_shell-env \$Tool --json 2>\$stderrPath/);
    // Not Write-Host: that writes to stdout and would corrupt `claude | Something`.
    expect(out).toMatch(/\[Console\]::Error\.Write\(\$warning\)/);
    expect(out).toMatch(/Remove-Item -LiteralPath \$stderrPath -Force/);
    // stdout carries the JSON; merging the two streams would break ConvertFrom-Json.
    expect(out).not.toMatch(/2>&1/);
  });

  it("cannot let the diagnostic path stop the tool from launching", () => {
    // Both the lookup and the replay of its warnings are wrapped, and the replay runs in a
    // finally so the temp file is cleaned up even when the lookup threw.
    const helper = out.split("function global:Invoke-ClausonaTool")[1]?.split("function global:claude")[0] ?? "";
    expect(helper).toMatch(/catch \{[\s\S]*?\} finally \{[\s\S]*?Test-Path -LiteralPath \$stderrPath/);
    expect(helper).toMatch(/try \{[\s\S]*?Remove-Item -LiteralPath \$stderrPath -Force[\s\S]*?\} catch \{/);
  });

  // 5.1 has no `?:` either, and `[Environment]::GetEnvironmentVariable` is the only
  // accessor that reports an unset variable as $null rather than "".
  it("restores an unset variable to unset rather than empty", () => {
    expect(out).toMatch(/\[Environment\]::GetEnvironmentVariable\(\$name, "Process"\)/);
    expect(out).toMatch(/\[Environment\]::SetEnvironmentVariable\(\$name, \$applied\[\$name\], "Process"\)/);
    expect(out).not.toMatch(/\$\w+\s*\?\s*[^\s]+\s*:\s/);
  });

  it("steps aside when the user set the config variable themselves", () => {
    expect(out).toMatch(/Test-Path Env:CLAUDE_CONFIG_DIR/);
    expect(out).toMatch(/Test-Path Env:CODEX_HOME/);
  });

  it("keeps _sync-plugins and _track-usage claude-only and preserves the exit code", () => {
    expect(out).toMatch(/if \(\$Tool -eq "claude"\) \{ clausona _sync-plugins/);
    expect(out).toMatch(/if \(\$Tool -eq "claude"\) \{ clausona _track-usage/);
    expect(out).toMatch(/\$global:LASTEXITCODE = \$exitCode/);
  });

  it("retains the csn alias", () => {
    expect(out).toMatch(/Set-Alias -Name csn -Value clausona -Scope Global/);
  });
});

describe("renderPosixExports", () => {
  it("returns an empty string for an empty env", () => {
    expect(renderPosixExports({})).toBe("");
  });

  it("single-quotes every value", () => {
    expect(renderPosixExports({ A: "1", B: "two" })).toBe("export A='1'\nexport B='two'");
  });

  it("survives a value containing a single quote", () => {
    // '\'' closes the quote, emits a literal quote, and reopens — the only safe form.
    expect(renderPosixExports({ K: "a'b" })).toBe("export K='a'\\''b'");
  });

  it("does not expand $, backticks, or newlines", () => {
    const out = renderPosixExports({ K: "$HOME `id`\nx" });
    expect(out).toBe("export K='$HOME `id`\nx'");
  });

  // The key is interpolated bare, so `export A; touch /tmp/pwned; B='1'` would run as
  // three commands inside the caller's eval. Quoting the key is not an available fix -
  // `export 'A B'='1'` is not valid POSIX - so such a key is simply not emitted.
  it("omits a key that is not a POSIX environment variable name", () => {
    const out = renderPosixExports({
      "A; touch /tmp/clausona-pwned; B": "1",
      "A $(id)": "1",
      "A `id`": "1",
      "A B": "1",
      "A=B": "1",
      "9LEADING": "1",
      "": "1",
      OK_KEY: "1",
    });
    expect(out).toBe("export OK_KEY='1'");
  });
});

describe("isPosixEnvName", () => {
  it("accepts names a shell can export", () => {
    for (const key of ["A", "_", "_A9", "ANTHROPIC_BASE_URL", "a_b_c"]) {
      expect(isPosixEnvName(key), key).toBe(true);
    }
  });

  it("rejects anything else", () => {
    for (const key of ["", "9A", "A B", "A=B", "A;B", "A$(id)", "A-B", "A\nB", "ünïcode"]) {
      expect(isPosixEnvName(key), JSON.stringify(key)).toBe(false);
    }
  });
});
