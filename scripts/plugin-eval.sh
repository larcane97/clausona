#!/bin/sh
# Run a fleet plugin's evals. Each fleet plugin depends on fleet-core, and Claude Code turns off a
# plugin whose dependency is not loaded, so the skill would never fire. Every fleet case therefore
# lists both plugin directories in its `plugins:` field. `claude plugin eval` loads a case's plugins
# only from under the directory it runs against, so this runs it against plugins/ and picks the
# runner's cases with --eval-dir. Both plugins load as they ship, with their own plugin.json files.
# Results go to plugins/<runner>/evals/results/, which git ignores.
#
# usage: scripts/plugin-eval.sh <superset-fleet|herdr-fleet|orca-fleet|tmux-fleet> [claude plugin eval options]
set -eu
usage="usage: scripts/plugin-eval.sh <superset-fleet|herdr-fleet|orca-fleet|tmux-fleet> [claude plugin eval options]"
[ $# -ge 1 ] || { echo "$usage" >&2; exit 2; }
p="$1"; shift
repo="$(cd "$(dirname "$0")/.." && pwd)"
[ -d "$repo/plugins/$p/evals" ] && [ -d "$repo/plugins/$p/skills" ] || { echo "no evals or skills under plugins/$p" >&2; echo "$usage" >&2; exit 2; }
exec claude plugin eval "$repo/plugins" --eval-dir "$p/evals" "$@"
