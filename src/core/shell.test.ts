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

  const helper = out.split("function global:Invoke-ClausonaTool")[1]?.split("function global:claude")[0] ?? "";

  // Task 4 emits a warning on every _shell-env run so a broken profile keeps announcing
  // itself. Merging stderr into stdout would corrupt the JSON, so it is captured and
  // replayed instead - and discarding it, as `2>$null` alone did, voided the contract on
  // Windows.
  it("replays _shell-env warnings to stderr instead of discarding them", () => {
    expect(out).toMatch(/_shell-env \$Tool --json 2>\$stderrPath/);
    // Not Write-Host: that writes to stdout and would corrupt `claude | Something`.
    expect(out).toMatch(/\[Console\]::Error\.Write\(\$warning\)/);
    expect(out).toMatch(/Remove-Item -LiteralPath \$stderrPath -Force/);
    // stdout carries the JSON; merging the two streams would break ConvertFrom-Json.
    expect(out).not.toMatch(/2>&1/);
  });

  /**
   * The rule: the diagnostic path must never be able to break the env-application path.
   * Creating the capture file is the one step that can fail before the lookup runs, so a
   * failure there degrades to the old behaviour - environment applied, warnings lost -
   * never to no environment at all, which would launch the tool against the default
   * account with nothing said.
   */
  it("still applies the environment when the capture file cannot be created", () => {
    // Creating it cannot throw out of the lookup, and leaves $stderrPath falsy if it fails.
    expect(helper).toMatch(
      /\$stderrPath = \$null\s*\n\s*try \{\s*\n\s*\$stderrPath = \[System\.IO\.Path\]::GetTempFileName\(\)\s*\n\s*\} catch \{\s*\n\s*\$stderrPath = \$null\s*\n\s*\}/,
    );
    // Exactly two spellings of the lookup, one per branch, and every one assigns $raw - so
    // no path through this block leaves the profile environment unread.
    const lookups = helper.match(/.*clausona _shell-env \$Tool --json.*/g) ?? [];
    expect(lookups).toEqual([
      "      $raw = & clausona _shell-env $Tool --json 2>$stderrPath",
      "      $raw = & clausona _shell-env $Tool --json 2>$null",
    ]);
    // ...and they are the two arms of one if/else, so a run makes exactly one call. Fix 2
    // cut this command's cost in half; a second invocation would hand it straight back.
    expect(helper).toMatch(
      /if \(\$stderrPath\) \{\s*\n\s*\$raw = & clausona _shell-env \$Tool --json 2>\$stderrPath\s*\n\s*\} else \{\s*\n\s*\$raw = & clausona _shell-env \$Tool --json 2>\$null\s*\n\s*\}/,
    );
  });

  it("cannot let the diagnostic path stop the tool from launching", () => {
    // Both the lookup and the replay of its warnings are wrapped, and the replay runs in a
    // finally so the temp file is cleaned up even when the lookup threw.
    expect(helper).toMatch(/catch \{[\s\S]*?\} finally \{[\s\S]*?Test-Path -LiteralPath \$stderrPath/);
    // The read and the delete are separate try blocks, in that order, so a read that threw
    // still deletes the file it was reading.
    expect(helper).toMatch(
      /Get-Content -LiteralPath \$stderrPath[\s\S]*?\} catch \{[\s\S]*?\}[\s\S]*?try \{[\s\S]*?Remove-Item -LiteralPath \$stderrPath -Force/,
    );
    // Both file blocks sit under `if ($stderrPath)`, so the fallback branch - which has no
    // capture file - touches no file at all.
    expect(helper).toMatch(
      /if \(\$stderrPath\) \{\s*\n\s*if \(Test-Path -LiteralPath \$stderrPath\) \{\s*\n\s*\$warning = Get-Content -LiteralPath \$stderrPath -Raw/,
    );
    expect(helper).toMatch(/if \(\$stderrPath\) \{ Remove-Item -LiteralPath \$stderrPath -Force/);
  });

  /**
   * Under a caller's `$ErrorActionPreference = 'Stop'`, 5.1 makes the first line of a
   * redirected native stderr a terminating error. Every clausona step redirects stderr: the
   * lookup would die on the very warning it exists to replay, a failing sync would stop the
   * tool from starting, and a failing usage record would replace the tool's exit code with an
   * error. So each clausona step runs under Continue, and only the tool runs under the
   * caller's own preference.
   */
  it("runs every clausona step under Continue and only the tool under the caller's preference", () => {
    // Every statement that touches the preference or does real work, in order. Comments are
    // skipped - they name these steps too.
    const steps = helper
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .flatMap((line) => {
        if (/^\s*\$callerErrorAction = \$ErrorActionPreference\s*$/.test(line)) return ["save"];
        if (/^\s*\$ErrorActionPreference = "Continue"\s*$/.test(line)) return ["Continue"];
        if (/^\s*\$ErrorActionPreference = \$callerErrorAction\s*$/.test(line)) return ["caller's"];
        // Any other mention - a scope-qualified `$global:ErrorActionPreference`, a Set-Variable,
        // an assignment tucked inside a block - is a stray step that fails the list below.
        if (/ErrorActionPreference/.test(line)) return [`other: ${line.trim()}`];
        if (/clausona _shell-env/.test(line)) return ["_shell-env"];
        if (/clausona _sync-plugins/.test(line)) return ["_sync-plugins"];
        if (/\$command = Get-Command/.test(line)) return ["Get-Command"];
        if (/& \$command\.Source @ToolArgs/.test(line)) return ["tool"];
        if (/^\s*\$exitCode = \$LASTEXITCODE\s*$/.test(line)) return ["exitCode"];
        if (/clausona _track-usage/.test(line)) return ["_track-usage"];
        if (/\$global:LASTEXITCODE = \$exitCode/.test(line)) return ["LASTEXITCODE"];
        return [];
      });
    expect(steps).toEqual([
      "save",
      "Continue",
      // The two arms of the lookup's if/else.
      "_shell-env",
      "_shell-env",
      // No restore in between: the sync still runs under Continue.
      "_sync-plugins",
      "caller's",
      "Get-Command",
      "tool",
      // Captured before _track-usage, which is itself a native call and resets $LASTEXITCODE.
      "exitCode",
      "Continue",
      "_track-usage",
      "LASTEXITCODE",
      // The finally below.
      "caller's",
    ]);

    // Saved and overridden immediately before the try that holds the lookup...
    expect(helper).toMatch(
      /\$callerErrorAction = \$ErrorActionPreference\s*\n\s*\$ErrorActionPreference = "Continue"\s*\n\s*try \{\s*\n\s*if \(\$stderrPath\) \{\s*\n\s*\$raw = & clausona _shell-env/,
    );
    // ...handed back on the line before the tool is looked up...
    expect(helper).toMatch(/\$ErrorActionPreference = \$callerErrorAction\s*\n\s*\$command = Get-Command/);
    // ...and handed back again as the first statement of the finally that restores the
    // environment, so no way out of the block leaves Continue behind.
    expect(helper).toMatch(
      /\} finally \{\s*\n(?:\s*#.*\n)*\s*\$ErrorActionPreference = \$callerErrorAction\s*\n\s*foreach \(\$name in \$applied\.Keys\)/,
    );
    // Continue alone does not cover a clausona that is no longer on PATH, so each helper call
    // is also caught - neither can stop the tool from starting or skip LASTEXITCODE.
    expect(helper).toMatch(/try \{ clausona _sync-plugins \*> \$null \} catch \{ \}/);
    expect(helper).toMatch(/try \{ clausona _track-usage \*> \$null \} catch \{ \}/);
  });

  /**
   * `_shell-env --json` gives a variable the run must not inherit - a credential the caller
   * exported for something else - the value null. ConvertFrom-Json turns that into $null,
   * and SetEnvironmentVariable removes a variable it is handed $null (or "") for. So the
   * removal works only while every property takes the same unfiltered path: previous value
   * captured, new value applied as is. A `where Value` filter, or an `if ($property.Value)`,
   * would skip exactly the properties that exist to remove something.
   */
  it("applies every property as is, so a null removes the variable for the run", () => {
    expect(helper).toMatch(
      /foreach \(\$property in \$parsed\.PSObject\.Properties\) \{\s*\n\s*\$name = \$property\.Name\s*\n\s*\$applied\[\$name\] = \[Environment\]::GetEnvironmentVariable\(\$name, "Process"\)\s*\n\s*\[Environment\]::SetEnvironmentVariable\(\$name, \$property\.Value, "Process"\)\s*\n\s*\}/,
    );
    // ...and the restore hands back whatever was captured: the caller's value, or its absence.
    expect(helper).toMatch(
      /foreach \(\$name in \$applied\.Keys\) \{\s*\n\s*\[Environment\]::SetEnvironmentVariable\(\$name, \$applied\[\$name\], "Process"\)\s*\n\s*\}/,
    );
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
    expect(out).toMatch(/if \(\$Tool -eq "claude"\) \{\s*\n\s*try \{ clausona _sync-plugins/);
    expect(out).toMatch(/if \(\$Tool -eq "claude"\) \{\s*\n\s*try \{ clausona _track-usage/);
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

  // An API profile clears a credential the caller exported for something else. The hook
  // evals this inside its subshell, so the parent shell keeps its own value.
  it("emits unset lines ahead of the exports", () => {
    expect(renderPosixExports({ A: "1", B: "2" }, ["C", "D"])).toBe("unset C\nunset D\nexport A='1'\nexport B='2'");
  });

  it("emits only unset lines when nothing is exported", () => {
    expect(renderPosixExports({}, ["C"])).toBe("unset C");
  });

  it("is unchanged when nothing is unset", () => {
    expect(renderPosixExports({ A: "1" }, [])).toBe("export A='1'");
    expect(renderPosixExports({}, [])).toBe("");
  });

  // Same last line of defence as the exports: `unset A; touch /tmp/pwned` would run twice.
  it("omits an unset key that is not a POSIX environment variable name", () => {
    expect(renderPosixExports({ OK: "1" }, ["A; touch /tmp/clausona-pwned; B", "A $(id)", "", "GONE"])).toBe(
      "unset GONE\nexport OK='1'",
    );
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
