---
name: Issue Plan
description: Generate an AI implementation plan for a ticket
autoExecutionMode: true
version: 1.0.0
tags:
  - issue
  - plan
  - ai
---

# Issue Plan Workflow

Generate an AI-powered implementation plan for a ticket. Reads the ticket from the local artifact
saved by `issue:fetch`. If no local artifact exists (or `--force-recreate` is passed), the ticket
is fetched from the platform first.

## Invocation

```bash
# Plan using a local artifact (default action: implement)
windsurf-agent issue:plan WBP-2971

# Specify the resolution action
windsurf-agent issue:plan WBP-2971 --action fix

# Force re-fetch of the ticket artifact before planning
windsurf-agent issue:plan WBP-2971 --action investigate --force-recreate

# Save the plan in YAML instead of JSON
windsurf-agent issue:plan WBP-2971 --action implement --format yaml

# Preview without making changes
windsurf-agent issue:plan WBP-2971 --action fix --dry-run
```

## Execution Steps

### Step 1: Resolve Options

- Read `--action` (default: `implement`); valid values: `implement | fix | investigate`
- Read `--format` (default: `json`); valid values: `json | md | yaml`
- Read `--platform`, falling back to `PRIMARY_PLATFORM` from `.env`

### Step 2: Load or Fetch Ticket

- Look for `./<platform>/<ticket-key>.md` on disk
- If found and `--force-recreate` is not set, read from disk
- Otherwise fetch from the platform (applying `--repo` override for Bitbucket) and save to disk

### Step 3: Generate Plan

- Send the ticket content to Claude with the resolution action as context
- Claude returns a structured plan containing:
  - `summary` — one-line description of the approach
  - `action` — the resolution action
  - `estimatedComplexity` — `low | medium | high`
  - `steps` — ordered list of implementation steps
  - `filesAffected` — list of files expected to change
  - `risks` — potential risks or considerations

### Step 4: Save Plan

- Write plan to `./<platform>/<ticket-key>-plan-<action>.<format>`
- Print summary, action, complexity, step count, and affected file count

## Evaluation Criteria

- Plan is generated for the correct resolution action
- Artifact is saved to the expected path in the requested format
- If no local ticket artifact exists, it is fetched and saved before planning
- `--force-recreate` always re-fetches the ticket, even if a local artifact exists
