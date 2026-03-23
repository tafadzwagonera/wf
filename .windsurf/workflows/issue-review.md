---
name: Issue Review
description: AI-powered code review with flexible source options
autoExecutionMode: false
version: 1.0.0
tags:
  - issue
  - review
  - ai
  - git
---

# Issue Review Workflow

Perform an AI-powered code review against one of four source modes. The review is assessed across
nine criteria and produces a structured report with issues, suggestions, and an approval verdict.

## Invocation

```bash
# Review staged/unstaged changes in the current repository
windsurf-agent issue:review

# Review with ticket context
windsurf-agent issue:review WBP-2971

# Review a GitHub or Bitbucket pull request
windsurf-agent issue:review https://github.com/owner/repo/pull/42

# Review a specific local repository
windsurf-agent issue:review ../my-other-repo

# Save the review report to a file
windsurf-agent issue:review WBP-2971 --output ./jira/WBP-2971-review.md

# Preview without performing the review
windsurf-agent issue:review --dry-run
```

## Source Modes

| Source argument | Behaviour |
|-----------------|-----------|
| _(none)_ | Review staged changes, falling back to unstaged, in the current repository |
| `ABC-123` (ticket key) | Same as above; ticket key is passed as context to the AI |
| `https://…` (URL) | Fetch the pull request diff from GitHub or Bitbucket |
| `./path/to/repo` (path) | Review staged/unstaged changes in the specified local repository |

## Execution Steps

### Step 1: Resolve Source

- Identify the source mode from the argument (or lack thereof)
- For PR URLs, detect the platform from the URL hostname (`github.com` or `bitbucket.org`)
- For local paths, verify the directory exists and contains a `.git` folder

### Step 2: Collect Diff

- Retrieve the diff for the resolved source
- For the current/local repository: try staged diff first, fall back to unstaged
- For PR URLs: call the platform adapter to fetch the pull request diff
- Abort with a clear warning if no diff is found

### Step 3: AI Code Review

Send the diff to Claude, assessed against nine criteria:

1. **Clarity** — Would another developer understand this instantly?
2. **Deletability** — Can I remove or replace this easily?
3. **Failure handling** — What breaks? Is it handled?
4. **Necessity** — Is anything here unused or speculative?
5. **Quality** — Do the changes conform to formatting and quality metrics?
6. **Relevancy** — Does the feature or fix work? _(This is very important)_
7. **Security** — Are there any glaring security concerns?
8. **Simplicity** — Is this the simplest thing that works?
9. **Structure** — Does this reflect the domain?

### Step 4: Display Results

- Print summary, issues (with severity and file location), and suggestions
- Show approval verdict: `✓ APPROVED` or `✗ NOT APPROVED`

### Step 5: Save Report (optional)

- If `--output <path>` is provided, write the review to that file
- Format is controlled by `--format` (`text | json | md`; default: `text`)

## Evaluation Criteria

- All nine review dimensions are covered in the AI output
- Issues include severity (`error | warning | info`) and file location where available
- Approval verdict is clearly stated
- Review is saved to the correct path when `--output` is specified
- A clear warning is shown when no diff is found
