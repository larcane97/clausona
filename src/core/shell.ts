import type { ToolName } from "../types.js";
import type { LaunchFormat } from "./launch-cache.js";

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
 * A string as one POSIX shell word that means exactly itself. Single quotes are the only
 * form in which no character is special, so a value can carry `$`, backticks, `!` and
 * newlines untouched; an embedded quote is closed, escaped, and reopened.
 */
export function posixQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The first line of every POSIX launch script `_launch` prints or caches, and the only thing
 * the hook evals; see renderPosixShellInit. A comment, so it does nothing when eval'd.
 */
export const LAUNCH_MARKER = "# clausona launch";

/**
 * Emits the environment one run needs: a guard over every name the profile must control,
 * then the `unset`s, then `export KEY='VALUE'` lines. The hook evals all of it inside its
 * subshell, so the caller's own shell is untouched.
 *
 * The guard is for a variable the user made `readonly`, which can be neither unset nor
 * exported. Without it both shells fail the wrong way: bash reports the error and carries
 * on, so the tool runs with the caller's credential next to the profile's endpoint, while
 * zsh abandons the rest of the eval, so the tool runs on the default account. An API
 * profile launches only if every name it sets or clears ends up exactly as it says, so the
 * guard probes them all first and, on failure, names each stuck one and ends the hook's
 * subshell before the tool starts.
 *
 * One `unset` of every name in one throwaway subshell is the whole cost on the common path
 * - one fork per launch, not one per name. A failure re-probes each name on its own, which
 * only happens on the run that is about to refuse anyway.
 *
 * Single quotes are the only POSIX form in which no character is special, so a value can
 * carry `$`, backticks, and newlines untouched; an embedded quote is closed, escaped, and
 * reopened.
 *
 * The key has no such escape - it is interpolated bare - so a key carrying `;` or `$(...)`
 * would turn into extra commands in the `eval` that consumes this output. Callers validate
 * keys before they get here; this filter is the last line of defence for one that did not,
 * and it applies to the guarded and unset names too, though today they are constants.
 */
export function renderPosixExports(
  env: Record<string, string>,
  unset: readonly string[] = [],
  guard: readonly string[] = [],
): string {
  const cleared = unset.filter((key) => isPosixEnvName(key));
  // Everything the profile must control: what it clears, and what the caller passed as also
  // needing to be settable. Duplicates would only make the message repeat.
  const controlled = [...new Set([...cleared, ...guard.filter((key) => isPosixEnvName(key))])];
  const lines: string[] = [];
  if (controlled.length > 0) {
    const names = controlled.join(" ");
    lines.push(
      `if ( unset ${names} ) 2>/dev/null; then :; else for _clausona_name in ${names}; do ( unset $_clausona_name ) 2>/dev/null || printf 'clausona: %s is read-only in this shell, so clausona cannot set or clear it for this profile. Not starting the tool.\\n' $_clausona_name >&2; done; exit 1; fi`,
    );
  }
  if (cleared.length > 0) lines.push(`unset ${cleared.join(" ")}`);
  for (const [key, value] of Object.entries(env)) {
    if (isPosixEnvName(key)) lines.push(`export ${key}=${posixQuote(value)}`);
  }
  return lines.join("\n");
}

/**
 * `_shell-env --json`, which the PowerShell hook reads: the profile's variables, and null for
 * each one the run must not inherit - the hook hands the value to SetEnvironmentVariable,
 * which deletes the variable for $null. With nothing to clear and nothing past ASCII, this
 * is JSON.stringify(env) exactly, so a subscription profile's output is what it was.
 *
 * ASCII only: every character past `~` is written as a `\uXXXX` escape, so the output is the
 * same bytes in every code page. PowerShell decodes a native command's output with
 * [Console]::OutputEncoding - the console's OEM code page by default, 437 or 949, not UTF-8 -
 * so a Hangul user folder in CLAUDE_CONFIG_DIR arrived as a directory that does not exist,
 * and the tool ran on a fresh account. ConvertFrom-Json decodes the escapes on 5.1 and 7 alike.
 */
export function renderJsonEnv(env: Record<string, string>, unset: readonly string[] = []): string {
  return asciiJson(jsonEnv(env, unset));
}

/** What the PowerShell hook applies: the profile's variables, and null for each one to remove. */
function jsonEnv(env: Record<string, string>, unset: readonly string[]): Record<string, string | null> {
  const cleared = Object.fromEntries(unset.map((key) => [key, null]));
  return { ...cleared, ...env };
}

