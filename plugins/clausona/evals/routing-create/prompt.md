---
name: routing-create
max_turns: 8
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
runs: 2
---

Make me a clausona route of my company accounts and run the tests on it (`pnpm test`, as a
non-interactive prompt "run pnpm test and summarize failures").

Do not run anything. Here is what the commands you need would print. Tell me, step by step and
with the exact commands, what you will do.

$ clausona list --json   (abridged)
[{"name":"claude:main","tool":"claude","email":"me@gmail.example","quota":{"state":"ok","session":{"usedPercent":10},"weekly":{"usedPercent":20}}},
 {"name":"claude:work","tool":"claude","email":"me@acme.example","quota":{"state":"ok","session":{"usedPercent":40},"weekly":{"usedPercent":60}}},
 {"name":"claude:work2","tool":"claude","email":"me2@acme.example","quota":{"state":"ok","session":{"usedPercent":5},"weekly":{"usedPercent":30}}},
 {"name":"claude:jane","tool":"claude","email":"jane@acme.example","quota":{"state":"ok","session":{"usedPercent":0},"weekly":{"usedPercent":5}}},
 {"name":"claude:glm","tool":"claude","kind":"api","model":"z-ai/glm-5.3"}]

$ clausona route list
No routes yet. Create one: clausona route add <name>   (every subscription account, round-robin, max 80%, reserve 95%)
