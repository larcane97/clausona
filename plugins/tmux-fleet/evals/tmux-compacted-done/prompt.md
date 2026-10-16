---
name: tmux-compacted-done
plugins: ["../..", "../../../fleet-core"]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
runs: 2
---

You are the main session of a tmux fleet I asked you to run with clausona profiles. One worker is
left: name w1-docs, task `docs`, worktree /home/u/.clausona/worktrees/notes/docs, branch
fleet/docs, Claude Code on profile claude:work. You were busy for an hour; your wait on that worker
just returned. Do not run anything. Here is what the commands you need would print. Tell me, with
the exact commands, how you find out whether the worker finished, and what you do next.

$ node <tmux-fleet skill dir>/scripts/tmux-fleet.mjs wait --name w1-docs
{"event": "stopped", "name": "w1-docs", "at": "2026-10-16T14:11:17.043Z"}

$ node <tmux-fleet skill dir>/scripts/tmux-fleet.mjs read --name w1-docs --lines 120
✻ Compacted while idle, before the prompt cache expired

────────
❯
────────
  ⏵⏵ accept edits on

$ clausona list --json   (abridged)
[{"name":"claude:main","tool":"claude","configDir":"/home/u/.claude"},
 {"name":"claude:work","tool":"claude","configDir":"/home/u/.claude-work"}]
