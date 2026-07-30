## Architecture
NestJS CLI app (`nest-commander`) where each `issue-*` command delegates to a domain agent (`src/agents/`) which calls an AI provider through adapter classes (`src/integrations/ai/adapters/`). Per-stage config in `wf.config.ts` controls which provider and whether the agent SDK or raw completion API is used. State and logs are file-system only (`.wf/`).

## API Authentication
Bitbucket/Jira use Basic Auth (`atlassian.bitbucket.apiToken`, `atlassian.jira.apiToken` in `wf.config.ts`). Slack uses bot/user tokens (`slack.botToken`, `slack.userToken`). Check existing config before trying other auth approaches.

## Debugging CLI Commands
When debugging `wf` commands, verify:
1. `LOG_LEVEL` is valid (config: `log.level`)
2. The active provider's API key is set: `ANTHROPIC_API_KEY` (default), `OPENAI_API_KEY`, or `GEMINI_API_KEY` — controlled by `ai[].provider` and per-stage overrides in `stages.<command>.provider`
3. Command routing follows the NestJS pattern

Reference: `src/commands/issue-plan.command.ts`

## Project Conventions
TypeScript NestJS project with CommonJS module format. Verify config files exist (Read/Glob) before referencing them.

## Config Structure (`wf.config.ts`)
- `ai[]` — provider entries (anthropic, openai, google) with `default: true` to set the default
- `stages.<command>` — per-stage overrides: `provider`, `agent` (boolean), `verificationConditions`
- `atlassian`, `slack`, `git`, `branching`, `state`, `log`, `app`, `workflows`, `output`

## Build & Test
Run `yarn build` after code changes before testing CLI commands.

## Git Workflow
Always `git add` before `git commit`. Never assume files are pre-staged.

## Manual Testing
After every fix or feature, run a manual test from `test/manual/` via `nr test:manual -- <test>`. Requires `antfu-collective/ni` and `"test:manual": "run-manual-test.ts"` in `package.json`.

## Test Conventions
- Jest 30, specs co-located as `*.spec.ts` next to source files in `src/`
- Prefix mocks with `mock` and create matching factories: `mockEvent`, `createMockEvent`
- Nest `describe` suites around user cases and business outcomes, not implementation details

## Common Pitfalls
- **Stale dist**: TypeScript changes have no effect until `nest build` runs. Manual tests use `ts-node` so they bypass dist — but CLI commands (`wf ...`) use `dist/`.
- **Unstaged files**: `ImplementerAgent` writes files to disk but does not run `git add` — the `CommitterAgent` expects a staged diff, so files must be staged between implement and commit.
- **Config not found**: `resolveConfigCwd` redirects config discovery to the target repo directory. When `-r`/`--repos` is provided but the repo cannot be resolved locally, bootstrap throws `ConfigurationError` with searched paths. Without `-r`, config falls back to cwd silently.
- **`.wf/` in commits**: `.wf/state/` and `.wf/logs/` are tooling artifacts created inside target repos — they must never be committed. Nothing in `.gitignore` protects them by default.

## Active Technologies
- TypeScript 5.9 / Node.js 22 (v22.17.1 locally) + NestJS 11, nest-commander, chalk 4, jest 30
- AI: `@anthropic-ai/sdk` + `@anthropic-ai/claude-agent-sdk`, `openai` + `@openai/agents`, `@google/generative-ai`
- Integrations: `@octokit/rest`, `bitbucket`, `simple-git`, `inquirer`, `marked`, `zod`, `yaml`
- File system only (`.wf/state/`, `.wf/logs/`, platform artifact dirs)
