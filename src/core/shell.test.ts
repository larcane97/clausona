import { describe, expect, it } from "vitest";
import {
  isPosixEnvName,
  powerShellLiteral,
  renderPosixExports,
  renderPosixShellInit,
  renderPowerShellInit,
  renderShellInit,
  type ShellInitPaths,
} from "./shell.js";

/** Paths with a quote in them, so every place they land has to quote them properly. */
const PATHS: ShellInitPaths = {
  cachePath: (tool, format) =>
    `/home/o'brien/.clausona/cache/launch-9.9.9-${tool}.${format === "posix" ? "sh" : "json"}`,
  refPath: (tool) => `/home/o'brien/.clausona/cache/launch-9.9.9-${tool}.ref`,
  registryPath: "/home/o'brien/.clausona/profiles.json",
  home: "/home/o'brien",
};
const quoted = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

describe("renderShellInit", () => {
  const out = renderPosixShellInit(PATHS);
  const claudeBlock = out.split(/^claude\(\)\s*\{/m)[1]?.split(/^\}/m)[0] ?? "";
  const codexBlock = out.split(/^codex\(\)\s*\{/m)[1] ?? "";
  // From the subshell's opening paren to the `)` that closes it on its own line.
  const subshell =
    claudeBlock
      .split(/^\s*\(\s*$/m)
      .slice(1)
      .join("(")
      .split(/^\s*\)\s*$/m)[0] ?? "";

  it("no longer defines the inline node resolver", () => {
    expect(out).not.toMatch(/_clausona_resolve/);
    expect(out).not.toMatch(/node -e/);
  });

  it("evaluates the launch script inside a subshell so exports do not leak", () => {
    expect(subshell).toMatch(/eval "\$_clausona_launch"/);
    expect(subshell).toMatch(/eval "\$\(clausona _launch claude\)"/);
    expect(subshell).toMatch(/command claude "\$@"/);
    expect(claudeBlock).not.toMatch(/unset CLAUDE_CONFIG_DIR/);
  });

  /**
   * The common path starts no process: the cached script is read by the shell itself, and
   * only under the HOME the hook was rendered for, while profiles.json is the file it was
   * rendered from and older than it - a registry that is missing, another file, or as new as
   * the script sends the run to `_launch`, which is slower and never wrong. The paths are
   * baked in single-quoted, so a home directory holding a quote or a `!` stays literal.
   */
  it("reads the cached launch script only while the registry is the one it was rendered from", () => {
    const cache = quoted(PATHS.cachePath("claude", "posix"));
    const ref = quoted(PATHS.refPath("claude"));
    const registry = quoted(PATHS.registryPath);
    expect(subshell).toContain(
      `if [[ $HOME == ${quoted(PATHS.home)} && -f ${registry} && ${registry} -ef ${ref} && ${cache} -nt ${registry} ]] && { _clausona_launch=$(<${cache}); } 2>/dev/null; then`,
    );
    expect(codexBlock).toContain(
      `${registry} -ef ${quoted(PATHS.refPath("codex"))} && ${quoted(PATHS.cachePath("codex", "posix"))} -nt ${registry}`,
    );
  });

  it("steps aside when the user set CLAUDE_CONFIG_DIR themselves", () => {
    expect(out).toMatch(/if \[\[ -n "\$\{CLAUDE_CONFIG_DIR:-\}" \]\]/);
  });

  // The launch script carries its own staleness check, so the hook itself no longer starts a
  // process for the plugin sync, and never calls the command old hooks used.
  it("leaves the plugin sync to the launch script", () => {
    expect(out).not.toMatch(/_sync-plugins/);
    expect(out).not.toMatch(/_shell-env/);
    // _track-usage belongs after the subshell, so it still runs once the variables are gone.
    expect(subshell).not.toMatch(/clausona _track-usage/);
  });

  it("keeps _track-usage outside the subshell and claude-only", () => {
    expect(out).toMatch(/clausona _track-usage/);
    expect(codexBlock).not.toMatch(/_track-usage/);
  });

  it("defines a codex wrapper on the same mechanism", () => {
    expect(codexBlock).toMatch(/eval "\$\(clausona _launch codex\)"/);
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
    expect(renderShellInit("win32", PATHS)).toBe(renderPowerShellInit(PATHS));
    expect(renderShellInit("darwin", PATHS)).toBe(renderPosixShellInit(PATHS));
  });
});

describe("powerShellLiteral", () => {
  it("single-quotes an ASCII string, doubling its quotes", () => {
    expect(powerShellLiteral("C:\\Users\\o'brien\\$x`y")).toBe("'C:\\Users\\o''brien\\$x`y'");
    expect(powerShellLiteral("")).toBe("''");
  });

  /**
   * The hook reaches PowerShell as a native command's output, which it decodes in the
   * console's code page - so a Hangul user folder baked in as UTF-8 would name a folder that
   * does not exist. Every character past ASCII is spelled as a [char] instead; that also
   * covers the curly quotes PowerShell accepts as single quotes, which could otherwise end the
   * literal early.
   */
  it("spells everything past ASCII as [char]s, starting from a string", () => {
    expect(powerShellLiteral("C:\\Users\\\uD64D\uAE38\\x")).toBe(
      "('C:\\Users\\' + [char]0xd64d + [char]0xae38 + '\\x')",
    );
    expect(powerShellLiteral("\u2019a")).toBe("('' + [char]0x2019 + 'a')");
  });
});

describe("renderPowerShellInit", () => {
  const out = renderPowerShellInit(PATHS);

  it("consumes the JSON form and restores every variable it set", () => {
    // One helper serves both tools, so the tool name is the $Tool parameter.
    expect(out).toMatch(/& clausona _launch \$Tool --json/);
    expect(out).toMatch(/Invoke-ClausonaTool -Tool claude/);
    expect(out).toMatch(/ConvertFrom-Json/);
    expect(out).toMatch(/finally/);
    expect(out).not.toMatch(/_shell-env/);
  });

  it("avoids the null-coalescing operator (PowerShell 5.1 floor)", () => {
    expect(out).not.toMatch(/\?\?/);
    // 5.1 has neither `??` nor `?:` nor `?.`, and the script has never needed a `?` for
    // anything else, so the cheapest way to keep all three out is to allow none of them.
    expect(out).not.toContain("?");
  });

  const helper = out.split("function global:Invoke-ClausonaTool")[1]?.split("function global:claude")[0] ?? "";

  /**
   * The PowerShell form of the POSIX hook's rule: the cached script is used only while
   * profiles.json has exactly the write time and length it was rendered from, and every file
   * step is told to stop on an error and caught, so a cache deleted mid-read is a miss -
   * `_launch` - never a run with no profile, and never an error printed in the caller's console.
   */
  it("reads the cached launch script only while the registry is the one it was rendered from", () => {
    expect(helper).toContain(`$cachePath = ${powerShellLiteral(PATHS.cachePath("claude", "json"))}`);
    expect(helper).toContain(`$cachePath = ${powerShellLiteral(PATHS.cachePath("codex", "json"))}`);
    expect(helper).toContain(`$registryPath = ${powerShellLiteral(PATHS.registryPath)}`);
    // $HOME is PowerShell's own, and read-only; the baked home has a name of its own.
    expect(helper).toContain(`$clausonaHome = ${powerShellLiteral(PATHS.home)}`);
    expect(helper).toMatch(
      /try \{\s*\n\s*if \(\(\$env:USERPROFILE -eq \$clausonaHome\) -and \(Test-Path -LiteralPath \$cachePath\) -and \(Test-Path -LiteralPath \$registryPath\)\) \{\s*\n\s*\$registryItem = Get-Item -LiteralPath \$registryPath -ErrorAction Stop\s*\n\s*\$parsed = Get-Content -LiteralPath \$cachePath -Raw -ErrorAction Stop \| ConvertFrom-Json -ErrorAction Stop\s*\n\s*\$sameTicks = \$parsed\.registry\.ticks -eq \[string\]\$registryItem\.LastWriteTimeUtc\.Ticks\s*\n\s*\$sameLength = \$parsed\.registry\.length -eq \[string\]\$registryItem\.Length\s*\n\s*if \(-not \(\$sameTicks -and \$sameLength\)\) \{ \$parsed = \$null \}\s*\n\s*\}\s*\n\s*\} catch \{\s*\n\s*\$parsed = \$null\s*\n\s*\}/,
    );
    // An exact match, not an ordering: a backup moved back over the file is older, not newer.
    expect(helper).not.toMatch(/LastWriteTimeUtc -gt \(Get-Item -LiteralPath \$registryPath/);
    // Only a miss asks clausona, which also rules out a second lookup after a hit.
    expect(helper).toMatch(/if \(-not \$parsed\) \{\s*\n(?:\s*#.*\n)*\s*\$stderrPath = \$null/);
  });

  // `_launch` warns on every run so a broken profile keeps announcing itself. Merging stderr
  // into stdout would corrupt the JSON, so it is captured and replayed instead - and
  // discarding it, as `2>$null` alone did, voided the contract on Windows.
  it("replays _launch warnings to stderr instead of discarding them", () => {
    expect(out).toMatch(/_launch \$Tool --json 2>\$stderrPath/);
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
    const lookups = helper.match(/.*clausona _launch \$Tool --json.*/g) ?? [];
    expect(lookups).toEqual([
      "        $raw = & clausona _launch $Tool --json 2>$stderrPath",
      "        $raw = & clausona _launch $Tool --json 2>$null",
    ]);
    // ...and they are the two arms of one if/else, so a run makes exactly one call. Fix 2
    // cut this command's cost in half; a second invocation would hand it straight back.
    expect(helper).toMatch(
      /if \(\$stderrPath\) \{\s*\n\s*\$raw = & clausona _launch \$Tool --json 2>\$stderrPath\s*\n\s*\} else \{\s*\n\s*\$raw = & clausona _launch \$Tool --json 2>\$null\s*\n\s*\}\s*\n\s*if \(\$raw\) \{ \$parsed = \$raw \| ConvertFrom-Json \}/,
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
        if (/Test-Path -LiteralPath \$cachePath/.test(line)) return ["cache"];
        if (/clausona _launch/.test(line)) return ["_launch"];
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
      // The cache is read under Continue too, although each of its steps says Stop itself.
      "cache",
      // The two arms of the lookup's if/else.
      "_launch",
      "_launch",
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

    // Saved and overridden as the first thing the helper does after setting up its table...
    expect(helper).toMatch(
      /\$applied = @\{\}\s*\n(?:\s*#.*\n)*\s*\$callerErrorAction = \$ErrorActionPreference\s*\n\s*\$ErrorActionPreference = "Continue"\s*\n/,
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
   * The same staleness check the POSIX launch script carries, done by the hook from the
   * `sync` block: due when the stamp is missing or anything watched is newer, and when the
   * check itself fails - running the sync once too often costs a second, missing a plugin
   * costs the user a broken session. Nothing is synced when there is no script at all, which
   * is what the POSIX hook does too.
   */
  it("runs _sync-plugins only when the launch script's sync check says it is due", () => {
    expect(helper).toMatch(
      /if \(\$Tool -eq "claude"\) \{\s*\n\s*\$syncDue = \$false\s*\n\s*try \{\s*\n\s*if \(\$parsed\) \{\s*\n\s*if \(\$parsed\.sync\) \{\s*\n\s*\$syncDue = \$true\s*\n\s*if \(Test-Path -LiteralPath \$parsed\.sync\.stamp\) \{\s*\n\s*\$stampTime = \(Get-Item -LiteralPath \$parsed\.sync\.stamp -ErrorAction Stop\)\.LastWriteTimeUtc\s*\n\s*\$syncDue = \$false\s*\n\s*foreach \(\$watched in \$parsed\.sync\.watch\) \{\s*\n\s*if \(Test-Path -LiteralPath \$watched\) \{\s*\n\s*if \(\(Get-Item -LiteralPath \$watched -ErrorAction Stop\)\.LastWriteTimeUtc -ge \$stampTime\) \{ \$syncDue = \$true \}/,
    );
    expect(helper).toMatch(
      /\} catch \{\s*\n\s*\$syncDue = \$true\s*\n\s*\}\s*\n\s*if \(\$syncDue\) \{\s*\n\s*try \{ clausona _sync-plugins \*> \$null \} catch \{ \}\s*\n\s*\}/,
    );
  });

  /**
   * `_launch --json` gives a variable the run must not inherit - a credential the caller
   * exported for something else - the value null. ConvertFrom-Json turns that into $null,
   * and SetEnvironmentVariable removes a variable it is handed $null (or "") for. So the
   * removal works only while every property takes the same unfiltered path: previous value
   * captured, new value applied as is. A `where Value` filter, or an `if ($property.Value)`,
   * would skip exactly the properties that exist to remove something.
   */
  it("applies every property as is, so a null removes the variable for the run", () => {
    expect(helper).toMatch(
      /foreach \(\$property in \$parsed\.env\.PSObject\.Properties\) \{\s*\n\s*\$name = \$property\.Name\s*\n\s*\$applied\[\$name\] = \[Environment\]::GetEnvironmentVariable\(\$name, "Process"\)\s*\n\s*\[Environment\]::SetEnvironmentVariable\(\$name, \$property\.Value, "Process"\)\s*\n\s*\}/,
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
    expect(out.match(/clausona _sync-plugins/g)).toHaveLength(1);
    expect(out).toMatch(/if \(\$Tool -eq "claude"\) \{\s*\n\s*\$syncDue = \$false/);
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

  /**
   * An API profile clears a credential the caller exported for something else, and sets its
   * own endpoint and key. The hook evals all of it inside its subshell, so the parent shell
   * keeps its own values.
   *
   * A `readonly` variable can be neither unset nor exported, and without a guard both shells
   * fail the wrong way: bash carries on, so the tool gets the caller's credential next to
   * the profile's endpoint; zsh abandons the rest of the eval, so the tool runs on the
   * default account. So every name the profile must control is probed first, in a single
   * throwaway subshell, and one that will not move stops the run - fail closed, with the
   * names (never the values) on stderr.
   */
  const guard = (...names: string[]) =>
    `if ( unset ${names.join(" ")} ) 2>/dev/null; then :; else for _clausona_name in ${names.join(" ")}; do ( unset $_clausona_name ) 2>/dev/null || printf 'clausona: %s is read-only in this shell, so clausona cannot set or clear it for this profile. Not starting the tool.\\n' $_clausona_name >&2; done; exit 1; fi`;

  it("probes every name it clears, in one subshell, ahead of the unsets and exports", () => {
    expect(renderPosixExports({ A: "1", B: "2" }, ["C", "D"])).toBe(
      `${guard("C", "D")}\nunset C D\nexport A='1'\nexport B='2'`,
    );
  });

  it("probes the names it sets as well, when the caller names them", () => {
    expect(renderPosixExports({ A: "1" }, ["C"], ["C", "A"])).toBe(`${guard("C", "A")}\nunset C\nexport A='1'`);
  });

  it("emits only the guard and the unsets when nothing is exported", () => {
    expect(renderPosixExports({}, ["C"])).toBe(`${guard("C")}\nunset C`);
  });

  it("is unchanged when there is nothing to control", () => {
    expect(renderPosixExports({ A: "1" }, [], [])).toBe("export A='1'");
    expect(renderPosixExports({}, [], [])).toBe("");
  });

  // Same last line of defence as the exports: `unset A; touch /tmp/pwned` would run twice.
  it("omits a name that is not a POSIX environment variable name", () => {
    expect(
      renderPosixExports({ OK: "1" }, ["A; touch /tmp/clausona-pwned; B", "A $(id)", "", "GONE"], ["A `id`"]),
    ).toBe(`${guard("GONE")}\nunset GONE\nexport OK='1'`);
  });

  it("probes a name it both clears and sets only once", () => {
    expect(renderPosixExports({}, ["C"], ["C", "C"])).toBe(`${guard("C")}\nunset C`);
  });

  // The guard is eval'd at run time, in whatever shell the user has: it must not rely on
  // anything a strict POSIX sh lacks, and it must not carry a `!` a zsh might expand.
  it("keeps the guard to plain POSIX syntax", () => {
    const line = guard("C", "D");
    expect(line).not.toContain("!");
    expect(line).not.toContain('"');
    expect(line).not.toMatch(/\[\[|\$\(|`/);
    // One fork on the common path: the per-name probes sit behind the `else`.
    expect(line.split("( unset")[0]).toBe("if ");
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
