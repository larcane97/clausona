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
 * Emits `export KEY='VALUE'` lines. Single quotes are the only POSIX form in which no
 * character is special, so a value can carry `$`, backticks, and newlines untouched; an
 * embedded quote is closed, escaped, and reopened.
 *
 * The key has no such escape - it is interpolated bare - so a key carrying `;` or `$(...)`
 * would turn into extra commands in the `eval` that consumes this output. Callers validate
 * keys before they get here; this filter is the last line of defence for one that did not,
 * and it drops silently because a renderer has nowhere to report to.
 */
export function renderPosixExports(env: Record<string, string>): string {
  return Object.entries(env)
    .filter(([key]) => isPosixEnvName(key))
    .map(([key, value]) => `export ${key}='${value.replace(/'/g, "'\\''")}'`)
    .join("\n");
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
  try {
    $raw = & clausona _shell-env $Tool --json 2>$null
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
  }

  try {
    if ($Tool -eq "claude") { clausona _sync-plugins *> $null }
    $command = Get-Command $Tool -CommandType Application -ErrorAction Stop | Select-Object -First 1
    & $command.Source @ToolArgs
    $exitCode = $LASTEXITCODE
    if ($Tool -eq "claude") { clausona _track-usage *> $null }
    $global:LASTEXITCODE = $exitCode
  } finally {
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
