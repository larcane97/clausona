---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if each terminal is created with `orca terminal create` without `--command`, and the `clausona run` line is sent afterwards with `orca terminal send`. FAIL if the plan passes the launch line through `--command`.
