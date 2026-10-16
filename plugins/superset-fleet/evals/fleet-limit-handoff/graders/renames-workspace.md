---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan renames workspace w1 after the handoff, so that its name shows the new worker's profile instead of work (for example `workspaces rename w1 --name "<task> · side (…)"`, or `superset ws update` with `--name`). FAIL if the plan leaves w1's name as it was.
