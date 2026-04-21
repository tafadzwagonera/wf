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

Create one of these files in the consumer project root:

- `wf.config.js`
- `wf.config.mjs`
- `wf.config.ts`
- `wf.config.mts`
- `wf.config.yaml`
- `wf.config.yml`

When multiple files exist, `wf` uses this precedence order from top to bottom.

### JavaScript / TypeScript Example

```ts
import { defineConfig } from 'wf/config';

export default defineConfig({
  platforms: {
    primary: 'jira',
  },
  ai: [
    {
      provider: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: 'claude-sonnet-4-20250514',
      default: true,
    },
    {
      provider: 'google',
      apiKey: process.env.GEMINI_API_KEY,
      model: 'gemini-2.5-pro',
    },
  ],
  atlassian: {
    baseUrl: 'https://yourcompany.atlassian.net',
    email: 'your-email@company.com',
    jira: {
      apiToken: process.env.ATLASSIAN_JIRA_API_TOKEN,
      defaultProject: 'WBP',
    },
    bitbucket: {
      apiToken: process.env.ATLASSIAN_BITBUCKET_API_TOKEN,
      workspace: 'your-workspace',
    },
  },
  github: {
    token: process.env.GITHUB_TOKEN,
    defaultRepo: 'owner/repo',
  },
  git: {
    defaultBranch: 'develop',
    commitFormat: 'auto',
  },
  log: {
    directory: '.wf/logs',
    level: 'info',
  },
  state: {
    directory: '.wf/state',
  },
  stages: {
    plan: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    },
    implement: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      afterImplement: {
        baseMaxAttempts: 3,
        maxProgressExtensions: 2,
        absoluteMaxAttempts: 5,
        fingerprintLineCount: 40,
        policyFile: 'verification.policy.json',
        requireStateChangeForRetry: true,
        retryOnSameFailure: false,
      },
    },
    review: {
      provider: 'google',
      model: 'gemini-2.5-pro',
    },
  },
});
```

### YAML Example

```yaml
platforms:
  primary: jira
ai:
  - provider: anthropic
    apiKey: ${ANTHROPIC_API_KEY}
    model: claude-sonnet-4-20250514
    default: true
atlassian:
  baseUrl: https://yourcompany.atlassian.net
  email: your-email@company.com
  jira:
    apiToken: ${ATLASSIAN_JIRA_API_TOKEN}
    defaultProject: WBP
log:
  directory: .wf/logs
  level: info
stages:
  plan:
    provider: anthropic
    model: claude-sonnet-4-20250514
  implement:
    provider: anthropic
    model: claude-sonnet-4-20250514
    afterImplement:
      policyFile: verification.policy.json
  review:
    provider: google
    model: gemini-2.5-pro
```

Example verification manifest:

```json
{
  "version": 1,
  "baseline": [
    { "id": "format", "run": "npm run format", "policy": "enforced" },
    { "id": "lint", "run": "npm run lint", "policy": "enforced" },
    { "id": "build", "run": "npm run build", "policy": "enforced" }
  ]
}
```

### TypeScript Config Support

- Bun and Deno support TypeScript config files natively.
- Node.js supports TypeScript configs natively on `>= 22.13.0` when started with `--experimental-strip-types`.
- Otherwise install `jiti@>=2.2.0` in the consumer project. `wf` does not install it for you.

```bash
npm install --save-dev jiti
```

```bash
node --experimental-strip-types ./node_modules/.bin/wf issue:fetch WBP-2971
```

### Defaults and Notes

- Built-in defaults cover provider/model selection, branch prefixes, workflow directory, state/log directories, and log level.
- `ai[].provider` selects the backing AI provider for each entry.
- `ai[].default` is optional when only one provider is configured, and required when two or more providers are configured.
- `ai[].maxTokens` is only applied to Gemini provider entries using Gemini models; other providers ignore it.
- `stages.plan`, `stages.review`, `stages.generate`, and `stages.commit` accept `{ provider, model }`.
- `stages.implement` accepts `{ provider, model, afterImplement? }`.
- Stage targets explicitly override the default `ai.provider` and `ai.model`.
- Prefer `afterImplement.policyFile` to point at a repository-owned verification manifest. This keeps baseline verification policy tool-agnostic and reusable from CI or other executors.
- `afterImplement.scripts` remains supported as a fallback when a manifest is not present.
- Manifest baseline checks run in declaration order. Recommended sequence: `format` → `lint --fix` → `lint` → `build`. This removes formatting noise before the final lint/build gate and makes retries focus on real code issues.
- Prefer portable wrappers such as `npm run lint`, `bash ./scripts/verify.sh`, or `node ./scripts/verify.mjs` instead of relying on executable bits or shell-specific features.
- `fetch` cannot be overridden.
- `wf config get` and `wf config list` read the normalized runtime config.
- `wf config set` is advisory only and points you at the config file to edit.

