---
name: Git Commit with AI
description: Create a conventional commit with AI-generated message using issue:commit
autoExecutionMode: false
version: 2.0.0
tags:
  - git
  - ai
  - commit
---

# Git Commit Workflow

Automatically generate conventional commit messages using AI analysis of your staged git changes.
The ticket key is auto-detected from the current branch name (`[A-Z]+-\d+`), or you can supply
it explicitly.

## Invocation

```bash
# AI-generated message, ticket key auto-detected from branch
windsurf-agent issue:commit

# Explicit ticket key
windsurf-agent issue:commit WBP-2971

# Force conventional commits format
windsurf-agent issue:commit WBP-2971 --conventional

# Provide a manual message (bypasses AI)
windsurf-agent issue:commit WBP-2971 --message "fix: correct null check in auth middleware"

# Preview without committing
windsurf-agent issue:commit --dry-run
```

## Execution Steps

### Step 1: Detect Ticket Key

- Read ticket key from the first positional argument
- If not provided, extract from the current branch name using pattern `[A-Z]+-\d+`
  (e.g., `feature/WBP-2971__add-oauth` → `WBP-2971`)

### Step 2: Stage Validation

- Confirm the working directory is a git repository
- Check that there are staged changes (`git diff --cached`)
- Abort with a clear error if nothing is staged

### Step 3: Generate Commit Message

- Send the staged diff to Claude for analysis
- Apply `--conventional` format if requested (`<type>(<scope>): <description>`)
- Prefix the message with `[<ticket-key>]` if a key was detected and is not already present
- Skip AI generation if `--message` is provided

### Step 4: Create Commit

- **Wait for user approval** of the generated message
- Run `git commit -m "<message>"`
- Display the resulting commit hash

### Step 5: Confirmation

- Show commit hash and first line of message
- Remind user to `git push` when ready

## Evaluation Criteria

- Commit message accurately describes the staged changes
- Ticket key is present in the message when a branch key is detected
- Conventional commits format is applied when `--conventional` is set
- No unstaged changes are silently included
- Commit is created without error
