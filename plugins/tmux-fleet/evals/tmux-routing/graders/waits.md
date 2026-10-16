---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan waits with the helper's `tmux-fleet.mjs wait --name … --name …` (run in the background in Claude Code) and reads a worker with `tmux-fleet.mjs read` or the wait's message. FAIL if it writes its own loop that greps screens or polls `tmux capture-pane`, or ends without any wait.