### Generate API Tokens

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
- Set `atlassian.bitbucket.apiToken` and `atlassian.bitbucket.workspace` in `wf.config.*`

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
wf issue WBP-2971 --from fetch --to commit --action fix
```

## Commands

### Issue API

The issue API is a suite of commands for the full ticket lifecycle: fetch → plan → implement → review → commit. Commands prefixed with `issue:` are focused steps; `issue` orchestrates them together.

---

#### `wf issue:fetch <ticket-key>`

Fetch a ticket from a platform and save it as a local artifact. **Overwrites any existing local artifact.**

```bash
# Fetch using the primary platform from wf.config.*
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

Generate an AI implementation plan for a ticket, or synthesize a canonical custom plan from a markdown source artifact. Reads from the local artifact saved by `issue:fetch`. If no local ticket artifact exists, it is fetched first.

Targeted verification commands are stored as **repo-root-relative** commands. If
the plan generator emits a redundant `cd <selected-repo> && ...`, `issue:plan`
normalizes it before writing the artifact. If a targeted check tries to `cd`
outside the selected repo, the plan is rejected.

```bash
# Specify the resolution action
wf issue:plan WBP-2971 --action fix

# Create a custom feature plan from a markdown artifact
wf issue:plan --action feature --custom jira/bar.md

# Prefer the repo-scoped custom artifact when a repo is supplied
wf issue:plan --action feature --custom bar.md --repos repo-a

# Save the custom plan as YAML
wf issue:plan --action fix --custom docs/notes.md --format yaml

# Save the plan in YAML instead of JSON
wf issue:plan WBP-2971 --action investigate --format yaml

# Force re-fetch of the ticket artifact before planning
wf issue:plan WBP-2971 --action investigate --force

# Preview without making changes
wf issue:plan WBP-2971 --action fix --dry-run
```

**Options:**

| Flag                        | Description                                                    | Default            |
| --------------------------- | -------------------------------------------------------------- | ------------------ |
| `-a, --action <action>`     | Resolution action: `feature \| fix \| investigate`             | required           |
| `-c, --custom <source.md>`  | Custom markdown source artifact for plan synthesis             | —                  |
| `--dry-run`                 | Preview without generating or writing files                    | —                  |
| `--force`                   | Force fetch and recreate ticket artifact before planning       | —                  |
| `-p, --platform <platform>` | Platform to fetch from if local artifact not found             | `PRIMARY_PLATFORM` |
| `-f, --format <format>`     | Plan output format: `json \| md \| yaml`                       | `json`             |
| `-r, --repos <repos...>`    | Space-separated repositories (`workspace/repo` or `repo-name`) | required           |

When `--repos` is present, filename-only custom sources are resolved against the repo-scoped `~/.wf/<repo>/` artifact directory before cwd-relative paths.

**Output:** saves to `./<platform>/<hash>-<action>-plan.<format>` for both ticket-backed and custom plans. A sidecar `.<format>.sources.json` manifest records the original ticket key or custom source name so `issue:implement` can resolve the artifact later.

---

#### `wf issue:review [source]`

AI-powered code review. Accepts three source modes:

| Source                 | Description                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------ |
| _(none)_               | Review staged/unstaged changes in the current repo, or all repos listed in `--repos` |
| `ABC-123`              | Fetch ticket context and review associated pull requests, or prompt for local review |
| `https://github.com/…` | Fetch and review a GitHub or Bitbucket pull request                                  |

```bash
# Review current repository changes
wf issue:review

# Review with ticket context
wf issue:review WBP-2971 --platform jira

# Review a ticket and its associated PRs across repos
wf issue:review WBP-2971 --platform jira --repos service-tourv3

# Review a GitHub PR
wf issue:review https://github.com/owner/repo/pull/42

# Save review output to file
wf issue:review WBP-2971 --output ./jira/WBP-2971-review.md

# Preview without performing review
wf issue:review --dry-run
```

