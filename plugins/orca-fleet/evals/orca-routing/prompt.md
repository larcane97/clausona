---
name: orca-routing
max_turns: 8
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
runs: 2
---

I'm in an Orca terminal in this repo. Split these across my accounts in Orca, one worker each. Run
the docs one on codex:work; use my Claude accounts for the rest.

1. add a `--json` flag to `notes list`
2. write tests for `src/parse.ts`
3. fix the broken links in `docs/`

Do not run anything. Here is what the commands you need would print. Tell me, step by step and with
the exact commands, what you will do: which profile runs which task, how each worker starts, and how
you will know when each one finishes.

$ orca status
appRunning: true
runtimeState: ready
runtimeReachable: true

$ orca repo list --json   (abridged)
{"ok":true,"result":{"repos":[{"id":"r1","path":"/home/u/notes","displayName":"notes"}]}}

$ clausona list --json   (abridged)
[{"name":"claude:main","tool":"claude","configDir":"/home/u/.claude","quota":{"state":"ok","session":{"usedPercent":40},"weekly":{"usedPercent":60}}},
 {"name":"claude:work","tool":"claude","configDir":"/home/u/.claude-work","quota":{"state":"ok","session":{"usedPercent":10},"weekly":{"usedPercent":30}}},
 {"name":"claude:side","tool":"claude","configDir":"/home/u/.claude-side","quota":{"state":"ok","session":{"usedPercent":20},"weekly":{"usedPercent":35}}},
 {"name":"codex:work","tool":"codex","configDir":"/home/u/.codex-work","quota":{"state":"ok","session":{"usedPercent":0},"weekly":{"usedPercent":5}}}]

$ cat ~/.clausona/fleet.json
{"permissions": {"claude": "acceptEdits", "codex": "on-request"}}

CLAUDE_CONFIG_DIR is unset in this session. Orca sets CODEX_HOME in its terminals to its own
directory. Each profile has run before. The repo has a remote, origin.
