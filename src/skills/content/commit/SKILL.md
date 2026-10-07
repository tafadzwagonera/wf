---
name: commit
description: Git commit lifecycle — pre-commit checks, staging discipline, and post-commit build. Use when committing code changes, running git add, or preparing a commit.
---

## Pre-commit checks

- Check for and remove stale `.git/index.lock` before `git add` or `git commit` (e.g. `rm -f .git/index.lock && git add ...`). Denied or interrupted git tool calls leave a stale lock because the process is killed before git cleans up.
- Never commit unrelated staged changes without reporting them to the user first. If `git status` shows pre-staged files at conversation start, flag them before proceeding.

## Commit command

- Always prefer `wf issue:commit -c` over `git commit` when committing code changes.
- Always `git add` before `git commit`. Never assume files are pre-staged.
- Do not append a Co-Authored-By trailer to commit messages in this project.

## Post-commit

- Always run `nr build` after committing TS changes (CLI commands run from `dist/`).
