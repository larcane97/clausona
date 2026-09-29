# Records assets/demo.gif, the README demo.
#
#   pnpm install && pnpm build && vhs scripts/demo/demo.tape      # from the repo root
#
# Needs vhs (https://github.com/charmbracelet/vhs) and Docker. The first run builds the image in
# scripts/demo/Dockerfile (node:22 plus the real Claude Code 2.1.284, installed from npm), which
# needs the network; the container the demo is recorded in has none. Everything clausona and
# Claude Code do here happens in that throwaway container, as a made-up user whose HOME is an
# empty /Users/alex: demo-rc.sh seeds it with seed.mjs (fictional accounts, registered by the
# real `clausona init --auto`, plus a fresh quota cache) and loads the shell hook. Nothing on
# the host - its home directory, Keychain, or clausona setup - is read or written.
#
# `claude` here is the real Claude Code 2.1.284, started through clausona's shell hook. With no
# network it still opens, and its /status reads the account from the profile's own config dir.
# Some steps happen off camera, between Hide and Show: waiting for a program to start (Claude
# Code, the dashboard), so a busy machine does not stretch the GIF; typing /status, whose
# command menu would cover the screen; and quitting Claude Code and clearing the screen. Every
# frame shown is what the programs drew.
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
Set TypingSpeed 45ms
Set Framerate 24
Set CursorBlink false
# The dashboard's own palette (src/tui/theme.ts): zinc-900 ground, zinc-100 text.
Set Theme { "name": "clausona", "background": "#18181b", "foreground": "#f4f4f5", "cursor": "#ec4899", "selection": "#3f3f46", "black": "#18181b", "red": "#ef4444", "green": "#10b981", "yellow": "#f59e0b", "blue": "#6366f1", "magenta": "#ec4899", "cyan": "#22d3ee", "white": "#e4e4e7", "brightBlack": "#71717a", "brightRed": "#f87171", "brightGreen": "#34d399", "brightYellow": "#fbbf24", "brightBlue": "#818cf8", "brightMagenta": "#f472b6", "brightCyan": "#67e8f9", "brightWhite": "#f4f4f5" }

Hide
Type `docker build -q -t clausona-demo scripts/demo >/dev/null && docker run --rm -it --network none -e HOME=/Users/alex -e TZ=UTC -e TERM=xterm-256color -e COLORTERM=truecolor -w /Users/alex -v "$PWD/dist:/opt/clausona:ro" -v "$PWD/scripts/demo:/opt/demo:ro" clausona-demo bash --rcfile /opt/demo/demo-rc.sh -i`
Enter
Wait+Screen@300s /^\$\s*$/
Sleep 1s
Show

# Every account, across both tools, with what is left of each plan.
Sleep 500ms
Type "csn list"
Sleep 300ms
Enter
Wait+Screen@10s /codex:team/
Sleep 3s

# The personal Claude account is nearly spent: switch to work, then start Claude Code as usual.
Type "csn use work"
Sleep 300ms
Enter
Wait+Screen@10s /alex@work\.example\)\s+\$/
Sleep 400ms
Type "claude"
Sleep 300ms
Enter
Sleep 400ms
Hide
Wait+Screen@30s /Claude Max/
Show
Sleep 900ms
# /status is typed off camera (typing it pops up the command menu); its panel names the account.
Hide
Type "/status"
Sleep 300ms
Enter
Wait+Screen@10s /Email:/
Show
Sleep 3s
# Quit Claude Code and clear the screen off camera, once the hook has recorded the run's usage.
Hide
Escape
Sleep 300ms
Ctrl+C
Sleep 400ms
Ctrl+C
Wait+Screen@15s /\n\$\s*$/
Type "clear"
Enter
Sleep 300ms
Show

# And back: the same `claude`, now as the personal account. (`personal` alone would be
# ambiguous here - codex has a profile of that name too.)
Type "csn use claude:personal"
Sleep 300ms
Enter
Wait+Screen@10s /alex@home\.example\)\s+\$/
Sleep 400ms
Type "claude"
Sleep 300ms
Enter
Sleep 400ms
Hide
Wait+Screen@30s /Claude Max/
Show
Sleep 900ms
# /status is typed off camera (typing it pops up the command menu); its panel names the account.
Hide
Type "/status"
Sleep 300ms
Enter
Wait+Screen@10s /Email:/
Show
Sleep 3s
# Quit Claude Code and clear the screen off camera, once the hook has recorded the run's usage.
Hide
Escape
Sleep 300ms
Ctrl+C
Sleep 400ms
Ctrl+C
Wait+Screen@15s /\n\$\s*$/
Type "clear"
Enter
Sleep 300ms
Show

# Everything in one place: the dashboard, with the active account's quota and health.
Type "csn"
Sleep 300ms
Enter
Sleep 300ms
Hide
Wait+Screen@15s /96%/
Show
Sleep 2.5s
Escape
Sleep 200ms
Escape
Wait+Screen@10s /^\$\s*$/
Sleep 800ms

Hide
Type "exit"
Enter