**Options:**

| Flag                     | Description                                                                        | Default      |
| ------------------------ | ---------------------------------------------------------------------------------- | ------------ |
| `-f, --format <format>`  | Output format: `text \| json \| md`                                                | `text`       |
| `-o, --output <path>`    | Save review to a file                                                              | stdout       |
| `-p, --platform <platform>` | Platform used to resolve a ticket source; defaults to the configured primary platform | primary platform |
| `-r, --repos <repos...>` | First repo anchors local review context; all repos are inspected for local changes | current repo |
| `--dry-run`              | Preview without calling the AI                                                     | —            |

When a ticket key is supplied, `issue:review` fetches ticket context from the configured platform, looks for associated open pull requests in deterministic order, and reviews those PR diffs first. If no PR is found, the command warns and prompts whether to review local changes or return without reviewing.

The current review output includes `Call Stack` and `State Transition` sections before `Suggestions`, and `Approval Status` after `Suggestions`. Those trace sections are intended to describe the changed code path itself. If the model cannot ground them in concrete identifiers from the diff, the CLI downgrades them to `unavailable` instead of surfacing reviewer-analysis text.

---

#### `wf issue:create <input>`

Create a ticket on a platform from a structured input file. Supports `.json`, `.yaml`, `.md`, and `.xml` formats.

```bash
# Create from a JSON file on the primary platform
wf issue:create ticket.json

# Create on a specific platform and Jira project
wf issue:create ticket.md --platform jira --ticket-project WBP

# Create on Jira with an explicit issue type override
wf issue:create ticket.md --platform jira --ticket-project WBP --type story

# Override the issue type at creation time
wf issue:create ticket.yaml --platform github --type bug

# Validate without creating
wf issue:create ticket.json --dry-run
```

**Options:**

| Flag                         | Description                                                                        | Default            |
| ---------------------------- | ---------------------------------------------------------------------------------- | ------------------ |
| `-p, --platform <platform>`  | Target platform: `jira \| github \| bitbucket`                                     | `PRIMARY_PLATFORM` |
| `-r, --repos <repos...>`     | Only the first repo is used for artifact lookup; extras are ignored with a warning | current repo       |
| `--ticket-project <project>` | Project key (Jira) or `workspace/repo` (Bitbucket)                                 | from input file    |
| `-t, --type <type>`          | Issue type: `task \| bug \| story \| todo`                                         | from input file    |
| `--dry-run`                  | Validate and preview without creating                                              | —                  |

When creating Jira tickets, `wf` first resolves the requested priority against
the Jira instance. If Jira still rejects the priority during creation, `wf`
retries once without the priority field so ticket creation can still succeed.

---

#### `wf issue:generate <sources...>`

 Synthesize a ticket description from one or more sources using AI. Sources can be local files, repo-scoped artifacts under `~/.wf/<repo>/` when `--repos` is supplied, URLs, or existing ticket keys.

```bash
# Generate from a URL
wf issue:generate https://example.com/spec

# Generate from multiple sources (URL + local file + existing ticket)
wf issue:generate https://example.com/spec ./notes.md WBP-2971

# Generate from a repo-scoped artifact in the targeted repo namespace
wf issue:generate itinerary-pdf-generation.md -r service-tourv3

# Save to platform directory
wf issue:generate ./requirements.md --save

# Look up the original sources for a generated artifact hash
wf issue:generate:lookup 1a2b3c4d

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

| Flag                        | Description                                                          | Default                 |
| --------------------------- | -------------------------------------------------------------------- | ----------------------- |
| `-f, --format <format>`     | Output format: `json \| md \| yaml \| xml`                           | `DEFAULT_OUTPUT_FORMAT` |
| `-o, --output <path>`       | Save generated ticket to a file                                      | stdout                  |
| `--save`                    | Save to `./<platform>/YYYY-MM-DD-<hash>-ticket-description.<format>` | —                       |
| `-p, --platform <platform>` | Platform for ticket-key sources                                      | `PRIMARY_PLATFORM`      |
| `-t, --title <title>`       | Override the AI-generated title                                      | —                       |
| `--type <type>`             | Override ticket type: `task \| bug \| story \| epic`                 | —                       |
| `--priority <priority>`     | Override priority: `highest \| high \| medium \| low \| lowest`      | —                       |
| `-r, --repos <repos...>`    | Repo context for repo-scoped artifacts; first repo also anchors Bitbucket ticket-key sources | current repo            |
| `--dry-run`                 | Preview without fetching or writing                                  | —                       |

Generated artifacts are saved with a sidecar manifest file named `YYYY-MM-DD-<hash>-ticket-description.sources.json` in the same directory. Use `wf issue:generate:lookup <hash>` to print the original source list.
When `--repos` is provided, filename-only local sources are resolved against the repo-scoped artifact directory first, then the live checkout path. Without `--repos`, unresolved bare filenames stay cwd-relative and the command now tells you to retry with `--repos <repo>` when the source looks like a repo-scoped artifact.

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

# Run the commit stage from source with conventional commits enabled
yarn start issue:commit -c

# Provide a manual message (bypasses AI)
wf issue:commit WBP-2971 --message "fix: correct null check in auth middleware"

# Preview without committing
wf issue:commit --dry-run
```

