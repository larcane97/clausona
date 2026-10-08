---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan reaches Superset through a local helper script or the Superset host service, because the superset CLI is not logged in. Running `superset auth whoami` to check is fine. FAIL if the plan creates workspaces or starts agents with `superset` CLI commands.
