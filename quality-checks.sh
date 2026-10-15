#!/usr/bin/env bash
set -euo pipefail

if [ "${WF_MANAGED_SESSION:-}" = "1" ]; then exit 0; fi

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
changed=$(echo "$changed" | grep -vE '(^|/)wf\.config\.|(^|/)verification\.policy\.' || true)
echo "$changed" | grep -qE '\.(js|ts|jsx|tsx|vue)$' || exit 0

errors=""

# Lint only changed files (aligned with verification command)
changed_src=$(echo "$changed" | grep -E '\.(js|ts|jsx|tsx|vue)$' || true)
if [ -n "$changed_src" ]; then
  output=$(echo "$changed_src" | xargs npx --no-install eslint --max-warnings 0 2>&1) || errors="$errors
lint failed:
$output
"
fi

if [ -f package.json ] && jq -e '.scripts.typecheck' package.json >/dev/null 2>&1; then
  output=$($runner typecheck 2>&1) || errors="$errors
typecheck failed:
$output
"
fi

if [ -f package.json ] && jq -e '.scripts.test' package.json >/dev/null 2>&1 && [ -n "$changed_src" ]; then
  if [ -x node_modules/.bin/jest ]; then
    output=$(echo "$changed_src" | xargs npx --no-install jest --passWithNoTests --findRelatedTests 2>&1) || errors="$errors
test failed:
$output
"
  elif [ -x node_modules/.bin/vitest ]; then
    output=$(echo "$changed_src" | xargs npx --no-install vitest related --run --passWithNoTests 2>&1) || errors="$errors
test failed:
$output
"
  else
    output=$($runner test 2>&1) || errors="$errors
test failed:
$output
"
  fi
fi

if [ -n "$errors" ]; then
  jq -n --arg r "$errors" '{"decision":"block","reason":$r}'
fi
