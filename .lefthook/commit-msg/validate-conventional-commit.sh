#!/bin/sh

# Validates that the commit message follows the conventional commits format.

COMMIT_MSG_FILE="$1"
COMMIT_MSG=$(cat "$COMMIT_MSG_FILE")

# Format: type(scope): Description — scope optional, description max 100 chars, first letter uppercase
PATTERN='^(feat|fix|chore|docs|refactor|test|ci|style|perf|revert)(\([^)]+\))?: [A-Z].{1,99}$'

FIRST_LINE=$(echo "$COMMIT_MSG" | head -n 1)

if ! echo "$FIRST_LINE" | grep -E "$PATTERN" > /dev/null 2>&1; then
  echo ""
  echo "ERROR: Commit message does not follow conventional commits format."
  echo ""
  echo "Required format: <type>(<scope>): <Description>"
  echo "  - type: feat, fix, chore, docs, refactor, test, ci, style, perf, revert"
  echo "  - scope: optional, in parentheses"
  echo "  - description: starts with an uppercase letter, max 100 characters"
  echo ""
  echo "Examples:"
  echo "  feat(auth): Add OAuth2 support"
  echo "  fix(cli): Correct null check in issue-plan command"
  echo "  chore: Update dependencies"
  echo ""
  echo "Your message: \"$FIRST_LINE\""
  echo ""
  exit 1
fi

exit 0
