#!/usr/bin/env bash
set -euo pipefail

APP_NAME="clausona"
REPO="larcane97/clausona"
VERSION="${1:-latest}"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/clausona"
INSTALL_DIR="/usr/local/bin"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

echo ""
echo -e "  ${BOLD}clausona installer${RESET}"
echo ""

# Find Node >= 20.
# PATH is walked directly rather than through `which -a`: `which` is an external
# command under bash and is absent from minimal Linux images (Debian ships it in
# debianutils), while busybox's does not accept -a. Either way the lookup returned
# nothing and the installer reported a missing Node on machines that had one.
NODE_BIN=""
NODE_FOUND=""
IFS=: read -ra path_dirs <<< "$PATH"
for dir in "${path_dirs[@]}"; do
  [[ -n "$dir" ]] || continue
  candidate="$dir/node"
  [[ -f "$candidate" && -x "$candidate" ]] || continue
  ver=$("$candidate" -e "console.log(process.versions.node.split('.')[0])" 2>/dev/null || echo "0")
  [[ "$ver" =~ ^[0-9]+$ ]] || ver="0"
  if [[ "$ver" -ge 20 ]]; then
    NODE_BIN="$candidate"
    break
  fi
  # Remember the first too-old install so the failure can name what it found.
  if [[ -z "$NODE_FOUND" && "$ver" -gt 0 ]]; then
    NODE_FOUND="$("$candidate" --version 2>/dev/null) at $candidate"
  fi
done

if [[ -z "$NODE_BIN" ]]; then
  echo -e "  ${RED}✗${RESET} Node.js >= 20 is required but not found."
  echo -e "  ${CYAN}Found: ${NODE_FOUND:-no node on PATH}${RESET}"
  echo ""
  echo -e "  Install Node 20 or newer, then re-run this installer:"
  echo -e "    macOS    ${CYAN}brew install node${RESET}"
  echo -e "    Linux    ${CYAN}https://github.com/nodesource/distributions${RESET}"
  echo -e "    any OS   ${CYAN}https://nodejs.org/en/download${RESET}"
  echo ""
  echo -e "  Using nvm, fnm or asdf? ${CYAN}curl ... | bash${RESET} does not read your shell"
  echo -e "  profile, so activate the version manager before running this."
  exit 1
fi

echo -e "  Using node: $NODE_BIN ($($NODE_BIN --version))"

if ! command -v claude &>/dev/null && ! command -v codex &>/dev/null; then
  echo -e "  ${RED}✗${RESET} Claude Code CLI or OpenAI Codex CLI is required but neither was found."
  echo ""
  echo -e "  Install one of them, then re-run this installer:"
  echo -e "    Claude Code  ${CYAN}https://docs.anthropic.com/en/docs/claude-code${RESET}"
  echo -e "    Codex CLI    ${CYAN}https://github.com/openai/codex${RESET}"
  echo ""
  echo -e "  Already installed? It must be a real executable on PATH - a shell alias"
  echo -e "  or function is not visible to ${CYAN}curl ... | bash${RESET}."
  exit 1
fi

# Determine install directory
if EXISTING_PATH="$(command -v "$APP_NAME" 2>/dev/null)"; then
  INSTALL_DIR="$(dirname "$EXISTING_PATH")"
elif [[ -d "$HOME/.local/bin" ]]; then
  INSTALL_DIR="$HOME/.local/bin"
fi

TARGET_PATH="$INSTALL_DIR/$APP_NAME"

# Download URL
if [[ "$VERSION" == "latest" ]]; then
  DOWNLOAD_URL="https://github.com/$REPO/releases/latest/download/clausona.js"
else
  DOWNLOAD_URL="https://github.com/$REPO/releases/download/$VERSION/clausona.js"
fi

echo -e "  Downloading clausona${VERSION:+ ($VERSION)}..."
mkdir -p "$APP_DIR"
if ! curl -fsSL "$DOWNLOAD_URL" -o "$APP_DIR/index.js"; then
  echo -e "  ${RED}✗${RESET} Download failed. Check the version or try again."
  exit 1
fi

# Create launcher
LAUNCHER="$(mktemp)"
cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
set -euo pipefail

exec "$NODE_BIN" "$APP_DIR/index.js" "\$@"
EOF

echo -e "  Installing launcher to $TARGET_PATH..."
if [[ "$INSTALL_DIR" == "$HOME"* ]]; then
  mkdir -p "$INSTALL_DIR"
  cp "$LAUNCHER" "$TARGET_PATH"
  chmod +x "$TARGET_PATH"
else
  sudo mkdir -p "$INSTALL_DIR"
  sudo cp "$LAUNCHER" "$TARGET_PATH"
  sudo chmod +x "$TARGET_PATH"
fi

rm -f "$LAUNCHER"

echo -e "  ${GREEN}✓${RESET} Installed: $TARGET_PATH"

SHELL_INIT_LINE='eval "$(clausona shell-init)"'
RC_FILE=""

if [[ -n "${ZSH_VERSION:-}" ]] || [[ "$SHELL" == */zsh ]]; then
  RC_FILE="$HOME/.zshrc"
elif [[ -n "${BASH_VERSION:-}" ]] || [[ "$SHELL" == */bash ]]; then
  RC_FILE="$HOME/.bashrc"
fi

if [[ -n "$RC_FILE" ]]; then
  if [[ -f "$RC_FILE" ]] && grep -qF "clausona shell-init" "$RC_FILE"; then
    echo -e "  ${GREEN}✓${RESET} Shell integration already in $RC_FILE"
  else
    echo "" >> "$RC_FILE"
    echo "$SHELL_INIT_LINE" >> "$RC_FILE"
    echo -e "  ${GREEN}✓${RESET} Added shell integration to $RC_FILE"
  fi
else
  echo -e "  ${CYAN}!${RESET} Could not detect shell rc file."
  echo -e "    Add manually: ${CYAN}${SHELL_INIT_LINE}${RESET}"
fi

echo ""
echo -e "  ${GREEN}${BOLD}Done!${RESET} Open a new terminal, then run:"
echo -e "    ${CYAN}clausona init${RESET}"
echo ""
