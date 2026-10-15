---
name: verify
description: Sub-agent verification discipline — ensures sub-agents run prescribed checks and the main context re-verifies. Use when dispatching work to sub-agents via the Agent tool.
---

Goal: "done" means the checks passed in the main context, not that a sub-agent said so.

## Rules

- Sub-agents must run the prescribed verification commands (lint, typecheck, test) before reporting completion.
- After sub-agents finish, run the full verification suite in the main context before declaring work done.
- Never dismiss lint/type warnings as "pre-existing" without verifying. If a file is in `git diff`, all its violations are the task's responsibility.
