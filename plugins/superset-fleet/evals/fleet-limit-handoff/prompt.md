---
name: fleet-limit-handoff
max_turns: 8
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
runs: 2
---

A Superset worker running on claude:work (workspace w1, worktree /wt/one, terminal t1, agent config
cfg-work) now shows: "You've hit your usage limit · resets 7pm". It was halfway through its task.
This session runs on claude:main. Also available: claude:side (5H 20%, 7D 40%, configDir
/home/u/.claude-side, config cfg-side) and claude:glm (API, configDir /home/u/.claude-glm, config
cfg-glm). The Superset CLI is not logged in.

A second worker, on claude:glm (workspace w2, terminal t2), shows:

    Bash command
      rm -rf dist && npm run build
    Do you want to proceed?
    ❯ 1. Yes
      2. No

Do not run anything; tell me exactly what you do, with the commands.
