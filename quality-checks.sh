#!/usr/bin/env bash
set -euo pipefail

command -v nr >/dev/null 2>&1 || exit 0

(git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null) \
  | grep -qE '\.(js|ts|jsx|tsx|vue)$' || exit 0

errors=""
for cmd in lint format typecheck test; do
  if [ -f package.json ] && jq -e ".scripts.\"$cmd\"" package.json >/dev/null 2>&1; then
    output=$(nr "$cmd" 2>&1) || errors="$errors
nr $cmd failed:
$output
"
  fi
done

if [ -n "$errors" ]; then
  jq -n --arg r "$errors" '{"decision":"block","reason":$r}'
fi
