---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if, after sending each worker its line, the plan waits a few seconds and then waits with `orca terminal wait --for tui-idle` for that worker, and reads its screen with `orca terminal show` (the preview) or `orca worktree ps`. FAIL if it writes its own loop that greps screens for a phrase, waits with tui-idle right after sending with no delay, or never waits.
