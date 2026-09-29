# Takes the terminal frame for assets/social-preview.png; social-preview.py composes the card.
#
#   pnpm build && vhs scripts/demo/social.tape && python3 scripts/demo/social-preview.py
#
# Same throwaway container and fictional accounts as demo.tape (see the comment there). Its
# own outputs go to scripts/demo/.build/, which git ignores.

Output scripts/demo/.build/social.gif

Require docker

Set Shell "bash"
Set FontSize 18
Set FontFamily "Menlo"
Set Width 1000
Set Height 390
Set Padding 20
Set WindowBar Colorful
Set WindowBarSize 36
Set BorderRadius 10
Set TypingSpeed 20ms
Set CursorBlink false
Set Theme { "name": "clausona", "background": "#18181b", "foreground": "#f4f4f5", "cursor": "#ec4899", "selection": "#3f3f46", "black": "#18181b", "red": "#ef4444", "green": "#10b981", "yellow": "#f59e0b", "blue": "#6366f1", "magenta": "#ec4899", "cyan": "#22d3ee", "white": "#e4e4e7", "brightBlack": "#71717a", "brightRed": "#f87171", "brightGreen": "#34d399", "brightYellow": "#fbbf24", "brightBlue": "#818cf8", "brightMagenta": "#f472b6", "brightCyan": "#67e8f9", "brightWhite": "#f4f4f5" }

Hide
Type `docker run --rm -it --network none -e HOME=/Users/alex -e TZ=UTC -e TERM=xterm-256color -e COLORTERM=truecolor -w /Users/alex -v "$PWD/dist:/opt/clausona:ro" -v "$PWD/scripts/demo:/opt/demo:ro" node:22-bookworm-slim bash --rcfile /opt/demo/demo-rc.sh -i`
Enter
Wait+Screen@60s /^\$\s*$/
Type "csn use work"
Enter
Sleep 1s
Type "csn list"
Enter
Sleep 2s
Show
Sleep 500ms
Screenshot scripts/demo/.build/social-frame.png
Sleep 500ms

Hide
Type "exit"
Enter
