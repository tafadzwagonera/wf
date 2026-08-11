## Architecture
NestJS CLI app (`nest-commander`) where each `issue-*` command delegates to a domain agent (`src/agents/`) which calls an AI provider through adapter classes (`src/integrations/ai/adapters/`). Per-stage config in `wf.config.ts` controls which provider and whether the agent SDK or raw completion API is used. State and logs are file-system only (`.wf/`).

## Project Conventions
TypeScript NestJS project with CommonJS module format. Verify config files exist (Read/Glob) before referencing them.

## Git Workflow
Always `git add` before `git commit`. Never assume files are pre-staged.

## Manual Testing
After every fix or feature, run a manual test from `test/manual/` via `nr test:manual -- <test>`. Requires `antfu-collective/ni` and `"test:manual": "run-manual-test.ts"` in `package.json`.

## Test Conventions
- Jest 30, specs co-located as `*.spec.ts` next to source files in `src/`

## Common Pitfalls
- **Stale dist**: TypeScript changes have no effect until `nest build` runs. Manual tests use `ts-node` so they bypass dist — but CLI commands (`wf ...`) use `dist/`.
- **Unstaged files**: `ImplementerAgent` writes files to disk but does not run `git add` — the `CommitterAgent` expects a staged diff, so files must be staged between implement and commit.
- **Config not found**: `resolveConfigCwd` redirects config discovery to the target repo directory. When `-r`/`--repos` is provided but the repo cannot be resolved locally, bootstrap throws `ConfigurationError` with searched paths. Without `-r`, config falls back to cwd silently.
- **`.wf/` in commits**: `.wf/state/` and `.wf/logs/` are tooling artifacts created inside target repos — they must never be committed. Nothing in `.gitignore` protects them by default.

## Deep Reference (read on demand)
- `.claude/docs/debugging.md` — when a `wf` CLI command fails, hangs, or produces unexpected output
- `.claude/docs/config.md` — when adding, changing, or troubleshooting `wf.config.ts` fields
- `.claude/docs/integrations.md` — when working with Bitbucket, Jira, or Slack API auth
- `.claude/docs/technologies.md` — when checking dependency versions, available SDKs, or runtime constraints
- `.claude/docs/standards.md` — when writing or reviewing specs, services, or Zod schemas
