---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan handles Claude Code's folder-trust question for a worker, for example by reading the screen with `tmux-fleet.mjs read` and choosing 'Yes, I trust this folder' with `tmux-fleet.mjs send --keys Down Enter`. FAIL if the plan starts workers with no step for the trust question.
