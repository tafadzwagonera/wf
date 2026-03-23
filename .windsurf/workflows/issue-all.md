---
name: Issue All
description: Complete issue workflow — fetch, plan, implement, review, and commit
autoExecutionMode: false
version: 1.0.0
tags:
  - issue
  - workflow
  - ai
  - git
---

# Issue All Workflow

Orchestrate the full issue lifecycle in a single command. Runs any contiguous range of stages:

```
fetch → plan → implement → review → commit
```

Use `--from` and `--to` to control which stages execute. `--from` is required.

## Invocation

```bash
# Full workflow from scratch
windsurf-agent issue-all WBP-2971 --from fetch --action fix

# Run plan through review only
windsurf-agent issue-all WBP-2971 --from plan --to review --action implement

# Resume from implement (auto-discovers existing plan)
windsurf-agent issue-all WBP-2971 --from implement

# Skip stages that already have artifacts on disk
windsurf-agent issue-all WBP-2971 --from fetch --action fix --skip-existing

# Interactive AI chat after plan and review stages
windsurf-agent issue-all WBP-2971 --from fetch --action investigate --interactive

# Bitbucket with repo override
windsurf-agent issue-all 123 --from fetch --to review --action fix \
  --platform bitbucket --repo myworkspace/myrepo

# Preview the full workflow without making changes
windsurf-agent issue-all WBP-2971 --from fetch --action fix --dry-run
```

## Stages

| Stage | Artifact | Notes |
|-------|----------|-------|
| `fetch` | `./<platform>/<ticket-key>.md` | Overwrites existing artifact |
| `plan` | `./<platform>/<ticket-key>-plan-<action>.json` | `--action` required |
| `implement` | _(display only)_ | Prints branch name and steps |
| `review` | `./<platform>/<ticket-key>-review.md` | Uses nine review criteria |
| `commit` | _(display only)_ | Prints commit commands for confirmation |

## Execution Steps

### Step 1: Validate Options

- Confirm `--from` is provided and is a valid stage name
- Confirm `--to` is a valid stage name and comes after `--from`
- If the `plan` stage will run, confirm `--action` is one of `implement | fix | investigate`

### Step 2: Fetch

- Retrieve the ticket from the platform adapter (applies `--repo` override for Bitbucket)
- Save to `./<platform>/<ticket-key>.md`
- Skipped if `--skip-existing` is set and the artifact already exists

### Step 3: Plan

- Load the local ticket artifact
- Generate an AI implementation plan for the specified `--action`
- Save to `./<platform>/<ticket-key>-plan-<action>.json`
- If `--interactive`, open an AI chat session after this stage
- Skipped if `--skip-existing` is set and the artifact already exists

### Step 4: Implement

- Load the plan artifact (auto-discovers the most recent plan if `--action` is not set)
- Generate a branch name: `<prefix>/<TICKET-KEY>__<slug>`
  - Prefix is determined by action: `implement` → `feature`, `fix` → `bugfix`, `investigate` → `chore`
  - Controlled by `BRANCH_PREFIX_*` env vars
- Print the branch checkout command and ordered implementation steps
- Print the list of files expected to be affected

### Step 5: Review

Send the current `git diff HEAD` to Claude, assessed against nine criteria:

1. **Clarity** — Would another developer understand this instantly?
2. **Deletability** — Can I remove or replace this easily?
3. **Failure handling** — What breaks? Is it handled?
4. **Necessity** — Is anything here unused or speculative?
5. **Quality** — Do the changes conform to formatting and quality metrics?
6. **Relevancy** — Does the feature or fix work? _(This is very important)_
7. **Security** — Are there any glaring security concerns?
8. **Simplicity** — Is this the simplest thing that works?
9. **Structure** — Does this reflect the domain?

- Save review to `./<platform>/<ticket-key>-review.md`
- If `--interactive`, open an AI chat session after this stage
- Skipped if `--skip-existing` is set and the artifact already exists

### Step 6: Commit

- Generate an AI commit message from `git diff HEAD` and recent commit history
- Prefix with the ticket key: `WBP-2971: <message>`
- Print `git add .`, `git commit`, and `git push` commands for user confirmation
- **Wait for user approval** before executing

## Evaluation Criteria

- Only the specified stage range executes
- `--action` is validated before any stage runs
- `--skip-existing` correctly skips stages with existing artifacts
- Branch name matches the configured platform pattern (warning printed on mismatch)
- Review covers all nine criteria
- Commit message is prefixed with the ticket key
- `--dry-run` previews every stage without making any changes
