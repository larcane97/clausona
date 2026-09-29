# Records the README demo: vhs writes scripts/demo/.build/demo-raw.gif, and annotate.py outlines
# the account rows of Claude Code's /status panel in it and writes assets/demo.gif.
#
#   pnpm install && pnpm build                 # from the repo root
#   vhs scripts/demo/demo.tape                 # records .build/demo-raw.gif
#   python3 scripts/demo/annotate.py           # writes assets/demo.gif (needs ffmpeg and Pillow)
#
# Needs vhs (https://github.com/charmbracelet/vhs) and Docker. The first run builds the image in
# scripts/demo/Dockerfile (node:22 plus the real Claude Code 2.1.284, installed from npm), which
# needs the network; the container the demo is recorded in has none. Everything clausona and
# Claude Code do here happens in that throwaway container, as a made-up user whose HOME is an
# empty /Users/alex: demo-rc.sh seeds it with seed.mjs (fictional accounts, registered by the
# real `clausona init --auto`, plus a fresh quota cache) and loads the shell hook. Nothing on
# the host - its home directory, Keychain, or clausona setup - is read or written.
#
# `claude` here is the real Claude Code 2.1.284, started through clausona's shell hook, with the
# fullscreen renderer its users have (`"tui": "fullscreen"` in the shared settings.json): it takes
# the whole terminal while it runs, and the shell's lines come back when it quits. With no network
# it still opens, and its /status reads the account from the profile's own config dir.
# Only waiting happens off camera, between Hide and Show - for Claude Code or the dashboard to
# start, and for the shell prompt after Claude Code quits - so a busy machine does not stretch the
# GIF. Every keystroke that changes the screen is on camera. Every frame shown is what the
# programs drew; the only thing added afterwards is annotate.py's outline.
#
# The size is tuned: Menlo 20 at 1200px wide is an 88-column terminal. There `list` shows
# PROFILE, ACCOUNT, 5H and 7D, and the dashboard's preview has 20 columns for a value, which
# fits every account email and draws the quota gauge with a short reset time. Another font or
# width picks another of clausona's layouts, and moves the rows annotate.py outlines. 1000px
# tall fits the whole dashboard.

Output scripts/demo/.build/demo-raw.gif

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
Wait+Screen@60s /codex:team/
Sleep 2.6s

# The personal Claude account is nearly spent: switch to work, then start Claude Code as usual.
Type "csn use work"
Sleep 300ms
Enter
Wait+Screen@60s /alex@work\.example\)\s+\$/
Sleep 400ms
Type "claude"
Sleep 300ms
Enter
# Waiting for Claude Code to start is cut; nothing typed is.
Sleep 300ms
Hide
Wait+Screen@120s /Claude Max/
Show
# Claude Code's fullscreen renderer has the whole terminal: the shell's lines are gone for now.
Sleep 1s
# Typed where the viewer can read it; the command menu narrows to /status as it goes.
Type@90ms "/status"
Sleep 500ms
Enter
Wait+Screen@60s /Email:/
# annotate.py lets the panel stand on its own for a moment, then fades in an outline around
# the account rows and keeps it until the panel closes.
Sleep 4s
# The panel says "Esc to cancel"; then /exit, typed, quits.
Escape
Sleep 500ms
Type@90ms "/exit"
Sleep 400ms
Enter
# The shell comes back with its earlier lines once the hook has recorded the run's usage.
Hide
Wait+Screen@60s /\n\$\s*$/
Show
Sleep 1s

# And back: the same `claude`, now as the personal account. (`personal` alone would be
# ambiguous here - codex has a profile of that name too.)
Type "csn use claude:personal"
Sleep 300ms
Enter
Wait+Screen@60s /alex@home\.example\)\s+\$/
Sleep 400ms
Type "claude"
Sleep 300ms
Enter
# Waiting for Claude Code to start is cut; nothing typed is.
Sleep 300ms
Hide
Wait+Screen@120s /Claude Max/
Show
# Claude Code's fullscreen renderer has the whole terminal: the shell's lines are gone for now.
Sleep 1s
# Typed where the viewer can read it; the command menu narrows to /status as it goes.
Type@90ms "/status"
Sleep 500ms
Enter
Wait+Screen@60s /Email:/
# annotate.py lets the panel stand on its own for a moment, then fades in an outline around
# the account rows and keeps it until the panel closes.
Sleep 4s
# The panel says "Esc to cancel"; then /exit, typed, quits.
Escape
Sleep 500ms
Type@90ms "/exit"
Sleep 400ms
Enter
# The shell comes back with its earlier lines once the hook has recorded the run's usage.
Hide
Wait+Screen@60s /\n\$\s*$/
Show
Sleep 800ms

# Everything in one place: the dashboard, with the active account's quota and health.
Type "csn"
Sleep 300ms
Enter
Sleep 300ms
Hide
Wait+Screen@60s /Session.+96%/
Show
Sleep 2.2s
Escape
Sleep 200ms
Escape
Wait+Screen@60s /^\$\s*$/
Sleep 800ms

Hide
Type "exit"
Enter
