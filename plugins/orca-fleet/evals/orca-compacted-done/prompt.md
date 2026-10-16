---
name: orca-compacted-done
plugins: ["../..", "../../../fleet-core"]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
runs: 2
---

You are the main session of an Orca fleet I asked you to run with clausona profiles. One worker is
left: terminal handle term_9, task `docs`, worktree /home/u/orca/workspaces/notes/fleet-docs,
branch fleet-docs, Claude Code on profile claude:work. You were busy for an hour; your wait on that
worker just returned. Do not run anything. Here is what the commands you need would print. Tell
me, with the exact commands, what state the task is in and what you do next.

$ orca terminal wait --terminal term_9 --for tui-idle --timeout-ms 1800000 --json
{"id":"terminal-wait","ok":true,"result":{"terminal":"term_9","condition":"tui-idle","satisfied":true}}

$ orca worktree ps --json   (abridged)
{"ok":true,"result":{"worktrees":[{"path":"/home/u/orca/workspaces/notes/fleet-docs","branch":"refs/heads/fleet-docs",
 "agents":[{"state":"done","agentType":"claude","prompt":"Read .fleet-brief.md in this folder and do what it says.",
 "lastAssistantMessage":"Wrote docs/guide.md and linked it from the README. Lint passes, branch pushed.\nFLEET_WORKER_DONE: added the setup guide"}]}]}}

$ orca terminal show --terminal term_9 --json   (abridged)
{"ok":true,"result":{"terminal":{"handle":"term_9","title":"✳ Claude Code","preview":"✻ Compacted while idle, before the prompt cache expired\n\n❯ \n  ⏵⏵ accept edits on"}}}
