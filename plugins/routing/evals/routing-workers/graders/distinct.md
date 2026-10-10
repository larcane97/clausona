---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan expects the three workers to land on different accounts because each pick (or each routed run) records its turn on the round-robin route. Saying which accounts it expects them to get is fine, as long as the accounts come from the picks. FAIL if it starts the workers on the three profiles from the explain output by name, without picking through the route.
