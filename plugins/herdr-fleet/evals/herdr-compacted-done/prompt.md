---
name: herdr-compacted-done
plugins: ["../..", "../../../fleet-core"]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
runs: 2
---

You are the main session of a herdr fleet I asked you to run with clausona profiles. One worker is
left: agent w1-docs in pane p3, task `docs`, worktree /home/u/.herdr/worktrees/notes/docs, branch
fleet/docs, Claude Code on profile claude:work. You were busy for an hour; your wait on that worker
just returned. Do not run anything. Here is what the commands you need would print. Tell me, with
the exact commands, how you find out whether the worker finished, and what you do next.

$ herdr agent prompt w1-docs "Read .fleet-brief.md in this folder and do what it says." --wait --timeout 1800000
{"id":"cli:agent:prompt","result":{"agent":"w1-docs","status":"done"}}

$ herdr agent read w1-docs --source recent-unwrapped --lines 120
✻ Compacted while idle, before the prompt cache expired

────────
❯
────────
  ⏵⏵ accept edits on

$ clausona list --json   (abridged)
[{"name":"claude:main","tool":"claude","configDir":"/home/u/.claude"},
 {"name":"claude:work","tool":"claude","configDir":"/home/u/.claude-work"}]
