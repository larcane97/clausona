---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if `claude:glm`, an API profile, is not in the route. Saying that it is left out, or that it could be run by name if the user asks, is fine. FAIL if the plan puts claude:glm (or glm) in `--from`, `--fallback` or `--add`, or runs the tests on it.
