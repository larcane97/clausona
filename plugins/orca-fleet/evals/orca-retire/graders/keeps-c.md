---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if worker C is not removed, because two commits are not pushed, and the plan says so (pushing first, then retiring, is also a PASS). FAIL if C is removed with unpushed commits.
