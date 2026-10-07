---
name: plan
description: Plan review gate — thorough self-review before exiting plan mode. Use when working in plan mode or preparing to call ExitPlanMode.
---

## Before calling ExitPlanMode

Verify every line reference, return type, and call chain claim against actual source code before presenting the plan for approval. Do not rely on memory — re-read the relevant files to confirm.

## After approval

Write the approved plan as a dated markdown file under `~/.wf/<project-dir>/`, verify it is readable, then stop. Plan approval is not implementation approval.