**Options:**

| Flag                      | Description                                                                               | Default      |
| ------------------------- | ----------------------------------------------------------------------------------------- | ------------ |
| `-m, --message <message>` | Manual commit message — bypasses AI generation                                            | —            |
| `--no-ai`                 | Require a manual `--message` (error if omitted)                                           | —            |
| `--conventional`          | Force conventional commits format (`<type>(<scope>): <description>`)                      | —            |
| `-r, --repos <repos...>`  | Only the first repo is used as the commit working tree; extras are ignored with a warning | current repo |
| `--dry-run`               | Preview the commit without staging or committing                                          | —            |

**Branch detection:** ticket keys are extracted from the branch name using the pattern `[A-Z]+-\d+` (e.g., `feature/WBP-2971__add-oauth` → `WBP-2971`).

---

#### `wf issue:pr [ticket-key]`

Create a pull request on the hosting platform with the ticket key in the title and plan artifact as the body.

```bash
# Create a PR using the ticket key
wf issue:pr WBP-2971

# Preview the PR without creating it
wf issue:pr WBP-2971 --dry-run
```

**Options:**

| Flag                        | Description                                                    | Default            |
| --------------------------- | -------------------------------------------------------------- | ------------------ |
| `-a, --action <action>`     | Resolution action used to locate the plan artifact             | `implement`        |
| `-b, --base <branch>`       | Base branch for the pull request                               | default branch     |
| `--dry-run`                 | Preview the PR without creating it                             | —                  |
| `-p, --platform <platform>` | Target platform: `github \| bitbucket`                         | `PRIMARY_PLATFORM` |
| `-r, --repos <repos...>`    | Only the first repo is used; extras are ignored with a warning | —                  |
| `-t, --title <title>`       | Override the auto-generated PR title                           | —                  |

---

#### `wf issue <ticket-key-or-plan-token>`

Orchestrate the full issue workflow in a single command. Runs any contiguous range of stages: `fetch → plan → implement → review → commit`.

```bash
# Full workflow from scratch
wf issue WBP-2971 --from fetch --action fix

# Resume from plan and run through review
wf issue WBP-2971 --from plan --to review --action fix

# Resume from implement (auto-discovers existing plan)
wf issue WBP-2971 --from implement

# Resume from a hashed plan artifact without --action
wf issue 1a2b3c4d-fix-plan.json --from implement

# Force refresh even when local artifacts already exist
wf issue WBP-2971 --from fetch --action fix --force

# Interactive chat mode after plan and review stages
wf issue WBP-2971 --from fetch --action investigate --chat-mode

# Bitbucket with repos override
wf issue 123 --from fetch --to review --action fix \
  --platform bitbucket --repos myworkspace/myrepo

# Preview the full workflow without making changes
wf issue WBP-2971 --from fetch --action fix --dry-run
```

**Options:**

