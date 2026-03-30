# Windsurf Workflow Automation Agent

A **NestJS-based CLI agent** that automates Windsurf workflows with staged execution, approval gates, and AI-powered decision-making.

## Features

- 🔄 **Staged Execution** - Execute workflows step-by-step with approval gates
- ♻️ **Retry Capabilities** - Retry failed stages with modified parameters
- 🎯 **Jira Integration** - Create, read, update Jira tickets with Markdown ↔ ADF conversion
- 🌳 **Git Automation** - Branch management, conventional commits, and more
- 🤖 **AI-Powered** - Claude integration for intelligent planning and code generation
- 💾 **State Management** - Pause and resume workflows at any point
- ✨ **Beautiful CLI** - Colored output, progress indicators, and interactive prompts

## Table of Contents

- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Commands](#commands)
  - [Issue API](#issue-api)
  - [Workflow Commands](#workflow-commands)
- [Workflows](#workflows)
- [Architecture](#architecture)
- [Development](#development)
- [Testing](#testing)

## Installation

```bash
# Clone the repository
cd /Users/tafadzwagonera/Projects/wf

# Install dependencies
yarn install

# Build the project
yarn build

# Link globally (optional)
npm link
```

## Configuration

### 1. Create `.env` file

Copy the example configuration:

```bash
cp .env.example .env
```

### 2. Configure Credentials

Edit `.env` with your credentials:

```bash
# ── Platform ──────────────────────────────────────────────────────────────────
# Comma-separated list of platforms to enable (jira, github, bitbucket).
# Omit to auto-detect based on configured credentials.
# ENABLED_PLATFORMS=jira,github,bitbucket
PRIMARY_PLATFORM=jira
DEFAULT_OUTPUT_FORMAT=md          # json | md | yaml | xml

# ── Claude AI ─────────────────────────────────────────────────────────────────
ANTHROPIC_API_KEY=sk-ant-xxxxx
AI_MODEL=claude-sonnet-4-20250514 # optional — this is the default
AI_MAX_TOKENS=4096                 # optional — this is the default

# ── Atlassian (Jira + Bitbucket) ──────────────────────────────────────────────
# Shared credentials for both services (both are Atlassian products).
ATLASSIAN_BASE_URL=https://yourcompany.atlassian.net
ATLASSIAN_EMAIL=your-email@company.com
ATLASSIAN_API_TOKEN=your-api-token

# Jira-specific
ATLASSIAN_JIRA_DEFAULT_PROJECT=   # e.g. WBP

# Bitbucket-specific
# API tokens required — app passwords were deprecated September 9, 2025.
ATLASSIAN_BITBUCKET_WORKSPACE=your-workspace

# ── GitHub ────────────────────────────────────────────────────────────────────
GITHUB_TOKEN=ghp_your-token       # optional
GITHUB_DEFAULT_REPO=owner/repo    # optional

# ── Git ───────────────────────────────────────────────────────────────────────
GIT_COMMIT_FORMAT=auto
GIT_DEFAULT_BRANCH=develop

# ── Branch Naming ─────────────────────────────────────────────────────────────
# Patterns are validated but not enforced — a warning is shown on mismatch.
# ATLASSIAN_BRANCH_PATTERN=^(bugfix|build|chore|ci|docs|feat|feature|fix|perf|performance|refactor|revert|style|test)\/[A-Z]+-[0-9]+__|__.+$
# GITHUB_BRANCH_PATTERN=^(bugfix|build|chore|ci|docs|feat|feature|fix|perf|performance|refactor|revert|style|test)\/[A-Za-z0-9_-]+$
BRANCH_PREFIX_IMPLEMENT=feature   # default
BRANCH_PREFIX_FIX=bugfix          # default
BRANCH_PREFIX_INVESTIGATE=chore   # default

# ── Workflow Engine ────────────────────────────────────────────────────────────
WORKFLOW_DIRECTORY=.windsurf/workflows
STATE_DIRECTORY=.wf/state
LOG_DIRECTORY=.wf/logs

# ── Application ───────────────────────────────────────────────────────────────
NODE_ENV=development
LOG_LEVEL=info
```

### 3. Platform Configuration

The CLI supports multiple platforms (Jira, GitHub, BitBucket). By default, it will only show warnings for platforms you've configured credentials for.

**Explicit Configuration:**

```bash
# Enable only specific platforms
ENABLED_PLATFORMS=jira,github
```

**Auto-Detection (Default):**
If `ENABLED_PLATFORMS` is not set, the CLI automatically detects which platforms you're using based on configured credentials. Only platforms with credentials will show configuration warnings.

**Disable All Warnings:**
Omit all platform credentials from `.env` to run without any platform integrations.

### 4. Generate API Tokens

**Anthropic API Key:**

- Go to: https://console.anthropic.com/settings/keys
- Create a new API key

**Jira API Token:**

- Go to: https://id.atlassian.com/manage-profile/security/api-tokens
- Create a new API token
- Ensure your Jira user has necessary project permissions

**BitBucket API Token** (for BitBucket platform support):

- Go to: BitBucket Settings → Personal Settings → App passwords → API tokens
- Create a new token with required scopes:
  - `repository:read` - Read repository data
  - `issue:read` - Read issues
  - `issue:write` - Create and update issues
  - `pullrequest:read` - Read pull requests
- Copy the generated token
- Set `ATLASSIAN_API_TOKEN` and `ATLASSIAN_BITBUCKET_WORKSPACE` in your `.env` file

**⚠️ Note:** BitBucket app passwords were deprecated on September 9, 2025. Only API tokens are supported.

## Usage

### Quick Start

```bash
# List available workflows
yarn start list

# Run a workflow
yarn start run test-workflow

# Fetch a ticket and generate a plan
wf issue:fetch WBP-2971 --platform jira
wf issue:plan WBP-2971 --action fix

# Run the complete issue workflow in one command
wf issue-all WBP-2971 --from fetch --to commit --action fix
```

## Commands

### Issue API

The issue API is a suite of commands for the full ticket lifecycle: fetch → plan → implement → review → commit. Commands prefixed with `issue:` are focused steps; `issue-all` orchestrates them together.

---

#### `wf issue:fetch <ticket-key>`

Fetch a ticket from a platform and save it as a local artifact. **Overwrites any existing local artifact.**

```bash
# Fetch using the primary platform from .env
wf issue:fetch WBP-2971

# Specify platform and output format
wf issue:fetch WBP-2971 --platform jira --format md

# Fetch a Bitbucket issue with a repo override
wf issue:fetch 123 --platform bitbucket --repo myworkspace/myrepo

# Preview what would happen without fetching
wf issue:fetch WBP-2971 --dry-run
```

**Options:**

| Flag                        | Description                                                    | Default                 |
| --------------------------- | -------------------------------------------------------------- | ----------------------- |
| `-f, --format <format>`     | Output format: `json \| md \| yaml \| xml`                     | `DEFAULT_OUTPUT_FORMAT` |
| `-p, --platform <platform>` | Source platform: `jira \| github \| bitbucket`                 | `PRIMARY_PLATFORM`      |
| `-r, --repos <repos...>`    | Space-separated repositories (`workspace/repo` or `repo-name`) | required                |
| `--dry-run`                 | Preview the fetch without writing files                        | —                       |

**Output:** saves to `./<platform>/<ticket-key>.<format>` (e.g., `./jira/WBP-2971.md`).

---

#### `wf issue:plan <ticket-key>`

Generate an AI implementation plan for a ticket. Reads from the local artifact saved by `issue:fetch`. If no local artifact exists, it is fetched first.

```bash
# Plan using a local artifact (default action: implement)
wf issue:plan WBP-2971

# Specify the resolution action
wf issue:plan WBP-2971 --action fix

# Force re-fetch of the ticket artifact before planning
wf issue:plan WBP-2971 --action investigate --force-recreate

# Save the plan in YAML instead of JSON
wf issue:plan WBP-2971 --action implement --format yaml

# Preview without making changes
wf issue:plan WBP-2971 --action fix --dry-run
```

**Options:**

| Flag                        | Description                                                    | Default            |
| --------------------------- | -------------------------------------------------------------- | ------------------ |
| `-a, --action <action>`     | Resolution action: `implement \| fix \| investigate`           | `implement`        |
| `-p, --platform <platform>` | Platform to fetch from if local artifact not found             | `PRIMARY_PLATFORM` |
| `--force-recreate`          | Re-fetch and overwrite the ticket artifact before planning     | —                  |
| `-f, --format <format>`     | Plan output format: `json \| md \| yaml`                       | `json`             |
| `-r, --repos <repos...>`    | Space-separated repositories (`workspace/repo` or `repo-name`) | required           |
| `--dry-run`                 | Preview without generating or writing files                    | —                  |

**Output:** saves to `./<platform>/<ticket-key>-plan-<action>.<format>` (e.g., `./jira/WBP-2971-plan-fix.json`).

---

#### `wf issue:review [source]`

AI-powered code review. Accepts four source modes:

| Source                 | Description                                              |
| ---------------------- | -------------------------------------------------------- |
| _(none)_               | Review staged/unstaged changes in the current repository |
| `ABC-123`              | Review changes in the current repo (context: the ticket) |
| `https://github.com/…` | Fetch and review a GitHub or Bitbucket pull request      |
| `./path/to/repo`       | Review changes in a specific local repository            |

```bash
# Review current repository changes
wf issue:review

# Review with ticket context
wf issue:review WBP-2971

# Review a GitHub PR
wf issue:review https://github.com/owner/repo/pull/42

# Review a local repo
wf issue:review ../my-other-repo

# Save review output to file
wf issue:review WBP-2971 --output ./jira/WBP-2971-review.md

# Preview without performing review
wf issue:review --dry-run
```

**Options:**

| Flag                    | Description                         | Default |
| ----------------------- | ----------------------------------- | ------- |
| `-f, --format <format>` | Output format: `text \| json \| md` | `text`  |
| `-o, --output <path>`   | Save review to a file               | stdout  |
| `--dry-run`             | Preview without calling the AI      | —       |

---

#### `wf issue:create <input>`

Create a ticket on a platform from a structured input file. Supports `.json`, `.yaml`, `.md`, and `.xml` formats.

```bash
# Create from a JSON file on the primary platform
wf issue:create ticket.json

# Create on a specific platform and project
wf issue:create ticket.md --platform jira --project WBP

# Override the issue type at creation time
wf issue:create ticket.yaml --platform github --type bug

# Validate without creating
wf issue:create ticket.json --dry-run
```

**Options:**

| Flag                        | Description                                        | Default            |
| --------------------------- | -------------------------------------------------- | ------------------ |
| `-p, --platform <platform>` | Target platform: `jira \| github \| bitbucket`     | `PRIMARY_PLATFORM` |
| `--project <project>`       | Project key (Jira) or `workspace/repo` (Bitbucket) | from input file    |
| `-t, --type <type>`         | Issue type: `task \| bug \| story \| todo`         | from input file    |
| `--dry-run`                 | Validate and preview without creating              | —                  |

---

#### `wf issue:generate <sources...>`

Synthesize a ticket description from one or more sources using AI. Sources can be local files, URLs, or existing ticket keys.

```bash
# Generate from a URL
wf issue:generate https://example.com/spec

# Generate from multiple sources (URL + local file + existing ticket)
wf issue:generate https://example.com/spec ./notes.md WBP-2971

# Save to platform directory
wf issue:generate ./requirements.md --save

# Override metadata and save to a specific file
wf issue:generate ./requirements.md \
  --title "Add OAuth2 support" \
  --type story \
  --priority high \
  --output ./jira/GENERATED-oauth2.md

# Fetch Bitbucket issues as sources
wf issue:generate 123 456 --platform bitbucket --repo myrepo --save

# Preview without fetching or generating
wf issue:generate https://example.com/spec ./notes.md --dry-run
```

**Options:**

| Flag                        | Description                                                     | Default                 |
| --------------------------- | --------------------------------------------------------------- | ----------------------- |
| `-f, --format <format>`     | Output format: `json \| md \| yaml \| xml`                      | `DEFAULT_OUTPUT_FORMAT` |
| `-o, --output <path>`       | Save generated ticket to a file                                 | stdout                  |
| `--save`                    | Save to `./<platform>/GENERATED-<date>-<title>.<format>`        | —                       |
| `-p, --platform <platform>` | Platform for ticket-key sources                                 | `PRIMARY_PLATFORM`      |
| `-t, --title <title>`       | Override the AI-generated title                                 | —                       |
| `--type <type>`             | Override ticket type: `task \| bug \| story \| epic`            | —                       |
| `--priority <priority>`     | Override priority: `highest \| high \| medium \| low \| lowest` | —                       |
| `--repo <repo>`             | Bitbucket repository for ticket-key sources                     | —                       |
| `--dry-run`                 | Preview without fetching or writing                             | —                       |

---

#### `wf issue:commit [ticket-key]`

Create a git commit with an AI-generated message. Automatically detects the ticket key from the current branch name if not provided.

```bash
# AI-generated message, ticket auto-detected from branch
wf issue:commit

# Explicit ticket key
wf issue:commit WBP-2971

# Force conventional commits format
wf issue:commit WBP-2971 --conventional

# Provide a manual message (bypasses AI)
wf issue:commit WBP-2971 --message "fix: correct null check in auth middleware"

# Preview without committing
wf issue:commit --dry-run
```

**Options:**

| Flag                      | Description                                                          | Default |
| ------------------------- | -------------------------------------------------------------------- | ------- |
| `-m, --message <message>` | Manual commit message — bypasses AI generation                       | —       |
| `--no-ai`                 | Require a manual `--message` (error if omitted)                      | —       |
| `--conventional`          | Force conventional commits format (`<type>(<scope>): <description>`) | —       |
| `--dry-run`               | Preview the commit without staging or committing                     | —       |

**Branch detection:** ticket keys are extracted from the branch name using the pattern `[A-Z]+-\d+` (e.g., `feature/WBP-2971__add-oauth` → `WBP-2971`).

---

#### `wf issue-all <ticket-key>`

Orchestrate the full issue workflow in a single command. Runs any contiguous range of stages: `fetch → plan → implement → review → commit`.

```bash
# Full workflow from scratch
wf issue-all WBP-2971 --from fetch --action fix

# Skip fetch if local artifact exists; run plan through review
wf issue-all WBP-2971 --from plan --to review --action implement

# Resume from implement (auto-discovers existing plan)
wf issue-all WBP-2971 --from implement

# Skip stages that already have artifacts
wf issue-all WBP-2971 --from fetch --action fix --skip-existing

# Interactive chat mode after plan and review stages
wf issue-all WBP-2971 --from fetch --action investigate --interactive

# Bitbucket with repo override
wf issue-all 123 --from fetch --to review --action fix \
  --platform bitbucket --repo myworkspace/myrepo

# Preview the full workflow without making changes
wf issue-all WBP-2971 --from fetch --action fix --dry-run
```

**Options:**

| Flag                        | Description                                                                            | Default            |
| --------------------------- | -------------------------------------------------------------------------------------- | ------------------ |
| `--from <stage>`            | **(Required)** Start stage: `fetch \| plan \| implement \| review \| commit`           | —                  |
| `--to <stage>`              | Stop stage (inclusive)                                                                 | `commit`           |
| `--action <action>`         | Resolution action: `implement \| fix \| investigate` — required when `plan` stage runs | —                  |
| `-p, --platform <platform>` | Platform: `jira \| github \| bitbucket`                                                | `PRIMARY_PLATFORM` |
| `--interactive`             | Open AI chat after `plan` and `review` stages                                          | —                  |
| `--skip-existing`           | Skip stages whose output artifact already exists                                       | —                  |
| `--repo <repo>`             | Bitbucket repository override (`workspace/repo` or `repo-name`)                        | —                  |
| `--dry-run`                 | Preview every stage without making changes                                             | —                  |

**Stage order and artifacts:**

| Stage       | Artifact                                                    |
| ----------- | ----------------------------------------------------------- |
| `fetch`     | `./<platform>/<ticket-key>.md`                              |
| `plan`      | `./<platform>/<ticket-key>-plan-<action>.json`              |
| `implement` | _(display only — branch name and steps printed)_            |
| `review`    | `./<platform>/<ticket-key>-review.md`                       |
| `commit`    | _(display only — commit commands printed for confirmation)_ |

**Branch naming:** `issue-all` generates a branch name in the format `<prefix>/<TICKET-KEY>__<slug>`, where prefix is controlled by `BRANCH_PREFIX_*` env vars (`feature`, `bugfix`, `chore`).

---

#### `wf issue-implement <ticket-key>` _(legacy)_

Simple implementation guide generator. Reads the ticket from `./jira/<ticket-key>.md` and prints an implementation plan. Superseded by `issue:plan` and `issue-all`.

```bash
wf issue-implement WBP-2971
```

---

### Bitbucket Repository

All `issue:*` commands that interact with Bitbucket require a `--repos` (`-r`) option.

```bash
# Single repository in full workspace/repo format
wf issue:fetch 123 --platform bitbucket --repos myworkspace/myrepo

# Single repository using repo name only (uses ATLASSIAN_BITBUCKET_WORKSPACE from env)
wf issue:fetch 123 --platform bitbucket --repos myrepo

# Multiple repositories (space-separated)
wf issue:fetch 123 --platform bitbucket --repos myworkspace/repo-a myworkspace/repo-b
```

**Repository format:**

- **Full format**: `workspace/repo` — explicit workspace and repository
- **Short format**: `repo` — uses `ATLASSIAN_BITBUCKET_WORKSPACE` from environment

---

### Workflow Commands

#### `wf list`

List all available workflows from `.windsurf/workflows/`.

```bash
yarn start list
```

#### `wf validate <workflow>`

Validate workflow syntax and structure.

```bash
yarn start validate test-workflow
yarn start validate ./custom-workflow.md
```

#### `wf run <workflow> [args]`

Execute a workflow with optional parameters.

```bash
yarn start run test-workflow
yarn start run workflow --params '{"key":"value"}'
yarn start run workflow --auto-execute
yarn start run workflow --dry-run
```

**Options:**

- `-p, --params <json>` - Parameters as JSON string
- `-a, --auto-execute` - Skip approval gates
- `-d, --dry-run` - Show workflow steps without executing

#### `wf history`

Show workflow execution history.

```bash
yarn start history
yarn start history --status completed
yarn start history --workflow test-workflow
yarn start history --limit 5
```

#### `wf resume <execution-id>`

Resume a paused or failed workflow.

```bash
yarn start resume a1b2c3d4
```

#### `wf config`

Manage agent configuration.

```bash
yarn start config get jira.baseUrl
yarn start config set jira.email user@example.com
yarn start config list
```

## Workflows

### Workflow File Format

Workflows are defined in Markdown files with YAML frontmatter:

```markdown
---
name: Example Workflow
description: A simple example workflow
autoExecutionMode: false
version: 1.0.0
tags:
  - example
  - demo
---

# Example Workflow

## Invocation

\`\`\`bash
wf run example-workflow
\`\`\`

## Execution Steps

### Step 1: Initialize

- Set up environment
- Validate prerequisites

### Step 2: Execute Task

- Run main workflow action
- Generate outputs

### Step 3: Review Results (Approval Required)

- Review outputs
- Wait for user confirmation

### Step 4: Cleanup

- Clean up temporary files
- Save final state

## Evaluation Criteria

- All steps complete successfully
- No errors encountered
- Output artifacts generated
```

### Workflow Discovery

Place workflow files in `.windsurf/workflows/`:

```
.windsurf/
└── workflows/
    ├── issue.md
    ├── git-commit.md
    ├── create-jira-ticket.md
    └── custom-workflow.md
```

### Approval Gates

Steps with keywords like "approval", "review", "confirm", or "wait for" automatically trigger approval gates:

```markdown
### Step 3: Review and Approve

- Review the generated code
- **Wait for user approval** before proceeding
```

When a workflow reaches an approval gate:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
APPROVAL REQUIRED: Review Stage Output
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[Stage outputs displayed here]

? What would you like to do?
  ❯ Proceed to next stage
    Retry this stage
    Skip this stage
    Cancel workflow
```

## Architecture

### Core Components

```
wf/
├── src/
│   ├── commands/              # CLI commands
│   │   ├── issue-all.command.ts
│   │   ├── issue-create.command.ts
│   │   ├── issue-fetch.command.ts
│   │   ├── issue-generate.command.ts
│   │   ├── issue-implement.command.ts  # legacy
│   │   ├── issue-commit.command.ts
│   │   ├── issue-plan.command.ts
│   │   ├── issue-review.command.ts
│   │   ├── run.command.ts
│   │   ├── list.command.ts
│   │   ├── validate.command.ts
│   │   ├── resume.command.ts
│   │   ├── history.command.ts
│   │   └── config.command.ts
│   │
│   ├── core/                  # Core workflow engine
│   │   ├── workflow-parser/   # Parse .md workflow files
│   │   ├── stage-engine/      # Execute workflow stages
│   │   ├── approval-system/   # Interactive approval gates
│   │   └── state-manager/     # Persist execution state
│   │
│   ├── integrations/          # External service integrations
│   │   ├── platforms/        # Platform adapters (Jira, GitHub, Bitbucket)
│   │   ├── git/              # Git operations
│   │   └── ai/               # Claude AI integration + conversation
│   │
│   ├── common/               # Shared types, DTOs, and format converters
│   ├── config/               # Configuration management
│   └── shared/               # Logger, preview, and error utilities
```

### Action Executors

The agent supports multiple action types:

1. **BashExecutor** - Execute shell commands
2. **FileExecutor** - File operations (read, write, delete)
3. **GitExecutor** - Git operations (branch, commit, push)
4. **JiraExecutor** - Jira ticket operations (CRUD)
5. **AIExecutor** - AI-powered tasks (planning, code review)

## Development

### Project Setup

```bash
# Install dependencies
yarn install

# Start development mode
yarn start:dev

# Build for production
yarn build

# Run tests
yarn test

# Run tests with coverage
yarn test:cov
```

### Create Custom Workflow

1. Create a new `.md` file in `.windsurf/workflows/`
2. Add YAML frontmatter with metadata
3. Define execution steps
4. Test with `wf validate`

### Directory Structure

```
.wf/
├── state/                 # Workflow execution state
│   └── <execution-id>.json
└── logs/                  # Application logs
    └── agent-2026-03-12.log
```

## Testing

### Unit Tests

```bash
# Run all unit tests
yarn test

# Run specific test file
yarn test jira.service.spec.ts

# Run with coverage
yarn test:cov
```

### Manual Testing

```bash
# Test Jira integration
yarn ts-node -r tsconfig-paths/register test/manual/test-jira.ts

# Test action executors
yarn ts-node -r tsconfig-paths/register test/manual/test-executors.ts

# Diagnose Jira permissions
yarn ts-node -r tsconfig-paths/register test/manual/diagnose-jira-permissions.ts
```

### Integration Tests

```bash
# Run integration tests
yarn test:e2e
```

## Troubleshooting

### Common Issues

**1. "Workflow not found"**

- Check that workflow file exists in `.windsurf/workflows/`
- Verify filename matches workflow name

**2. "Jira authentication failed"**

- Verify `ATLASSIAN_API_TOKEN` is correct and not expired
- Check user has necessary permissions
- Run diagnostic: `yarn ts-node -r tsconfig-paths/register test/manual/diagnose-jira-permissions.ts`

**3. "Claude API error"**

- Verify `ANTHROPIC_API_KEY` is set correctly
- Check API quota and billing

**4. "Git error"**

- Ensure you're in a git repository
- Check git status and permissions

**5. "Plan file not found"**

- Run `issue:plan` (or `issue-all --from plan`) before running `implement` or later stages
- If you specified `--action fix` at plan time, use the same action when resuming: `issue-all WBP-2971 --from implement --action fix`

**6. "Workspace required"**

- Set `ATLASSIAN_BITBUCKET_WORKSPACE` in `.env`, or pass `--repo workspace/repo` (full format)

### Debug Mode

Enable debug logging:

```bash
LOG_LEVEL=debug yarn start run workflow
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## License

UNLICENSED

## Support

For issues and questions:

- GitHub Issues: https://github.com/anthropics/claude-code/issues
- Documentation: This README

---

**Built with NestJS, TypeScript, and Claude AI** 🚀
