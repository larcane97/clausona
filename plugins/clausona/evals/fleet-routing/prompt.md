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
[{"name":"claude:main","configDir":"/home/u/.claude","quota":{"state":"ok","session":{"usedPercent":40},"weekly":{"usedPercent":60}}},
 {"name":"claude:work","configDir":"/home/u/.claude-work","quota":{"state":"ok","session":{"usedPercent":10},"weekly":{"usedPercent":30}}},
 {"name":"claude:side","configDir":"/home/u/.claude-side","quota":{"state":"ok","session":{"usedPercent":95},"weekly":{"usedPercent":50}}},
 {"name":"claude:glm","configDir":"/home/u/.claude-glm","kind":"api","model":"z-ai/glm-5.3"}]

CLAUDE_CONFIG_DIR is unset in this session.
Superset agent configs: "Claude · work (Sonnet 5.5)" (id cfg-work, runs clausona run claude:work) and
"GLM · api" (id cfg-glm, runs clausona run claude:glm). There are none for claude:main or claude:side.
No ~/.clausona/superset-fleet.json exists.
