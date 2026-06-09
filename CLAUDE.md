## API Authentication
Bitbucket/Jira use Basic Auth (`atlassian.bitbucket.apiToken`, `atlassian.jira.apiToken` in `wf.config.*`). Check existing config files before trying other auth approaches.

## Debugging CLI Commands
When debugging `wf` commands, verify:
1. `LOG_LEVEL` is valid
2. The active provider's API key is set: `ANTHROPIC_API_KEY` (default), `GEMINI_API_KEY`, or `DEEPSEEK_API_KEY` — controlled by the `ai[].provider` config key; plus `atlassian.bitbucket.apiToken` and `atlassian.jira.apiToken` in `wf.config.*`
3. Command routing follows the NestJS pattern

Reference: `src/commands/issue-plan.command.ts`

## Project Conventions
TypeScript NestJS project with ESM-compatible imports. Verify config files exist (Read/Glob) before referencing them.

## Build & Test
Run `npm run build` after code changes before testing CLI commands.

## Git Workflow
Always `git add` before `git commit`. Never assume files are pre-staged.

## Manual Testing
After every fix or feature, run a manual test from `test/manual/` via `nr test:manual -- <test>`. Requires `antfu-collective/ni` and `"test:manual": "run-manual-test.ts"` in `package.json`.

## Active Technologies
- TypeScript 5.7 / Node.js 22 (v22.17.1 locally) + NestJS 11, nest-commander, chalk 4, @octokit/rest, jest 30 (001-ssh-cli-refactor)
- File system only (`.wf/state/`, `.wf/logs/`, platform artifact dirs) (001-ssh-cli-refactor)

## Recent Changes
- 001-ssh-cli-refactor: Added TypeScript 5.7 / Node.js 22 (v22.17.1 locally) + NestJS 11, nest-commander, chalk 4, @octokit/rest, jest 30
