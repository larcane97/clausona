---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if, before the step that creates the route, the plan shows the user which accounts the route would include (for example with `clausona route explain --tool claude --from …`, or by listing them). FAIL if the plan creates the route without first showing the user its members.
