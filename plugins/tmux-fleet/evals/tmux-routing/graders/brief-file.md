---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if each brief is written to `.fleet-brief.md` in the worker's worktree and the worker is sent one line telling it to read that file, with `tmux-fleet.mjs send --name … --text …`. FAIL if the brief is pasted into a command or prompt directly.
