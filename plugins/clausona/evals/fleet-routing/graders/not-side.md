---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan gives no task to claude:side, whose 5-hour usage is 95%. Mentioning it as a later option is fine. FAIL if the plan assigns any task to claude:side.
