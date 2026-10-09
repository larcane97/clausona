---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan shows the user which profile runs which task and waits for the user's OK before it creates any workspace or starts any worker. The request named no profiles and there is no settings file. FAIL if the plan goes on to create workspaces or start workers without waiting for that OK.