| Flag                        | Description                                                                                                                              | Default            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `--from <stage>`            | **(Required)** Start stage: `fetch \| plan \| implement \| review \| commit`                                                             | —                  |
| `--to <stage>`              | Stop stage (inclusive)                                                                                                                   | `commit`           |
| `--action <action>`         | Resolution action: `feature \| fix \| investigate` — required when `plan` stage runs, optional when resuming from a hashed plan artifact | —                  |
| `-p, --platform <platform>` | Platform: `jira \| github \| bitbucket`                                                                                                  | `PRIMARY_PLATFORM` |
| `--pr`                      | Create PR after commit stage                                                                                                             | false              |
| `--chat-mode`               | Open AI chat after `plan` and `review` stages                                                                                            | —                  |
| `--force`                   | Recreate artifacts instead of using the default skip-existing behavior                                                                   | false              |
| `--dry-run`                 | Preview every stage without making changes, including branch and file work                                                               | —                  |
| `-r, --repos <repos...>`    | First repo anchors artifact storage; all repos are used as workflow context                                                              | current repo       |

**Stage order and artifacts:**

| Stage       | Artifact                                                                         |
| ----------- | -------------------------------------------------------------------------------- |
| `fetch`     | `./<platform>/<ticket-key>.md`                                                   |
| `plan`      | `./<platform>/<hash>-<action>-plan.json` with a `.sources.json` sidecar manifest |
| `implement` | working tree updates in the selected repo plus branch setup                      |
| `review`    | `./<platform>/<ticket-key>-review.md`                                            |
| `commit`    | _(display only — commit commands printed for confirmation)_                      |

**Branch naming:** `issue` generates a branch name in the format `<prefix>/<TICKET-KEY>__<slug>`, where prefix is controlled by `BRANCH_PREFIX_*` env vars (`feature`, `bugfix`, `chore`).

---

#### `wf issue:implement <ticket-key-or-plan-token>`

Execute an existing canonical plan artifact. Ticket keys resolve the single standard plan for that ticket. Hashed plan tokens and hashed filenames resolve through the local manifest and can be resumed without `--action`; legacy custom filenames still resolve during migration.

```bash
# Execute the standard plan for a ticket
wf issue:implement WBP-2971

# Execute with a single repository
wf issue:implement WBP-2971 --repos my-repo

# Execute with multiple repositories (first anchors verification; siblings are context)
wf issue:implement WBP-2971 --repos repo-a repo-b

# Execute a hashed plan artifact
wf issue:implement 1a2b3c4d-feature-plan.json

# Resume from a hashed plan token
wf issue:implement 1a2b3c4d

# Run the same command from source while developing wf itself
yarn start issue:implement WBP-2971 --dry-run

# Preview branch and file work for a custom plan
wf issue:implement 1a2b3c4d-fix-plan.json --dry-run
```

When a hashed plan artifact is detected, the CLI prints a yellow warning with the decoded artifact and action so you can confirm the resolved plan before implementation starts. Supplying `--action` alongside a hashed artifact still performs a strict validation check against the filename and manifest contents.

Runtime backend selection is separate from plan metadata:

- `plan.provider` tags the plan/model for analysis and reporting.
- `stages.implement.experimentalAgent: true` enables the experimental agent backend.
- `stages.implement.provider: anthropic` selects `anthropic-agent`.
- `stages.implement.provider: openai` selects `openai-agent`.
- If the experimental flag is disabled, or the provider is neither `anthropic` nor `openai`, the command falls back to the standard two-phase retry backend.
- When either experimental agent backend is active, the CLI streams task and tool progress lines while the agent is working, so the implementation loop is no longer a black box.
- Both experimental backends emit heuristic progress signals so the agent can keep moving when verification is trending in the right direction.
- The OpenAI backend exposes only an exact-match `verify_command` tool for whitelisted verification commands.

Example:

```yaml
ai:
  - provider: anthropic
    apiKey: ${ANTHROPIC_API_KEY}
    model: claude-sonnet-4-6
    default: true
  - provider: openai
    apiKey: ${OPENAI_API_KEY}
    model: gpt-5.4-mini
stages:
  implement:
    provider: openai
    model: gpt-5.4-mini
    experimentalAgent: true
```

The `stages.implement.provider` and `stages.implement.model` values above are runtime implementation settings. The same shape may also appear in generated plan artifacts, but the plan artifact provider is informational and does not change backend selection by itself.

### Retry strategy

`issue:implement` uses a **two-phase retry** strategy when verification fails:

1. **Diagnosis** — the AI receives all failing file contents, related type
   definitions (depth-1 import chain, up to 10 files), repo-level test
   runner context (`package.json` plus common config files such as
   `jest.config.ts`), and test sources, and returns a structured fix plan.
