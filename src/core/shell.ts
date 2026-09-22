/**
 * The one definition of a name a shell can export. Every layer that puts a profile's
 * free-form env map onto a command line checks a key against this: `validateEnvEntry`
 * refuses it at set time, `buildProfileEnv` drops it with a warning at build time.
 *
 * Refusing is the only option - quoting does not help, because `export 'A B'='x'` is not
 * valid POSIX either.
 */
const POSIX_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isPosixEnvName(key: string): boolean {
  return POSIX_ENV_NAME.test(key);
}

/**
 * Emits `unset KEY` lines for the variables a run must not inherit, then `export
 * KEY='VALUE'` lines. The hook evals both inside its subshell, so an unset hides the
 * caller's own value from the tool without touching the caller's shell.
 *
 * Single quotes are the only POSIX form in which no character is special, so a value can
 * carry `$`, backticks, and newlines untouched; an embedded quote is closed, escaped, and
 * reopened.
 *
 * The key has no such escape - it is interpolated bare - so a key carrying `;` or `$(...)`
 * would turn into extra commands in the `eval` that consumes this output. Callers validate
 * keys before they get here; this filter is the last line of defence for one that did not,
 * and it drops silently because a renderer has nowhere to report to. Unset keys go through
 * it too, though today they are constants.
 */
export function renderPosixExports(env: Record<string, string>, unset: readonly string[] = []): string {
  const unsets = unset.filter((key) => isPosixEnvName(key)).map((key) => `unset ${key}`);
  const exports = Object.entries(env)
    .filter(([key]) => isPosixEnvName(key))
    .map(([key, value]) => `export ${key}='${value.replace(/'/g, "'\\''")}'`);
  return [...unsets, ...exports].join("\n");
}

/**
 * The wrapper asks `clausona _shell-env <tool>` for the whole environment a run needs and
 * evals it inside a subshell, so the variables live exactly as long as the tool does.
 * Nothing is unset by hand: there is no ledger of what was set to drift out of date, and a
 * value the user exported in their own profile is untouched when the call returns.
 *
 * Two rules the generated script must keep:
 * - no `!` inside a double-quoted string, because zsh history-expands it when the function
 *   is *defined*, which breaks sourcing the init for every user at shell startup;
 * - no credential on a command line (`env KEY=VALUE cmd`), because `ps` shows it to every
 *   user on the machine. The eval keeps secrets inside the subshell's own environment.
 */
export function renderPosixShellInit() {
  return `# clausona shell integration
unalias claude 2>/dev/null
claude() {
  # An explicit CLAUDE_CONFIG_DIR means the user is driving; clausona steps aside.
  if [[ -n "\${CLAUDE_CONFIG_DIR:-}" ]]; then
    command claude "$@"
    return $?
  fi
  (
    eval "$(clausona _shell-env claude)"
    clausona _sync-plugins 2>/dev/null
    command claude "$@"
  )
  local rc=$?
  clausona _track-usage 2>/dev/null
  return $rc
}

unalias codex 2>/dev/null
codex() {
  if [[ -n "\${CODEX_HOME:-}" ]]; then
    command codex "$@"
    return $?
  fi
  (
    eval "$(clausona _shell-env codex)"
    command codex "$@"
  )
  return $?
}

alias csn=clausona
`;
}

/**
 * PowerShell has no throwaway subshell, so this hook does by hand what the POSIX one gets
 * for free: capture each variable's previous value, set the profile's, and restore in a
 * `finally`. `[Environment]::GetEnvironmentVariable` is used rather than `$env:` because it
 * is the only accessor that reports an unset variable as `$null` instead of an empty
 * string - and passing that same `$null` back to `SetEnvironmentVariable` removes the
 * variable, which is what restoring "it was not set" has to mean.
 *
 * Targets Windows PowerShell 5.1, so no null-coalescing and no ternary operator.
 */
