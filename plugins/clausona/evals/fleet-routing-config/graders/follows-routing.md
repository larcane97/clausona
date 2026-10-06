---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if task 1 (the `--json` flag, in src/commands/list.ts) runs on claude:side, because the settings file's routing rule says claude:glm never edits files under src/. FAIL if claude:glm gets task 1.
