---
name: fleet-routing
max_turns: 8
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
runs: 2
---

This repo is a Superset project (project id p-1). I want three tasks done in parallel in Superset,
each by its own worker in its own workspace, without my own account's limits slowing it down:

1. add a `--json` flag to `notes list`
2. write tests for `src/parse.ts`
3. fix the broken links in `docs/`

Do not run anything. Here is what the commands you need would print. Tell me, step by step and with
the exact commands, what you will do: which profile runs which task, how each worker starts, and
what happens when they finish.

$ superset auth whoami
Error: Not logged in

$ clausona list --json   (abridged)
[{"name":"claude:main","tool":"claude","configDir":"/home/u/.claude","quota":{"state":"ok","session":{"usedPercent":40},"weekly":{"usedPercent":60}}},
 {"name":"claude:work","tool":"claude","configDir":"/home/u/.claude-work","quota":{"state":"ok","session":{"usedPercent":10},"weekly":{"usedPercent":30}}},
 {"name":"claude:side","tool":"claude","configDir":"/home/u/.claude-side","quota":{"state":"ok","session":{"usedPercent":95},"weekly":{"usedPercent":50}}},
 {"name":"claude:team","tool":"claude","configDir":"/home/u/.claude-team","quota":{"state":"ok","session":{"usedPercent":5},"weekly":{"usedPercent":20},"scoped":{"usedPercent":100,"label":"Opus"}}},
 {"name":"claude:glm","tool":"claude","configDir":"/home/u/.claude-glm","kind":"api","model":"z-ai/glm-5.3"},
 {"name":"codex:work","tool":"codex","configDir":"/home/u/.codex-work","quota":{"state":"ok","session":{"usedPercent":0},"weekly":{"usedPercent":5}}}]

CLAUDE_CONFIG_DIR is unset in this session.
Superset agent configs: "Claude · work (Sonnet 5.5)" (id cfg-work, runs clausona run claude:work),
"Claude · team (Opus 5.5)" (id cfg-team, runs clausona run claude:team -- --model claude-opus-5-5),
"GLM · api" (id cfg-glm, runs clausona run claude:glm) and "Codex · work" (id cfg-codex, runs
clausona run codex:work). There are none for claude:main or claude:side.
Neither ~/.clausona/fleet.json nor ~/.clausona/superset-fleet.json exists.
