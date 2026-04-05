## API Authentication
`wf.config.*` is the runtime source of truth for provider and platform credentials. Configure Atlassian access under `atlassian.jira.apiToken` and `atlassian.bitbucket.apiToken`, and check the active project config before troubleshooting fallback environment compatibility.

## Debugging CLI Commands
When debugging `wf` commands, verify:
1. `LOG_LEVEL` is valid
2. The active `wf.config.*` AI entry has the expected `provider`, `apiKey`, `model`, and `default` values, and the required Atlassian credentials are set on the same config file
3. Anthropic prompt context comes from `CLAUDE.md` files loaded into prompts; it does not replace runtime provider configuration in `wf.config.*`
4. Command routing follows the NestJS pattern

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
