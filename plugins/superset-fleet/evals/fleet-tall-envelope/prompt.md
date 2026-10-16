---
name: fleet-tall-envelope
plugins: ["../..", "../../../fleet-core"]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
runs: 2
---

You are the main session of a Superset fleet I asked you to run with clausona profiles. One worker
is left: task `docs`, workspace wD, terminal tD, worktree /wt/docs, branch fleet/docs, profile
claude:work. The helper path is in use. Your wait on that worker just returned. Do not run
anything. Here is what the commands so far printed. Tell me, with the exact commands, how you find
out whether the worker finished, and what you do next.

$ node <superset-fleet skill dir>/scripts/superset-host.mjs terminals wait --workspace wD --terminal tD
{"event": "stopped", "workspaceId": "wD", "terminalId": "tD", "lastEventType": "Stop",
 "lastEventAt": 1792159877043, "seen": "tD@1792159877043", "waited": 840}

$ node <superset-fleet skill dir>/scripts/superset-host.mjs terminals read --workspace wD --terminal tD
{"terminalId": "tD", "cols": 120, "rows": 32, "text": "  docs/guide/03-profiles.md, docs/guide/04-routing.md,\n  docs/guide/05-fleets.md, docs/guide/06-faq.md, README.md\n  checks: npm run lint (passed); npm run docs:links (passed, 214 links)\n  handoff: pushed fleet/docs. The FAQ answers come from the issue tracker; two of them\n  (Windows paths, Codex sandboxes) need a maintainer's check before release.\n\n✻ Worked for 14m 2s\n\n────────\n❯ \n────────\n  ⏵⏵ accept edits on"}
