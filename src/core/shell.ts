export function renderShellInit() {
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
