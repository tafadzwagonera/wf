## API Authentication
Bitbucket/Jira use Basic Auth (`BITBUCKET_APP_PASSWORD`, `JIRA_API_TOKEN`). Check existing config files before trying other auth approaches.

## Debugging CLI Commands
When debugging `wf` commands, verify:
1. `LOG_LEVEL` is valid
2. The active provider's API key is set: `ANTHROPIC_API_KEY` (default), `GEMINI_API_KEY`, or `DEEPSEEK_API_KEY` — controlled by `AI_PROVIDER`; plus `BITBUCKET_APP_PASSWORD` and `JIRA_API_TOKEN`
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
