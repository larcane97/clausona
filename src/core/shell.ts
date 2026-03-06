export function renderShellInit() {
  return `# clausona shell integration
_clausona_resolve_config() {
  local pfile="$HOME/.clausona/profiles.json"
  [[ -f "$pfile" ]] || return

  local result
  result=$(node -e "
const fs = require('fs');
try {
  const d = JSON.parse(fs.readFileSync('$pfile', 'utf8'));
  const p = d.activeProfile || '';
  if (p && d.profiles && d.profiles[p]) {
    const profile = d.profiles[p];
    const configDir = profile.configDir || '';
    const isPrimary = profile.isPrimary || false;
    const resolved = fs.realpathSync(configDir);
    const defaultClaude = fs.realpathSync(require('os').homedir() + '/.claude');
    if (isPrimary || resolved === defaultClaude) {
      console.log('__PRIMARY__');
    } else {
      console.log(configDir);
    }
  }
} catch {}
" 2>/dev/null)
  if [[ "\$result" == "__PRIMARY__" ]]; then
    unset CLAUDE_CONFIG_DIR
  elif [[ -n "\$result" ]]; then
    export CLAUDE_CONFIG_DIR="\$result"
  fi
}

claude() {
  if [[ -z "\${CLAUDE_CONFIG_DIR:-}" ]]; then
    _clausona_resolve_config
  fi
  command claude "\$@"
  local rc=\$?
  unset CLAUDE_CONFIG_DIR
  clausona _track-usage 2>/dev/null
  return \$rc
}

alias csn=clausona
`;
}
