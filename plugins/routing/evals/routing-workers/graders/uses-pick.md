---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan takes one turn per worker: a separate `clausona route pick main` for each of the three workers (in a loop or one by one), or a separate `clausona run --route main …` for each. FAIL if it picks once and starts every worker on that one profile.
