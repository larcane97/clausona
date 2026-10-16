---
name: fleet-compacted-done
plugins: ["../..", "../../../fleet-core"]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
runs: 2
---

You are the main session of a Superset fleet I asked you to run with clausona profiles. One worker
is left: task `docs`, workspace wD, terminal tD, worktree /wt/docs, branch fleet/docs, profile
claude:work. The helper path is in use. You were busy for an hour; your wait on that worker just
returned. Do not run anything. Here is what the commands you need would print. Tell me, with the
exact commands, what state the task is in and what you do next.

$ node <superset-fleet skill dir>/scripts/superset-host.mjs terminals wait --workspace wD --terminal tD
{"event": "stopped", "workspaceId": "wD", "terminalId": "tD", "lastEventType": "Stop",
 "lastEventAt": 1792159877043, "seen": "tD@1792159877043", "waited": 3600,
 "reply": "Wrote docs/guide.md and linked it from the README.\n\nSUPERSET_WORKER_DONE\ntask: docs\nsummary: added the setup guide\nfiles: docs/guide.md, README.md\nchecks: npm run lint (passed)\nhandoff: pushed fleet/docs"}

$ node <superset-fleet skill dir>/scripts/superset-host.mjs terminals read --workspace wD --terminal tD
{"terminalId": "tD", "cols": 120, "rows": 32, "text": "✻ Compacted while idle, before the prompt cache expired\n\n────────\n❯ \n────────\n  ⏵⏵ accept edits on"}
