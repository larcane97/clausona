---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if each task gets its own git worktree on its own branch, created with `git worktree add -b fleet/<task> <path>` before its worker starts. FAIL if workers share the repo's own checkout or one worktree.
