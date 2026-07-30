#!/usr/bin/env bash
set -euo pipefail

# Detect package manager from lockfile
if [ -f bun.lockb ] || [ -f bun.lock ]; then
  runner="bun run"
elif [ -f pnpm-lock.yaml ]; then
  runner="pnpm run"
elif [ -f yarn.lock ]; then
  runner="yarn"
elif [ -f package-lock.json ]; then
  runner="npm run"
else
  exit 0
fi

changed=$(git diff --diff-filter=ACMRT --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null)
echo "$changed" | grep -qE '\.(js|ts|jsx|tsx|vue)$' || exit 0

errors=""

# Lint only changed files (aligned with verification command)
changed_lint=$(echo "$changed" | grep -E '\.(js|ts|jsx|tsx|vue)$' || true)
if [ -n "$changed_lint" ]; then
  output=$(echo "$changed_lint" | xargs "$runner" eslint --max-warnings 0 2>&1) || errors="$errors
lint failed:
$output
"
fi

for cmd in typecheck test; do
  if [ -f package.json ] && jq -e ".scripts.\"$cmd\"" package.json >/dev/null 2>&1; then
    output=$($runner "$cmd" 2>&1) || errors="$errors
$cmd failed:
$output
"
  fi
done

if [ -n "$errors" ]; then
  jq -n --arg r "$errors" '{"decision":"block","reason":$r}'
fi
