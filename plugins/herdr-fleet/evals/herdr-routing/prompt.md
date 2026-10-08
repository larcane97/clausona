---
name: herdr-routing
max_turns: 8
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
runs: 2
---

I'm in a herdr pane in this repo (HERDR_ENV=1). Split these across my accounts in herdr, one worker
each:

1. add a `--json` flag to `notes list`
2. write tests for `src/parse.ts`

Do not run anything. Here is what the commands you need would print. Tell me, step by step and with
the exact commands, what you will do: which profile runs which task, how each worker starts, and how
you will know when each one finishes.

$ herdr status
server:
  status: running

$ clausona list --json   (abridged)
[{"name":"claude:main","tool":"claude","configDir":"/home/u/.claude","quota":{"state":"ok","session":{"usedPercent":40},"weekly":{"usedPercent":60}}},
 {"name":"claude:work","tool":"claude","configDir":"/home/u/.claude-work","quota":{"state":"ok","session":{"usedPercent":10},"weekly":{"usedPercent":30}}},
 {"name":"claude:side","tool":"claude","configDir":"/home/u/.claude-side","quota":{"state":"ok","session":{"usedPercent":20},"weekly":{"usedPercent":35}}},
 {"name":"codex:work","tool":"codex","configDir":"/home/u/.codex-work","quota":{"state":"ok","session":{"usedPercent":0},"weekly":{"usedPercent":5}}}]

$ cat ~/.clausona/fleet.json
{"permissions": {"claude": "acceptEdits"}}

CLAUDE_CONFIG_DIR is unset in this session. Each profile has run Claude Code before. The repo has a
remote, origin.
