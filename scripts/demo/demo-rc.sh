# bash rcfile for the demo container; demo.tape starts `bash --rcfile` on it, off camera.
# It puts `clausona` on PATH, seeds the fictional accounts, and loads the shell hook the
# installer would add to ~/.bashrc - so `csn` and the claude/codex wrappers exist.

printf '#!/bin/sh\nexec node /opt/clausona/index.js "$@"\n' >/usr/local/bin/clausona
chmod +x /usr/local/bin/clausona

CLAUSONA_DEMO=1 node /opt/demo/seed.mjs /opt/clausona/index.js >/dev/null

eval "$(clausona shell-init)"

cd ~ || exit 1
PS1='$ '
clear
