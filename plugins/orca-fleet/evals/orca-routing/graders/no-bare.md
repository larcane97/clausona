---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if every worker starts through `clausona run <profile>`, never a bare `codex` or `claude` (Orca's CODEX_HOME would put a bare `codex` on Orca's account). FAIL otherwise.
