---
type: llm
weight: 1
---

The agent was told not to run anything, so its answer is a plan of the steps and commands it would run. Grade that plan; nothing having been run yet is expected.

PASS if the plan says that exit code 75 (from `clausona route pick` or `clausona run --route`) means no account is free, that it then starts no more workers, and that it tells the user when the soonest reset is. Mentioning running an account by name as an option that needs the user's OK is fine. FAIL if the plan ignores the failure, or raises `--max-usage` or names a profile to get past the limit, on its own.
