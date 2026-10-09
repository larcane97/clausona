---
name: fleet-settings-migrate
max_turns: 6
timeout_seconds: 240
allowed_tools: [Read, Glob, Grep, Skill]
runs: 2
---

From now on, always retire my Superset fleet workers as soon as they're finished. Do not run
anything; tell me exactly which file you would change and what it would contain afterwards.

$ cat ~/.clausona/fleet.json
cat: /home/u/.clausona/fleet.json: No such file or directory

$ cat ~/.clausona/superset-fleet.json
{"workers": ["claude:work", "claude:glm"], "maxUsage": 80}
