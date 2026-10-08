---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan gives every one of the three tasks a profile: claude:work through cfg-work, claude:glm through cfg-glm, or claude:team on a model other than Opus through a new agent config that it shows the user first. FAIL if the plan leaves a task without a profile, runs one on claude:team with Opus, or gives one to any other profile.
