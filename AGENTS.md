## Architecture
NestJS CLI app (`nest-commander`) where each `issue-*` command delegates to a domain agent (`src/agents/`) which calls an AI provider through adapter classes (`src/integrations/ai/adapters/`). Per-stage config in `wf.config.ts` controls which provider and whether the agent SDK or raw completion API is used. State and logs are file-system only (`.wf/`).

## Project Conventions
TypeScript NestJS project with CommonJS module format. Confirm a config file exists (via Read or Glob) before referencing its path — `wf.config.ts` discovery falls back to cwd silently without `-r`, so a wrong assumption here fails quietly rather than loudly.

## Git Workflow
Stage every changed file with `git add` immediately before running `git commit` — the CommitterAgent reads the staged diff, not the working tree, so unstaged changes are silently excluded from the commit.

## Manual Testing
Run the matching manual test from `test/manual/` via `nr test:manual -- <test>` right after implementing a fix or feature, to confirm the change actually works through the compiled CLI path — unit tests alone don't catch `dist/`-only failures. Requires `antfu-collective/ni` and `"test:manual": "run-manual-test.ts"` in `package.json`.

## Test Conventions
- Jest 30, specs co-located as `*.spec.ts` next to source files in `src/`

## Common Pitfalls
- **Stale dist**: TypeScript changes have no effect until `nest build` runs. Manual tests use `ts-node` so they bypass dist — but CLI commands (`wf ...`) use `dist/`.
- **Config not found**: `resolveConfigCwd` redirects config discovery to the target repo directory. When `-r`/`--repos` is provided but the repo cannot be resolved locally, bootstrap throws `ConfigurationError` with searched paths. Without `-r`, config falls back to cwd silently.
- **`.wf/` in commits**: `.wf/state/` and `.wf/logs/` are tooling artifacts created inside target repos — they must never be committed. Nothing in `.gitignore` protects them by default.

## Deep Reference (read on demand)
- `.claude/docs/debugging.md` — when a `wf` CLI command fails, hangs, or produces unexpected output
- `.claude/docs/config.md` — when adding, changing, or troubleshooting `wf.config.ts` fields
- `.claude/docs/integrations.md` — when working with Bitbucket, Jira, or Slack API auth
- `.claude/docs/technologies.md` — when checking dependency versions, available SDKs, or runtime constraints
- `.claude/docs/standards.md` — when writing or reviewing specs, services, or Zod schemas
