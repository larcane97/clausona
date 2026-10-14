# bash rcfile for extensions.tape: extensions-rc.sh's setup, without the two faults
# seed-extensions.mjs plants for extensions-shots.mjs's warning screens. In the README's GIF they
# would read as clausona showing errors: the `gone-helper` link to a folder that is not there (a
# red "broken link" row under Global) and web's settings.local.json that is cut off mid-object
# (`w 1 unreadable` in the hint bar).
source /opt/demo/extensions-rc.sh
rm ~/.claude/skills/gone-helper ~/web/.claude/settings.local.json
clear
