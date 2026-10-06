---
name: verify
description: Sub-agent verification discipline — ensures sub-agents run prescribed checks and the main context re-verifies. Use when dispatching work to sub-agents via the Agent tool.
---

## Rules

- Sub-agents MUST run prescribed verification commands (lint, typecheck, test) before reporting completion.
- After sub-agents finish, run the full verification suite in the main context before declaring work done.
- Never dismiss lint/type warnings as "pre-existing" without verifying — if a file is in `git diff`, all its violations are the task's responsibility.
