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

export function renderPosixShellInit() {
  return `# clausona shell integration
_clausona_resolve() {
  local tool=$1
  local pfile="$HOME/.clausona/profiles.json"
  [[ -f "$pfile" ]] || return

  local result
  result=$(node -e "
(function() {
const fs = require('fs');
const os = require('os');
const path = require('path');
try {
  const d = JSON.parse(fs.readFileSync('$pfile', 'utf8'));
  const tool = '$tool';
  const id = (d.activeProfiles || {})[tool] || '';
  if (id === '') { return; }
  const profile = (d.profiles || {})[id];
  if (profile === undefined) { return; }
  const configDir = profile.configDir || '';
  const isPrimary = profile.isPrimary === true;
  const defaultDir = tool === 'claude'
    ? path.join(os.homedir(), '.claude')
    : path.join(os.homedir(), '.codex');
  let resolved = configDir;
  try { resolved = fs.realpathSync(configDir); } catch {}
  let defaultResolved = defaultDir;
  try { defaultResolved = fs.realpathSync(defaultDir); } catch {}
  if (isPrimary || resolved === defaultResolved) {
    console.log('__PRIMARY__');
  } else {
    console.log(configDir);
  }
} catch {}
})();
" 2>/dev/null)
  echo "$result"
}

unalias claude 2>/dev/null
claude() {
  if [[ -z "\${CLAUDE_CONFIG_DIR:-}" ]]; then
    local r
    r=$(_clausona_resolve claude)
    if [[ "$r" == "__PRIMARY__" ]]; then
      :
    elif [[ -n "$r" ]]; then
      export CLAUDE_CONFIG_DIR="$r"
    fi
  fi
  clausona _sync-plugins 2>/dev/null
  command claude "$@"
  local rc=$?
  unset CLAUDE_CONFIG_DIR
  clausona _track-usage 2>/dev/null
  return $rc
}

unalias codex 2>/dev/null
codex() {
  if [[ -z "\${CODEX_HOME:-}" ]]; then
    local r
    r=$(_clausona_resolve codex)
    if [[ "$r" == "__PRIMARY__" ]]; then
      :
    elif [[ -n "$r" ]]; then
      export CODEX_HOME="$r"
    fi
  fi
  command codex "$@"
  local rc=$?
  unset CODEX_HOME
  return $rc
}

alias csn=clausona
`;
}

export function renderPowerShellInit() {
  return `# clausona PowerShell integration
function global:Get-ClausonaProfileDir {
  param([Parameter(Mandatory = $true)][ValidateSet("claude", "codex")][string]$Tool)

  $profilesPath = Join-Path $HOME ".clausona\\profiles.json"
  if (-not (Test-Path -LiteralPath $profilesPath)) { return }

  try {
    $registry = Get-Content -LiteralPath $profilesPath -Raw | ConvertFrom-Json
    $activeId = $registry.activeProfiles.$Tool
    if (-not $activeId) { return }
    $entry = $registry.profiles.PSObject.Properties[$activeId].Value
    if (-not $entry) { return }
    if ($entry.isPrimary -eq $true) {
      return "__PRIMARY__"
    }
    return $entry.configDir
  } catch {
    return
  }
}

function global:claude {
  # No param() block on purpose: it would bind arguments that look like parameter
  # names (-a matches -Arguments) instead of forwarding them. $args forwards verbatim.
  $hadConfig = Test-Path Env:CLAUDE_CONFIG_DIR
  $previousConfig = $env:CLAUDE_CONFIG_DIR
  if (-not $hadConfig) {
    $resolved = Get-ClausonaProfileDir -Tool claude
    if ($resolved -and $resolved -ne "__PRIMARY__") {
      $env:CLAUDE_CONFIG_DIR = $resolved
    }
  }

  try {
    clausona _sync-plugins *> $null
    $command = Get-Command claude -CommandType Application -ErrorAction Stop | Select-Object -First 1
    & $command.Source @args
    $exitCode = $LASTEXITCODE
    clausona _track-usage *> $null
    $global:LASTEXITCODE = $exitCode
  } finally {
    if ($hadConfig) {
      $env:CLAUDE_CONFIG_DIR = $previousConfig
    } else {
      Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
    }
  }
}

function global:codex {
  # No param() block on purpose: it would bind arguments that look like parameter
  # names (-a matches -Arguments) instead of forwarding them. $args forwards verbatim.
  $hadConfig = Test-Path Env:CODEX_HOME
  $previousConfig = $env:CODEX_HOME
  if (-not $hadConfig) {
    $resolved = Get-ClausonaProfileDir -Tool codex
    if ($resolved -and $resolved -ne "__PRIMARY__") {
      $env:CODEX_HOME = $resolved
    }
  }

  try {
    $command = Get-Command codex -CommandType Application -ErrorAction Stop | Select-Object -First 1
    & $command.Source @args
    $exitCode = $LASTEXITCODE
    $global:LASTEXITCODE = $exitCode
  } finally {
    if ($hadConfig) {
      $env:CODEX_HOME = $previousConfig
    } else {
      Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue
    }
  }
}

Set-Alias -Name csn -Value clausona -Scope Global
`;
}

export function renderShellInit(platform: NodeJS.Platform = process.platform) {
  return platform === "win32" ? renderPowerShellInit() : renderPosixShellInit();
}
