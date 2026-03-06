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

# Find Node >= 20
NODE_BIN=""
for candidate in $(which -a node 2>/dev/null); do
  ver=$("$candidate" -e "console.log(process.versions.node.split('.')[0])" 2>/dev/null || echo "0")
  if [[ "$ver" -ge 20 ]]; then
    NODE_BIN="$candidate"
    break
  fi
done

if [[ -z "$NODE_BIN" ]]; then
  echo -e "  ${RED}✗${RESET} Node.js >= 20 is required but not found."
  echo -e "  ${CYAN}Found: $(node --version 2>/dev/null || echo 'none')${RESET}"
  exit 1
fi

echo -e "  Using node: $NODE_BIN (v$($NODE_BIN -e "console.log(process.version)"))"

if ! command -v claude &>/dev/null; then
  echo -e "  ${RED}✗${RESET} claude CLI is required but not found."
  echo -e "  ${CYAN}Install: https://docs.anthropic.com/en/docs/claude-code${RESET}"
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
