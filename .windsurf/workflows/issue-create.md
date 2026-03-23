---
name: Issue Create
description: Create a ticket on a platform from a structured input file
autoExecutionMode: true
version: 1.0.0
tags:
  - issue
  - create
  - jira
  - github
  - bitbucket
---

# Issue Create Workflow

Create a ticket on Jira, GitHub, or Bitbucket from a structured input file. Supports `.json`,
`.yaml`, `.md`, and `.xml` formats. Command-line flags override values in the input file.

## Invocation

```bash
# Create from a JSON file on the primary platform
windsurf-agent issue:create ticket.json

# Create on a specific platform and project
windsurf-agent issue:create ticket.md --platform jira --project WBP

# Override the issue type at creation time
windsurf-agent issue:create ticket.yaml --platform github --type bug

# Validate and preview without creating
windsurf-agent issue:create ticket.json --dry-run
```

## Input File Formats

| Format | Extension |
|--------|-----------|
| JSON | `.json` |
| YAML | `.yaml`, `.yml` |
| Markdown | `.md` |
| XML | `.xml` |

The format is detected automatically from the file extension.

## Execution Steps

### Step 1: Read and Parse Input

- Resolve the input file path
- Detect format from extension and parse into a `UniversalTicket` object
- Apply command-line overrides (`--project`, `--type`) on top of the parsed values

### Step 2: Resolve Platform

- Read `--platform` option, falling back to `PRIMARY_PLATFORM` from `.env`

### Step 3: Dry Run (optional)

- If `--dry-run` is set, print a ticket preview and exit without creating
- Validates that the ticket is well-formed before any API call is made

### Step 4: Create Ticket

- Call the platform adapter to create the ticket
- Receive back a `TicketReference` containing `platform`, `key`, `id`, and `url`

### Step 5: Confirmation

- Print the platform, key, ID, and URL of the newly created ticket

## Evaluation Criteria

- Input file is parsed without errors for all supported formats
- Command-line overrides take precedence over input file values
- Ticket is created on the correct platform and project
- `--dry-run` validates and previews without making any API call
- A clear error is shown if the input file does not exist or cannot be parsed
