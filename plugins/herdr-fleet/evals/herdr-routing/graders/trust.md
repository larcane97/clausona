---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan handles Claude Code's folder-trust question for a worker, for example by checking the screen when the worker is blocked and choosing 'Yes, I trust this folder' with keys. FAIL if the plan starts workers with no step for the trust question.
