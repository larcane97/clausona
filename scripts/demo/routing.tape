# Records the README's routing GIF: vhs writes scripts/demo/.build/routing-raw.gif, and outline.py
# outlines what proves the pick in it and writes assets/routing.gif.
#
#   pnpm install && pnpm build                 # from the repo root
#   vhs scripts/demo/routing.tape              # records .build/routing-raw.gif
#   python3 scripts/demo/outline.py routing    # writes assets/routing.gif (needs ffmpeg and Pillow)
#
# Same image, throwaway container and made-up user as demo.tape (see the comment there): nothing on
# the host is read or written. routing-rc.sh seeds the home with seed.mjs, then seed-routing.mjs
# adds a third Claude Code account, `team`, and makes route `main` with the real
# `clausona route add main`, off camera: the GIF starts from a route that is already there.
# Of its three accounts, personal is over the 80% cut and work and team are under it, with work
# the emptier one, so the route takes work first and team next.
#
# The story: `route explain main` says who would be picked and why; `run --route main` says on one
# line which account it took, and Claude Code opens on it - its /status names the account; the same
# command again takes the next account in turn. The second Claude Code is quit at once: its line
# says which account it is, and the two lines stand together at the end.
#
# As in demo.tape, only waiting happens off camera, between Hide and Show: for `route explain` to
# print, for Claude Code to start and draw, for the shell prompt after it quits, and for Claude
# Code to redraw after Enter or Escape, which a frame can catch half done. Every command is typed
# on camera, and every screen the GIF shows follows from what was typed. The run's line shows for
# a moment before Claude Code's fullscreen renderer takes the terminal, then again when it hands
# it back. On a busy machine a take can still catch a half-drawn frame next to a cut: look through
# the frames of .build/routing-raw.gif, and record again if one does.
#
# The container gets half a CPU, so Claude Code starts slowly enough for the run's line to be read
# before it takes the terminal (see below). It is named clausona-demo-routing. A run cut short can
# leave it behind, and the next one then cannot start: `docker rm -f clausona-demo-routing`
# removes it.
#
# The size: Menlo 20 at 1200px wide is the 88-column terminal of demo.tape, where `route explain`
# fits with room to spare, and 760px tall is 27 rows: the whole story in the shell takes 23, and
# Claude Code's /status panel fits with its rows where demo.tape has them. A different font or size
# moves what outline.py outlines.

Output scripts/demo/.build/routing-raw.gif

Require docker

Set Shell "bash"
Set FontSize 20
Set FontFamily "Menlo"
Set Width 1200
Set Height 760
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
Type `docker build -q -t clausona-demo scripts/demo >/dev/null && docker run --rm -it --name clausona-demo-routing --cpus 0.5 --network none -e HOME=/Users/alex -e TZ=UTC -e TERM=xterm-256color -e COLORTERM=truecolor -w /Users/alex -v "$PWD/dist:/opt/clausona:ro" -v "$PWD/scripts/demo:/opt/demo:ro" clausona-demo bash --rcfile /opt/demo/routing-rc.sh -i`
Enter
Wait+Screen@300s /^\$\s*$/
Sleep 1s
Show

# Who the route would pick now, and why: personal is over 80%, work is next in turn.
Sleep 500ms
Type "clausona route explain main"
Sleep 300ms
Enter
# Cut to the whole answer: it is printed in two parts, and a frame between them would show half.
Hide
Wait+Screen@60s /over 80%[\s\S]*\n\$\s*$/
Sleep 300ms
Show
# outline.py lets the table stand on its own, then outlines the accounts until the next command.
Sleep 3.4s

# Run on the route: one line says which account, then Claude Code opens on it.
Type "clausona run --route main"
Sleep 300ms
Enter
Wait+Screen@60s /claude:work\s+route main/
# Claude Code takes the terminal a moment after the line, and draws its first frames half done; the
# cut starts before that. On the container's half a CPU that moment is long enough to read the
# line; on a whole one, with vhs catching few frames while Claude Code starts, the line would only
# flash by. It shows again when the shell comes back.
Sleep 1.6s
Hide
Wait+Screen@120s /Claude Max/
# Its logo animates in after the header is drawn, on half a CPU up to a few seconds later.
Sleep 4s
# The first frame after a long cut has at times held bits of the screen before it. A screenshot
# taken off camera just before the cut ends has the terminal draw the screen it has now.
Screenshot scripts/demo/.build/routing-flush.png
Sleep 300ms
Show
Sleep 800ms
# Typed where the viewer can read it; the command menu narrows to /status as it goes.
Type@90ms "/status"
Sleep 500ms
# Enter and Escape each redraw the whole screen, and a frame taken while the terminal is still
# writing it shows it half drawn, so each is pressed in a short cut: the frames on either side are
# the screen before the key and the screen it drew.
Hide
Enter
Wait+Screen@60s /Email:/
Sleep 200ms
Show
# outline.py lets the panel stand on its own for a moment, then fades in an outline around the
# account rows and keeps it until the panel closes.
Sleep 3.3s
Hide
Escape
Wait+Screen@60s /for agents/
Sleep 200ms
Show
Sleep 500ms
Type@90ms "/exit"
Sleep 400ms
# The shell comes back with its earlier lines, the run's line among them. The prompt can take a
# moment to be drawn after the lines.
Hide
Enter
Wait+Screen@60s /\n\$\s*$/
Sleep 1s
Screenshot scripts/demo/.build/routing-flush.png
Sleep 300ms
Show
Sleep 1.3s

# The same command again: the next account in turn.
Type "clausona run --route main"
Sleep 300ms
Enter
Wait+Screen@60s /claude:team\s+route main/
Sleep 1.6s
Hide
Wait+Screen@120s /Claude Max/
Sleep 4s
Screenshot scripts/demo/.build/routing-flush.png
Sleep 300ms
Show
Sleep 800ms
Type@90ms "/exit"
Sleep 400ms
Hide
Enter
Wait+Screen@60s /\n\$\s*$/
Sleep 1s
Screenshot scripts/demo/.build/routing-flush.png
Sleep 300ms
Show
# outline.py outlines the two runs and their lines, which stand to the end.
Sleep 3.4s

Hide
Type "exit"
Enter
