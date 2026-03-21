---
name: Issue Fetch
description: Fetch a ticket from a platform and save it as a local artifact
autoExecutionMode: true
version: 1.0.0
tags:
  - issue
  - fetch
  - jira
  - github
  - bitbucket
---

# Issue Fetch Workflow

Fetch a ticket from Jira, GitHub, or Bitbucket and save it as a local artifact under
`./<platform>/<ticket-key>.<format>`. **Overwrites any existing local artifact.**

## Invocation

```bash
# Fetch using the primary platform from .env
windsurf-agent issue:fetch WBP-2971

# Specify platform and output format
windsurf-agent issue:fetch WBP-2971 --platform jira --format md

# Fetch a Bitbucket issue with a repo override
windsurf-agent issue:fetch 123 --platform bitbucket --repo myworkspace/myrepo

# Preview what would happen without fetching
windsurf-agent issue:fetch WBP-2971 --dry-run
```

## Execution Steps

### Step 1: Resolve Platform and Format

- Read `--platform` option, falling back to `PRIMARY_PLATFORM` from `.env`
- Read `--format` option, falling back to `DEFAULT_OUTPUT_FORMAT` from `.env`
- For Bitbucket, resolve the repository reference from `--repos`:
  - `workspace/repo` format → use as-is
  - `repo` (short form) → prepend `ATLASSIAN_BITBUCKET_WORKSPACE` from `.env`

### Step 2: Fetch Ticket

- Call the platform adapter to retrieve the ticket by key
- Normalise the response into a `UniversalTicket` object

### Step 3: Write Artifact

- Create `./<platform>/` directory if it does not exist
- Serialise the ticket to the requested format
- Write to `./<platform>/<ticket-key>.<format>`
- Overwrite any existing file at that path

### Step 4: Confirmation

- Print ticket title, type, status, and priority
- Print the path of the saved artifact

## Evaluation Criteria

- Ticket is fetched without authentication errors
- Artifact is written to the correct path and format
- Existing artifacts are cleanly overwritten
- A clear error is shown if the ticket key does not exist on the platform
