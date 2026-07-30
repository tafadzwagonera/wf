#!/bin/sh

# Validates that the commit message follows the conventional commits format.

COMMIT_MSG_FILE="$1"
COMMIT_MSG=$(cat "$COMMIT_MSG_FILE")

# Format: type(scope): description — scope optional, description max 72 chars
PATTERN='^(feat|fix|chore|docs|refactor|test|ci|style|perf|revert)(\([^)]+\))?: .{1,72}$'

FIRST_LINE=$(echo "$COMMIT_MSG" | head -n 1)

if ! echo "$FIRST_LINE" | grep -E "$PATTERN" > /dev/null 2>&1; then
  echo ""
  echo "ERROR: Commit message does not follow conventional commits format."
  echo ""
  echo "Required format: <type>(<scope>): <description>"
  echo "  - type: feat, fix, chore, docs, refactor, test, ci, style, perf, revert"
  echo "  - scope: optional, in parentheses"
  echo "  - description: max 72 characters"
  echo ""
  echo "Examples:"
  echo "  feat(auth): add OAuth2 support"
  echo "  fix(cli): correct null check in issue-plan command"
  echo "  chore: update dependencies"
  echo ""
  echo "Your message: \"$FIRST_LINE\""
  echo ""
  exit 1
fi

exit 0