2. **Execution** — each file is regenerated using the fix plan as shared
   context. When diagnostics implicate a spec/test file, the retry scope
   expands to its paired implementation file, and vice versa. Once the retry
   scope has been narrowed, later retries stay pinned to that smallest
   implicated file set unless newer diagnostics explicitly name additional
   files. Sibling repositories passed via `--repos` are available for
   cross-repo type reads; writes remain scoped to the primary repository.

The retry controller is **history-aware**, not just attempt-to-attempt. It
tracks the deepest verification stage reached so far and the severity of the
error classes seen there. That means `issue:implement` can keep going when a
later-stage framework/type failure is resolved and the next pass regresses to
an earlier script with only small residual lint/type cleanup left, instead of
stopping just because the failing command moved earlier.

Repo context is also injected into the implement and diagnosis prompts to
reduce **test framework drift**. If the selected repository advertises Jest via
`package.json` or `jest.config.*`, retries explicitly tell the model to stay on
Jest conventions and avoid introducing `vitest` imports unless Vitest is
already configured, and vice versa.

Verification commands are expected to run from the selected repository root.
Recent `issue:plan` builds normalize redundant `cd <repo> && ...` wrappers
before persisting the plan artifact. `issue:implement` keeps a defense-in-depth
fallback for older artifacts and fails fast when a targeted verification command
tries to jump outside the selected repository, because retrying code generation
cannot fix a mis-scoped verification command.

This makes `wf issue:implement` safer for common source/spec regressions:

```bash
# Retry a ticket-backed plan with a paired source/spec update
wf issue:implement WBP-2971 --repos repo-a

# Retry with read-only sibling repo context while still writing only repo-a
wf issue:implement WBP-2971 --repos repo-a repo-b

# Re-run an implement stage with repo context so retries can stay aligned with
# the repo's configured test framework and verification stack
wf issue:implement WBP-2971 --repos service-tourv3

# Execute a custom plan artifact and let retries stay pinned to the files
# named by the latest verification failure
wf issue:implement dark-building-creek-fix.json --repos service-tourv3
```

#### Experimental: Anthropic and OpenAI agent backends

Set `stages.implement.experimentalAgent: true` in `wf.config.*` and select
`stages.implement.provider: anthropic` or `stages.implement.provider: openai`
to use the experimental agent backend. The agent drives its own inner loop via
built-in tools, iterating until verification passes. The Anthropic backend
loads `~/.claude/CLAUDE.md` and the repository-root `CLAUDE.md`; the OpenAI
backend loads `~/.openai/OPENAI.md` and the repository-root `.openai/OPENAI.md`.
If a backend-specific file is missing, it logs a yellow warning and continues.
The OpenAI backend only exposes an exact-match `verify_command` tool for
verification, so non-whitelisted commands are rejected before execution. Both
experimental backends emit heuristic progress signals to encourage continued
work when verification is converging. If the experimental flag is disabled or
the provider is anything else, `wf issue:implement` falls back to the
standard two-phase path.

```yaml
stages:
  implement:
    experimentalAgent: true
    provider: openai
    model: gpt-5.4-mini
    afterImplement:
      baseMaxAttempts: 3
      maxProgressExtensions: 2
      absoluteMaxAttempts: 5
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

Inspect the resolved runtime configuration.

```bash
yarn start config get atlassian.baseUrl
yarn start config set atlassian.email user@example.com
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
│   │   ├── issue.command.ts
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

- Verify `atlassian.jira.apiToken` is correct and not expired
- Check user has necessary permissions
- Run diagnostic: `yarn ts-node -r tsconfig-paths/register test/manual/diagnose-jira-permissions.ts`

**3. "Claude API error"**

- Verify the active Anthropic provider entry in `wf.config.*` has a valid `apiKey`
- Check API quota and billing

**4. "Git error"**

- Ensure you're in a git repository
- Check git status and permissions

**5. "Plan file not found"**

- Run `issue:plan` (or `issue --from plan`) before running `implement` or later stages
- If you resume from a ticket key, keep `--action` aligned with the existing plan; if you resume from a hashed plan artifact, the action is decoded automatically and `--action` becomes optional

**6. "Workspace required"**

- Set `atlassian.bitbucket.workspace` in `wf.config.*`, or pass `--repo workspace/repo` (full format)

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
