---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan continues the task in the same workspace w1, started from terminal t1's output (for example a `--from-terminal t1` handoff). FAIL if the plan starts over elsewhere or without t1's output.
