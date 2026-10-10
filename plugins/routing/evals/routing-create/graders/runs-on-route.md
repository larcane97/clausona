---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan creates the route with `clausona route add` (not by writing `~/.clausona/routes.json` or with `clausona route edit`), and runs the tests through the route with the routing options before the tool's own arguments: `clausona run --route <name> -- -p "…"` (the `--` may be left out, and `clausona run claude --route <name> …` is fine too), or `clausona route pick <name>` followed by `clausona run <picked profile> -- -p "…"`. FAIL if it edits routes.json, runs the tests on a profile it chose by name without going through the route, or puts routing options after the tool's arguments.
