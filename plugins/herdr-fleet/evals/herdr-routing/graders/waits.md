---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan sends each brief line with `herdr agent prompt <name> ... --wait` (or otherwise waits with herdr's own agent wait commands, run in the background in Claude Code) and reads replies with `herdr agent read`. FAIL if it writes its own loop that greps screens for a phrase, or ends without any wait.
