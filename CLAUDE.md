## API Authentication
For Bitbucket/Jira: Use Basic Auth with app passwords (not OAuth).
`BITBUCKET_APP_PASSWORD` and `JIRA_API_TOKEN`. Do not cycle through auth
approaches — check existing config files first.
## Debugging CLI Commands
When debugging CLI commands (wf), always check:
1. `LOG_LEVEL` env var is valid
2. Required API keys are set (`ANTHROPIC_API_KEY`, `BITBUCKET_APP_PASSWORD`, `JIRA_API_TOKEN`)
3. Command routing matches the NestJS command pattern
Refer to `src/commands/issue-plan.command.ts` as the reference implementation.
## Project Conventions
This is a TypeScript NestJS project using ESM-compatible imports.
Do not assume config files like `.nvmrc` exist — verify with Read or Glob before referencing them.
## Manual Testing
After every fix or feature implementation, write or run a manual test following the pattern
in `test/manual/` using the relevant command (e.g., `nr test:manual -- <test>`).
This assumes that `antfu-collective/ni` is installed and that `package.json` has the
following entry: `"test:manual": "run-manual-test.ts"`.
