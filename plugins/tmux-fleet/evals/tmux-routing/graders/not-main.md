---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if claude:main runs no task: it is the main session's own profile, because CLAUDE_CONFIG_DIR is unset and its configDir is /home/u/.claude. FAIL if a task runs on claude:main.
