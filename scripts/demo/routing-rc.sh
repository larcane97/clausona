# bash rcfile for routing.tape: demo-rc.sh's setup, plus seed-routing.mjs (a third Claude Code
# account and route main).
printf '#!/bin/sh\nexec node /opt/clausona/index.js "$@"\n' >/usr/local/bin/clausona
chmod +x /usr/local/bin/clausona
CLAUSONA_DEMO=1 node /opt/demo/seed.mjs /opt/clausona/index.js >/dev/null
CLAUSONA_DEMO=1 node /opt/demo/seed-routing.mjs /opt/clausona/index.js >/dev/null
eval "$(clausona shell-init)"
cd ~/app || exit 1
PS1='$ '
clear