/** JSON with every character past `~` written as a `\uXXXX` escape; see renderJsonEnv. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * The absolute paths a hook is rendered with: where this version keeps each tool's launch
 * script in each format and, for the POSIX script, the link to the registry it was rendered
 * from; and the registry itself.
 */
export type ShellInitPaths = {
  cachePath: (tool: ToolName, format: LaunchFormat) => string;
  refPath: (tool: ToolName) => string;
  registryPath: string;
  /**
   * The home directory the paths above were derived from: HOME on POSIX, USERPROFILE on
   * Windows, which is where Node's homedir() reads it. A run under another one - `HOME=/tmp/x
   * claude` - is not a run these paths describe, so it goes to `_launch`, which looks where
   * that home says, as the hook always did.
   */
  home: string;
};

/** Where the plugin sync last left its stamp, and the paths that make it stale. */
export type PluginSyncCheck = { stamp: string; watch: string[] };

/** profiles.json's LastWriteTimeUtc.Ticks and Length when the script was rendered. */
export type RegistryStampJson = { ticks: string; length: string };

/**
 * `_launch <tool> --json`, which the new PowerShell hook reads: the environment exactly as
 * renderJsonEnv spells it, under `env`; for claude the plugin sync's stamp and watch list
 * under `sync`, so the hook can tell for itself whether a sync is due; and the registry it was
 * rendered from under `registry`, which a cached copy must still match. ASCII only, for the
 * same code-page reason as renderJsonEnv - the paths in `sync` sit under the same user folder.
 */
export function renderLaunchJson(
  env: Record<string, string>,
  unset: readonly string[],
  sync: PluginSyncCheck | undefined,
  registry?: RegistryStampJson,
): string {
  const document: { env: Record<string, string | null>; sync?: PluginSyncCheck; registry?: RegistryStampJson } = {
    env: jsonEnv(env, unset),
  };
  if (sync) document.sync = sync;
  if (registry) document.registry = registry;
  return asciiJson(document);
}

/**
 * The wrapper evals the launch script - the whole environment a run needs, and for claude the
 * plugin check - inside a subshell, so the variables live exactly as long as the tool does.
 * Nothing is unset by hand: there is no ledger of what was set to drift out of date, and a
 * value the user exported in their own profile is untouched when the call returns.
 *
 * The script comes from the launch cache when there is one it can trust, and from
 * `clausona _launch <tool>` otherwise, which also caches it when it can. Trusted means that
 * profiles.json exists, is the very file the script was rendered from - `-ef` its ref, the
 * hard link written with the script - and is older than the script. Every registry save
 * deletes the cache anyway; the ref also catches a delete that failed and a backup moved back
 * over profiles.json, and the time an edit of the file in place. Equal times are refused,
 * since a filesystem that keeps whole seconds cannot order two writes in one. The file is
 * read by the shell itself - `$(<file)` - so the common path starts no process before the
 * tool, and a read that fails, a cache deleted since the check, falls through to `_launch`
 * rather than to no profile at all.
 *
 * The paths are absolute and baked in when `shell-init` runs, so finding them costs nothing
 * either; a hook only ever reads the cache its own version writes. So is HOME, and a run
 * under another one (`HOME=/tmp/x claude`) skips the cache: the baked paths are not that
 * home's, and `_launch` looks where it says.
 *
 * Nothing is eval'd unless it starts with LAUNCH_MARKER, which every launch script does. A
 * clausona older than `_launch` - after a downgrade, with this hook still in a shell - answers
 * it with its usage text on stdout and exit 0, and eval'ing that would run its words as
 * commands. Without the marker the tool starts with no profile applied, as it would with
 * clausona gone from PATH; a cache that somehow lacks it goes to `_launch` first. When
 * `_launch` did print something - that usage, or a wrapper's banner on stdout - the hook says
 * on stderr that it is starting the tool without a profile, rather than letting it run on the
 * default account unannounced. Nothing printed at all stays silent, as clausona gone does.
 *
 * Two rules the generated script must keep:
 * - no `!` inside a double-quoted string, because zsh history-expands it when the function
 *   is *defined*, which breaks sourcing the init for every user at shell startup - so the
 *   baked paths, which can hold one, are single-quoted and never double-quoted;
 * - no credential on a command line (`env KEY=VALUE cmd`), because `ps` shows it to every
 *   user on the machine. The eval keeps secrets inside the subshell's own environment.
 */