export function renderPowerShellInit() {
  return `# clausona PowerShell integration
function global:Invoke-ClausonaTool {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("claude", "codex")][string]$Tool,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$ToolArgs
  )

  # $env: is process-global here, so the previous values are captured and restored.
  $applied = @{}
  # A warning from _shell-env means a persistent misconfiguration - a credential that will
  # not resolve, a key clausona cannot export - so it has to reach the user on every run,
  # exactly as it does on POSIX. stderr cannot be merged into stdout, which carries the
  # JSON, and 5.1 cannot split a native command's streams inline; so stderr goes to a temp
  # file and is replayed to the console afterwards.
  #
  # Creating that file is the one step that can fail before the lookup runs, so it is
  # guarded and the lookup has a branch for each outcome. Losing the warnings is bad;
  # running the tool against the default account without saying so would be worse, and
  # that is what a lookup skipped over a temp file would cause. Exactly one branch runs,
  # so a run still makes exactly one _shell-env call.
  $stderrPath = $null
  try {
    $stderrPath = [System.IO.Path]::GetTempFileName()
  } catch {
    $stderrPath = $null
  }
  # A caller's $ErrorActionPreference = 'Stop' must not let a clausona step cut the run short.
  # 5.1 turns each line a native command writes to a redirected stderr into an error record,
  # so under Stop the first warning would throw - here, before $raw is assigned; 7.3+ can do
  # the same to a non-zero exit. Every clausona call below runs under Continue; only the tool
  # itself gets the caller's own preference back.
  $callerErrorAction = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    if ($stderrPath) {
      $raw = & clausona _shell-env $Tool --json 2>$stderrPath
    } else {
      $raw = & clausona _shell-env $Tool --json 2>$null
    }
    if ($raw) {
      $parsed = $raw | ConvertFrom-Json
      foreach ($property in $parsed.PSObject.Properties) {
        $name = $property.Name
        $applied[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
        [Environment]::SetEnvironmentVariable($name, $property.Value, "Process")
      }
    }
  } catch {
    # A failed lookup must never stop the tool from starting.
  } finally {
    # Neither must reporting one, hence the inner try. [Console]::Error keeps the warning
    # on stderr, where Write-Host would put it on stdout and corrupt a piped run.
    #
    # -LiteralPath throughout: a temp directory under a user name containing [ or ] would
    # otherwise read as a wildcard, and the file would be neither reported nor deleted.
    try {
      if ($stderrPath) {
        if (Test-Path -LiteralPath $stderrPath) {
          $warning = Get-Content -LiteralPath $stderrPath -Raw
          if ($warning) { [Console]::Error.Write($warning) }
        }
      }
    } catch {
      # Nothing left to do about a warning that cannot be printed.
    }
    # Its own try, so a read that threw above still deletes the file it read from.
    try {
      if ($stderrPath) { Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue }
    } catch {
      # Nothing left to do about a temp file that cannot be deleted.
    }
  }

  try {
    # Still under Continue, and caught, so neither a warning from the sync nor a clausona that
    # has gone from PATH can stop the tool from starting.
    if ($Tool -eq "claude") {
      try { clausona _sync-plugins *> $null } catch { }
    }
    # The tool runs under the caller's own preference, exactly as it would without clausona.
    $ErrorActionPreference = $callerErrorAction
    $command = Get-Command $Tool -CommandType Application -ErrorAction Stop | Select-Object -First 1
    & $command.Source @ToolArgs
    $exitCode = $LASTEXITCODE
    # Continue again, and caught, for the bookkeeping: a throw here would skip the line below
    # and hand the caller an error, or clausona's exit code, in place of the tool's.
    $ErrorActionPreference = "Continue"
    if ($Tool -eq "claude") {
      try { clausona _track-usage *> $null } catch { }
    }
    $global:LASTEXITCODE = $exitCode
  } finally {
    # The override is function-local and dies with this scope anyway; this makes it explicit
    # that no way out of the block - a Ctrl-C during the bookkeeping included - keeps it.
    $ErrorActionPreference = $callerErrorAction
    foreach ($name in $applied.Keys) {
      [Environment]::SetEnvironmentVariable($name, $applied[$name], "Process")
    }
  }
}

function global:claude {
  # No param() block on purpose: it would bind arguments that look like parameter
  # names (-a matches -Arguments) instead of forwarding them. $args forwards verbatim.
  if (Test-Path Env:CLAUDE_CONFIG_DIR) {
    $command = Get-Command claude -CommandType Application -ErrorAction Stop | Select-Object -First 1
    & $command.Source @args
    return
  }
  Invoke-ClausonaTool -Tool claude -ToolArgs $args
}

function global:codex {
  if (Test-Path Env:CODEX_HOME) {
    $command = Get-Command codex -CommandType Application -ErrorAction Stop | Select-Object -First 1
    & $command.Source @args
    return
  }
  Invoke-ClausonaTool -Tool codex -ToolArgs $args
}

Set-Alias -Name csn -Value clausona -Scope Global
`;
}

export function renderShellInit(platform: NodeJS.Platform = process.platform) {
  return platform === "win32" ? renderPowerShellInit() : renderPosixShellInit();
}
