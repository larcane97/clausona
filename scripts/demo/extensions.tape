# Records the README's Extensions GIF: vhs writes scripts/demo/.build/extensions-raw.gif, and
# outline.py outlines the row that is turned off, and back on, captions the keys that open a dialog,
# answer it or switch the view, and writes assets/extensions.gif.
#
#   pnpm install && pnpm build                    # from the repo root
#   vhs scripts/demo/extensions.tape              # records .build/extensions-raw.gif
#   python3 scripts/demo/outline.py extensions    # writes assets/extensions.gif (needs ffmpeg and Pillow)
#
# Same image, throwaway container and made-up user as demo.tape (see the comment there): nothing on
# the host is read or written. extensions-gif-rc.sh runs extensions-rc.sh, which seeds the home
# with seed.mjs and then seed-extensions.mjs (the skills, MCP servers, hooks and plugins, with ~/app
# as the project, as extensions-shots.mjs's screenshots have them), and then takes out the broken
# link and the unreadable settings file that seed plants for the screenshots' warning screens.
#
# The story: the dashboard's Extensions entry opens on what Claude Code loads in ~/app, grouped by
# where each skill comes from. Global's sentry-cli, last used four months ago, is turned off in this
# project with space: a dialog says what will change and asks first, and the row then reads
# `off here`. u undoes it, after asking too, and the row is back as it was. Last, 2 shows MCP and m
# its matrix of servers by account.
#
# As in demo.tape, only waiting happens off camera, between Hide and Show: for the dashboard to draw
# and take keys, for the Extensions screen to read the home, and for each key's screen to be drawn.
# The TUI redraws the whole screen on every key, and a frame taken while the terminal is still
# writing it shows it half drawn, or blank for a moment while the screen reads the home again after
# a change. So each key below is pressed in a short cut of its own: the frame before it is the
# screen the key was pressed on, and the frame after it the screen the key drew. No key's effect is
# cut, only the drawing of it. A cursor that moves shows its arrow key; the keys that open a dialog,
# answer it, undo or switch the view (enter, space, y, u, 2, m) get a caption from outline.py,
# which comes up on the frames just before the screen changes. On a busy machine a take can still
# catch a half-drawn frame: look through the frames of .build/extensions-raw.gif, and record again
# if one does.
#
# The container is named clausona-demo-extensions. A run cut short can leave it behind, and the
# next one then cannot start: `docker rm -f clausona-demo-extensions` removes it.
#
# The size: Menlo 18 at 1200px wide is a 102-column terminal, past the 100 columns from which the
# screen sets the scopes and the table side by side, and 850px tall is 35 rows, which shows the
# whole Loaded table. A different font or size picks another layout, and moves the row outline.py
# outlines.

Output scripts/demo/.build/extensions-raw.gif

Require docker

Set Shell "bash"
Set FontSize 18
Set FontFamily "Menlo"
Set Width 1200
Set Height 850
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
Type `docker build -q -t clausona-demo scripts/demo >/dev/null && docker run --rm -it --name clausona-demo-extensions --network none -e HOME=/Users/alex -e TZ=UTC -e TERM=xterm-256color -e COLORTERM=truecolor -w /Users/alex -v "$PWD/dist:/opt/clausona:ro" -v "$PWD/scripts/demo:/opt/demo:ro" clausona-demo bash --rcfile /opt/demo/extensions-gif-rc.sh -i`
Enter
Wait+Screen@300s /^\$\s*$/
Sleep 1s
Show

# The dashboard, and its Extensions entry.
Sleep 500ms
Type "clausona"
Sleep 300ms
Enter
# Cut straight to the drawn dashboard; its "Loading" screen would only flash by. It draws its rows
# a moment before it takes keys: sent at once, they can be lost.
Hide
Wait+Screen@60s /Session.+96%/
Sleep 1s
Show
Sleep 600ms
Hide
Down
Sleep 100ms
Show
Sleep 250ms
Hide
Down
Sleep 100ms
Show
Sleep 250ms
Hide
Down
Sleep 100ms
Show
Sleep 500ms
Hide
Enter
Wait+Screen@15s /\(here\)\s+\d+/
Sleep 300ms
Show

# What Claude Code loads in ~/app: the project's skills, Global, Cloud and the plugins'.
Sleep 3.8s

# Global, and in its table sentry-cli, marked unused.
Hide
Down
Wait+Screen@15s /PROJECT — /
Sleep 100ms
Show
Sleep 400ms
Hide
Down
Wait+Screen@15s /GLOBAL — /
Sleep 100ms
Show
Sleep 800ms
Hide
Right
Wait+Screen@15s /✦ changelog/
Sleep 100ms
Show
Sleep 400ms
Hide
Down
Wait+Screen@15s /✦ eli5/
Sleep 100ms
Show
Sleep 200ms
Hide
Down
Wait+Screen@15s /✦ plan-review/
Sleep 100ms
Show
Sleep 200ms
Hide
Down
Wait+Screen@15s /✦ review/
Sleep 100ms
Show
Sleep 200ms
Hide
Down
Wait+Screen@15s /✦ sentry-cli/
Sleep 100ms
Show
Sleep 700ms

# Off in this project: the dialog says what it writes, and asks first.
Hide
Space
Wait+Screen@15s /Turn off sentry-cli in this project\?/
Sleep 100ms
Show
Sleep 2.2s
# y applies it, and the screen reads the home again: the row now reads off here.
Hide
Type "y"
Wait+Screen@15s /Turned off sentry-cli in this project/
Sleep 150ms
Show
# outline.py lets the table settle, then outlines the row until the next key.
Sleep 3.5s

# And undone, after asking too.
Hide
Type "u"
Wait+Screen@15s /Undo: Turned off sentry-cli in this project\?/
Sleep 100ms
Show
Sleep 1.8s
Hide
Type "y"
Wait+Screen@15s /Undid: Turned off sentry-cli in this project/
Sleep 150ms
Show
Sleep 3.2s

# MCP servers, and which account starts each one here.
Hide
Type "2"
Wait+Screen@15s /figma/
Sleep 100ms
Show
Sleep 1.2s
Hide
Type "m"
Wait+Screen@15s /SERVER/
Sleep 100ms
Show
Sleep 3s

Hide
Ctrl+C
Wait+Screen@15s /^\$\s*$/
Type "exit"
Enter
