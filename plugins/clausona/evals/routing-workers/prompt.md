---
name: routing-workers
max_turns: 8
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
runs: 2
---

Start three background workers, one per task, so that they do not all land on the same account:
lint fixes in src/a, tests for src/b, docs typos in docs/. Use my clausona route "main".

Each worker is a non-interactive Claude Code run (`-p`) with `--permission-mode acceptEdits` and a
one-line brief, started as a plain background process from this shell (not Superset).

Do not run anything. Here is what the commands you need would print. Tell me, step by step and
with the exact commands, what you will do, including what happens if no account is free.

$ clausona route list
  main  claude · round-robin · max 80%
        from * · 3 member(s)

$ clausona route explain main --json   (abridged)
{"route":"main","outcome":{"kind":"picked","id":"claude:b","stage":"pool","reason":"next in turn"},
 "members":[{"profile":"claude:a","status":"eligible"},{"profile":"claude:b","status":"picked"},{"profile":"claude:c","status":"eligible"}]}
