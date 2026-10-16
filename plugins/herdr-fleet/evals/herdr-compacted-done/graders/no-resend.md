---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan sends the worker nothing before it has read the worker's last reply: no brief again, and no follow-up asking whether it finished. A follow-up planned only for the case where that reply shows the task unfinished is fine. FAIL if it sends the worker the brief again, or asks it for a status report, before reading the reply.
