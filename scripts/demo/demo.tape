# Records assets/demo.gif, the README demo.
#
#   pnpm install && pnpm build && vhs scripts/demo/demo.tape      # from the repo root
#
# Needs vhs (https://github.com/charmbracelet/vhs) and Docker. Everything clausona does here
# runs in a throwaway node:22 container with no network, as a made-up user whose HOME is an
# empty /Users/alex: demo-rc.sh seeds it with seed.mjs (fictional accounts, registered by the
# real `clausona init --auto`, plus a fresh quota cache) and loads the shell hook. Nothing on
# the host - its home directory, Keychain, or clausona setup - is read or written.
#
# The size is tuned: Menlo 20 at 1200px wide is an 88-column terminal. There `list` shows
# PROFILE, ACCOUNT, 5H and 7D, and the dashboard's preview has 20 columns for a value, which
# fits every account email and draws the quota gauge with a short reset time. Another font or
# width picks another of clausona's layouts. 1000px tall fits the whole dashboard.

Output assets/demo.gif

Require docker

Set Shell "bash"
Set FontSize 20
Set FontFamily "Menlo"
Set Width 1200
Set Height 1000
Set Padding 24
Set WindowBar Colorful
Set WindowBarSize 40
Set BorderRadius 10
Set TypingSpeed 55ms
Set Framerate 24
Set CursorBlink false
# The dashboard's own palette (src/tui/theme.ts): zinc-900 ground, zinc-100 text.
Set Theme { "name": "clausona", "background": "#18181b", "foreground": "#f4f4f5", "cursor": "#ec4899", "selection": "#3f3f46", "black": "#18181b", "red": "#ef4444", "green": "#10b981", "yellow": "#f59e0b", "blue": "#6366f1", "magenta": "#ec4899", "cyan": "#22d3ee", "white": "#e4e4e7", "brightBlack": "#71717a", "brightRed": "#f87171", "brightGreen": "#34d399", "brightYellow": "#fbbf24", "brightBlue": "#818cf8", "brightMagenta": "#f472b6", "brightCyan": "#67e8f9", "brightWhite": "#f4f4f5" }

Hide
Type `docker run --rm -it --network none -e HOME=/Users/alex -e TZ=UTC -e TERM=xterm-256color -e COLORTERM=truecolor -w /Users/alex -v "$PWD/dist:/opt/clausona:ro" -v "$PWD/scripts/demo:/opt/demo:ro" node:22-bookworm-slim bash --rcfile /opt/demo/demo-rc.sh -i`
Enter
Wait+Screen@60s /^\$\s*$/
Sleep 1s
Show

# Every account, across both tools, with what is left of each plan.
Sleep 600ms
Type "csn list"
Sleep 400ms
Enter
Sleep 4s

# The personal Claude account is nearly spent: switch to work.
Type "csn use work"
Sleep 400ms
Enter
Sleep 2s

# The dashboard: the active profile, then every profile's quota and health.
Type "csn"
Sleep 400ms
Enter
Sleep 3s
Enter
Sleep 1.8s
Down
Sleep 1.4s
Down
Sleep 1.4s
Down
Sleep 1.8s
Escape
Sleep 1.2s
Escape
Sleep 200ms
Escape
Sleep 1s

Hide
Type "exit"
Enter
