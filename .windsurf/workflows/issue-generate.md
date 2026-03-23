---
name: Issue Generate
description: Synthesize a ticket description from multiple sources using AI
autoExecutionMode: true
version: 1.0.0
tags:
  - issue
  - generate
  - ai
---

# Issue Generate Workflow

Synthesize a ticket description from one or more sources using AI. Sources can be URLs, local
files, or existing ticket keys. The AI collates all content into a single, structured ticket.

## Invocation

```bash
# Generate from a single URL
windsurf-agent issue:generate https://example.com/spec

# Synthesize from multiple sources
windsurf-agent issue:generate https://example.com/spec ./notes.md WBP-2971

# Save to the platform directory
windsurf-agent issue:generate ./requirements.md --save

# Override metadata and save to a specific file
windsurf-agent issue:generate ./requirements.md \
  --title "Add OAuth2 support" \
  --type story \
  --priority high \
  --output ./jira/GENERATED-oauth2.md

# Use Bitbucket issues as sources
windsurf-agent issue:generate 123 456 --platform bitbucket --repo myrepo --save

# Preview without fetching or generating
windsurf-agent issue:generate https://example.com/spec ./notes.md --dry-run
```

## Source Types

| Source | Detection |
|--------|-----------|
| URL | Starts with `http://` or `https://` |
| Local file | Path exists on disk (`.json`, `.yaml`, `.md`, `.xml`, or plain text) |
| Ticket key | Matches pattern `[A-Z]+-\d+` (e.g., `WBP-2971`) |

## Execution Steps

### Step 1: Fetch All Sources

For each source argument:
- **URL** — HTTP GET with a 10-second timeout; content passed as-is to the AI
- **Local file** — read from disk; attempt to parse as a structured ticket if the
  extension is a supported format (`.json`, `.yaml`, `.md`, `.xml`)
- **Ticket key** — fetch from the platform adapter (applying `--repo` override for Bitbucket)

### Step 2: AI Synthesis

- Send all source contents to Claude with a synthesis prompt
- Claude produces a single Markdown ticket with:
  - A clear, concise title
  - Type and priority metadata
  - A unified description combining information from all sources
- If a single source is already a parsed ticket, it is returned directly without an AI call

### Step 3: Apply Metadata Overrides

- Apply `--title`, `--type`, and `--priority` on top of the AI-generated ticket if provided

### Step 4: Serialise Output

- Convert the ticket to the requested format (`--format`; default: `DEFAULT_OUTPUT_FORMAT`)
- Output to stdout, `--output <path>`, or `./<platform>/GENERATED-<date>-<title>.<format>`
  when `--save` is set (options are not mutually exclusive)

## Evaluation Criteria

- All sources are fetched; failed sources are warned and skipped, not fatal
- AI synthesis produces a coherent, well-structured ticket
- Metadata overrides take precedence over AI-generated values
- `--save` writes to the correct platform directory with a timestamped filename
- `--dry-run` previews all API calls and file writes without executing them
