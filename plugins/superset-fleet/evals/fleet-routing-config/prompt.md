---
name: fleet-routing-config
max_turns: 8
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
runs: 2
---

This repo is a Superset project (project id p-1). Split these across my accounts in Superset, one
worker each:

1. add a `--json` flag to `notes list`, in src/commands/list.ts
2. write tests for `src/parse.ts`, in a new tests/parse.test.ts
3. fix the broken links in `docs/`

Do not run anything. Here is what the commands you need would print. Tell me, step by step and with
the exact commands, what you will do: which profile runs which task, and how each worker starts.

$ superset auth whoami
Error: Not logged in

$ clausona list --json   (abridged)
[{"name":"claude:main","tool":"claude","configDir":"/home/u/.claude","quota":{"state":"ok","session":{"usedPercent":40},"weekly":{"usedPercent":60}}},
 {"name":"claude:work","tool":"claude","configDir":"/home/u/.claude-work","quota":{"state":"ok","session":{"usedPercent":5},"weekly":{"usedPercent":10}}},
 {"name":"claude:side","tool":"claude","configDir":"/home/u/.claude-side","quota":{"state":"ok","session":{"usedPercent":30},"weekly":{"usedPercent":40}}},
 {"name":"claude:glm","tool":"claude","configDir":"/home/u/.claude-glm","kind":"api","model":"z-ai/glm-5.3"}]

$ cat ~/.clausona/fleet.json
cat: /home/u/.clausona/fleet.json: No such file or directory

$ cat ~/.clausona/superset-fleet.json
{"retire": "ask", "workers": ["claude:side", "claude:glm"], "routing": ["claude:glm never edits files under src/"]}

CLAUDE_CONFIG_DIR is unset in this session.
Superset agent configs, each with `--permission-mode acceptEdits --strict-mcp-config` in its args:
"Claude · work (Sonnet 5.5)" (id cfg-work, runs clausona run claude:work -- --model
claude-sonnet-5-5), "Claude · side (Sonnet 5.5)" (id cfg-side, runs clausona run claude:side --
--model claude-sonnet-5-5) and "GLM · api" (id cfg-glm, runs clausona run claude:glm -- --tools=Bash,Read,Edit,Write,Grep,Glob).
Each profile has run Claude Code before.
