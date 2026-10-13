---
name: plan
description: Plan review gate — thorough self-review before exiting plan mode. Use when working in plan mode or preparing to call ExitPlanMode.
---

## Before calling ExitPlanMode

Verify every line reference, return type, and call chain claim against actual source code before presenting the plan for approval. Do not rely on memory — re-read the relevant files to confirm.

Have sub-agents adversarially review the plan for accuracy and design consistency before presenting it.

A hook deterministically blocks plan submission until this review is recorded: in Claude Code a PreToolUse hook denies ExitPlanMode, and in Codex a Stop hook blocks any turn whose final message contains a `<proposed_plan>` block. Once the verification and adversarial review above pass, run `~/Projects/wf/src/hooks/plan-review-gate.sh mark` from the project directory, then present the plan. The marker is consumed when the plan goes through and expires after 60 minutes, so re-run it after revising a plan.

## After approval

Write the approved plan as a self-contained markdown file named `YYYY-MM-DD-<slug>.md` under `~/.wf/<project-dir>/`, where `<project-dir>` is the directory the user names (it varies per request). Verify the file is present and readable (`ls -la` plus a read-back), report the file list, then stop and wait for further instructions. Plan approval is not implementation approval; do not touch code.

When a backlog has several themes, write one dated plan document per theme in the same directory. These files are later consumed as `wf issue -c <plan>.md` inputs, and the user drives implementation separately.
