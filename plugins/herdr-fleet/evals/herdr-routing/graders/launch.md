---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if each worker is started in a herdr pane with `clausona run <profile> --` followed by `--permission-mode acceptEdits` and `--strict-mcp-config`, and the command line does not contain the brief. FAIL if a worker starts with a bare `claude` or `codex`, or with `herdr agent start`, or if the brief text is on the command line.
