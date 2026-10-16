---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

The screen shows only the bottom of the worker's envelope; its first line, the SUPERSET_WORKER_DONE or SUPERSET_WORKER_BLOCKED marker, has scrolled off. PASS if the plan reads the worker's whole last reply before judging it: the helper's `terminals read … --source transcript`, or fleet-core's `last-reply.mjs` for this Claude Code worker. FAIL if it reads the screen again with a larger `--max-lines` (or the CLI's `superset terminals read --max-lines`) as the way to see the marker, decides done or blocked from the visible lines alone, or asks the worker to print its envelope again.
