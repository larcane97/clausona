---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the docs task runs on codex:work, started with `clausona run codex:work --` and `-s workspace-write -a on-request`, `-c check_for_update_on_startup=false` and `--disable hooks`, and the two other tasks run on claude:work and claude:side. FAIL if the docs task runs elsewhere, codex:work gets another task, or its launch line lacks any of those flags.