export function renderPosixShellInit(paths: ShellInitPaths) {
  const home = posixQuote(paths.home);
  const registry = posixQuote(paths.registryPath);
  // A pattern: the quoted marker, then anything.
  const marked = `${posixQuote(LAUNCH_MARKER)}*`;
  // The first lines of the subshell for one tool: its launch script, from the cache or not.
  const launch = (tool: ToolName) => {
    const cache = posixQuote(paths.cachePath(tool, "posix"));
    const ref = posixQuote(paths.refPath(tool));
    return `    _clausona_launch=
    if [[ $HOME == ${home} && -f ${registry} && ${registry} -ef ${ref} && ${cache} -nt ${registry} ]]; then
      { _clausona_launch=$(<${cache}); } 2>/dev/null
    fi
    if [[ $_clausona_launch != ${marked} ]]; then
      _clausona_launch=$(clausona _launch ${tool})
    fi
    if [[ $_clausona_launch == ${marked} ]]; then
      eval "$_clausona_launch"
    elif [[ -n $_clausona_launch ]]; then
      printf 'clausona: unexpected output from clausona _launch; starting ${tool} without a profile\\n' >&2
    fi`;
  };
  return `# clausona shell integration
unalias claude 2>/dev/null
claude() {
  # An explicit CLAUDE_CONFIG_DIR means the user is driving; clausona steps aside.
  if [[ -n "\${CLAUDE_CONFIG_DIR:-}" ]]; then
    command claude "$@"
    return $?
  fi
  (
${launch("claude")}
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
${launch("codex")}
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
 * The environment comes from the launch cache when there is a script it can trust - the
 * `.json` one, strictly newer than an existing profiles.json, the same rule as the POSIX
 * hook - and from `clausona _launch <tool> --json` otherwise. A hit starts no process before
 * the tool; for claude the hook then does the plugin check the POSIX script carries, from
 * the script's `sync` block, and runs `_sync-plugins` only when it is due.
 *
 * The cache and registry paths are baked in when `shell-init` runs, as ASCII-only literals
 * (see powerShellLiteral), because the profile reads the hook as a native command's output.
 *
 * Targets Windows PowerShell 5.1, so no null-coalescing and no ternary operator.
 */
export function renderPowerShellInit(paths: ShellInitPaths) {
  const claudeCache = powerShellLiteral(paths.cachePath("claude", "json"));
  const codexCache = powerShellLiteral(paths.cachePath("codex", "json"));
  const registry = powerShellLiteral(paths.registryPath);
  const home = powerShellLiteral(paths.home);
  return `# clausona PowerShell integration
function global:Invoke-ClausonaTool {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("claude", "codex")][string]$Tool,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$ToolArgs
  )

  # $env: is process-global here, so the previous values are captured and restored.
  $applied = @{}
  # A caller's $ErrorActionPreference = 'Stop' must not let a clausona step cut the run short.
  # 5.1 turns each line a native command writes to a redirected stderr into an error record,
  # so under Stop the first warning would throw - here, before $raw is assigned; 7.3+ can do
  # the same to a non-zero exit. Every clausona step below runs under Continue; only the tool
  # itself gets the caller's own preference back.
  $callerErrorAction = $ErrorActionPreference
  $ErrorActionPreference = "Continue"

  # The launch script clausona cached for this profile, while profiles.json is exactly the
  # file it was rendered from: the same write time, to the tick, and the same length. A save
  # changes the time, and so does a backup moved back over the file, however old. A run under
  # another USERPROFILE is not one these paths describe, and skips the cache. Every step is
  # told to stop on an error, and caught: a cache that cannot be read - deleted by a save in
  # another window between the check and the read, say - is a miss, never a run with no
  # profile, and never an error printed in the caller's console.
  $parsed = $null
  if ($Tool -eq "claude") {
    $cachePath = ${claudeCache}
  } else {
    $cachePath = ${codexCache}
  }
  $registryPath = ${registry}
  $clausonaHome = ${home}
  try {
    if (($env:USERPROFILE -eq $clausonaHome) -and (Test-Path -LiteralPath $cachePath) -and (Test-Path -LiteralPath $registryPath)) {
      $registryItem = Get-Item -LiteralPath $registryPath -ErrorAction Stop
      $parsed = Get-Content -LiteralPath $cachePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
      $sameTicks = $parsed.registry.ticks -eq [string]$registryItem.LastWriteTimeUtc.Ticks
      $sameLength = $parsed.registry.length -eq [string]$registryItem.Length
      if (-not ($sameTicks -and $sameLength)) { $parsed = $null }
    }
  } catch {
    $parsed = $null
  }

  if (-not $parsed) {
    # A warning from _launch means a persistent misconfiguration - a credential that will
    # not resolve, a key clausona cannot export - so it has to reach the user on every run,
    # exactly as it does on POSIX. stderr cannot be merged into stdout, which carries the
    # JSON, and 5.1 cannot split a native command's streams inline; so stderr goes to a temp
    # file and is replayed to the console afterwards.
    #
    # Creating that file is the one step that can fail before the lookup runs, so it is
    # guarded and the lookup has a branch for each outcome. Losing the warnings is bad;
    # running the tool against the default account without saying so would be worse, and
    # that is what a lookup skipped over a temp file would cause. Exactly one branch runs,
    # so a miss still makes exactly one _launch call.
    $stderrPath = $null
    try {
      $stderrPath = [System.IO.Path]::GetTempFileName()
    } catch {
      $stderrPath = $null
    }
    try {
      if ($stderrPath) {
        $raw = & clausona _launch $Tool --json 2>$stderrPath
      } else {
        $raw = & clausona _launch $Tool --json 2>$null
      }
      if ($raw) { $parsed = $raw | ConvertFrom-Json }
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
  }

  try {
    if ($parsed) {
      foreach ($property in $parsed.env.PSObject.Properties) {
        $name = $property.Name
        $applied[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
        [Environment]::SetEnvironmentVariable($name, $property.Value, "Process")
      }
    }
  } catch {
    # Nor must applying it. Whatever was applied before a throw is restored below.
  }

  try {
    # Still under Continue, and caught, so neither a warning from the sync nor a clausona that
    # has gone from PATH can stop the tool from starting.
    #
    # The sync is due when its stamp is missing or anything it watches is at least as new as
    # the stamp - the stamp's time is taken before the sync reads, so a change in the same
    # tick is one it may have missed - and when the check itself fails: syncing once too often
    # costs a second, missing a plugin costs a broken session. With no launch script at all there is nothing to check, and nothing is
    # synced - as on POSIX, where the check is part of the script.
    if ($Tool -eq "claude") {
      $syncDue = $false
      try {
        if ($parsed) {
          if ($parsed.sync) {
            $syncDue = $true
            if (Test-Path -LiteralPath $parsed.sync.stamp) {
              $stampTime = (Get-Item -LiteralPath $parsed.sync.stamp -ErrorAction Stop).LastWriteTimeUtc
              $syncDue = $false
              foreach ($watched in $parsed.sync.watch) {
                if (Test-Path -LiteralPath $watched) {
                  if ((Get-Item -LiteralPath $watched -ErrorAction Stop).LastWriteTimeUtc -ge $stampTime) { $syncDue = $true }
                }
              }
            }
          }
        }
      } catch {
        $syncDue = $true
      }
      if ($syncDue) {
        try { clausona _sync-plugins *> $null } catch { }
      }
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

/**
 * A string as a PowerShell expression that evaluates to exactly it, in ASCII alone.
 *
 * The profile runs the hook as `Invoke-Expression (& clausona shell-init | Out-String)`, and
 * PowerShell decodes a native command's output in the console's code page - 437 or 949, not
 * UTF-8 - so a path under a Hangul user folder, baked in as UTF-8, would name a folder that
 * does not exist. So every character past ASCII, and every control character, is spelled as
 * a `[char]`, which reads the same in every code page. That also takes care of the curly
 * quotes PowerShell accepts as single quotes, which could otherwise end the literal early.
 * The ASCII runs are single-quoted, where nothing but `'` is special, and that is doubled.
 *
 * The concatenation always starts from a string, because `[char] + [char]` adds numbers.
 */
export function powerShellLiteral(value: string): string {
  const parts: string[] = [];
  let run = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0x20 && code <= 0x7e) {
      run += value[i] === "'" ? "''" : value[i];
      continue;
    }
    if (run !== "" || parts.length === 0) parts.push(`'${run}'`);
    run = "";
    parts.push(`[char]0x${code.toString(16).padStart(4, "0")}`);
  }
  if (run !== "" || parts.length === 0) parts.push(`'${run}'`);
  return parts.length === 1 ? (parts[0] as string) : `(${parts.join(" + ")})`;
}

export function renderShellInit(platform: NodeJS.Platform, paths: ShellInitPaths) {
  return platform === "win32" ? renderPowerShellInit(paths) : renderPosixShellInit(paths);
}
