#!/bin/sh
# Run a fleet plugin's evals. `claude plugin eval <path>` loads one plugin, and Claude Code turns
# off a plugin whose dependency (fleet-core) is not installed, so the skill would never fire. This
# assembles one throwaway plugin holding fleet-core and the runner's skills and evals, and evaluates
# that.
#
# usage: scripts/plugin-eval.sh <superset-fleet|herdr-fleet|orca-fleet> [claude plugin eval options]
set -eu
p="$1"; shift
repo="$(cd "$(dirname "$0")/.." && pwd)"
out="$(mktemp -d "${TMPDIR:-/tmp}/plugin-eval.XXXXXX")/$p"
mkdir -p "$out/.claude-plugin" "$out/skills"
cp -R "$repo/plugins/fleet-core/skills/fleet-core" "$out/skills/"
cp -R "$repo/plugins/$p/skills/." "$out/skills/"
cp -R "$repo/plugins/$p/evals" "$out/evals"
rm -rf "$out/evals/results"
printf '{ "name": "%s", "version": "0.0.0-eval" }\n' "$p" > "$out/.claude-plugin/plugin.json"
echo "eval plugin: $out" >&2
exec claude plugin eval "$out" "$@"
