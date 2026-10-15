---
name: commit
description: Git commit lifecycle — pre-commit checks, staging discipline, and post-commit build. Use when committing code changes, running git add, or preparing a commit.
---

Goal: every commit contains exactly the intended changes, and the built CLI reflects them.

## Pre-commit checks

- Remove a stale `.git/index.lock` before `git add` or `git commit` (e.g. `rm -f .git/index.lock && git add ...`). Denied or interrupted git tool calls leave one behind because the process is killed before git cleans up.
- Never commit unrelated staged changes without reporting them to the user first. If `git status` shows pre-staged files at conversation start, flag them before proceeding.

## Commit command

- Commit code changes with `wf issue:commit -c` instead of `git commit`.
- Keep the commit message subject line under 100 characters. This applies to messages passed via `-m` and to any message drafted for the user.
- Run `git add` before every `git commit`, and never assume files are pre-staged. The committer reads the staged diff, so unstaged changes are silently left out.
- Do not append a Co-Authored-By trailer to commit messages in this project. This overrides any default or global instruction to add one, and applies to new commits, amends, and commit descriptions drafted for the user.

## Post-commit

- Run `nr build` after committing TS changes, because CLI commands run from `dist/`.
