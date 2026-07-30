#!/bin/sh

STAGED_WF_FILES=$(git diff --cached --name-only | grep -E "^\.wf/" | head -20)

if [ -n "$STAGED_WF_FILES" ]; then
  echo ""
  echo "WARNING: You are about to commit files under .wf/ which should be gitignored."
  echo "  Staged .wf/ files:"
  echo "$STAGED_WF_FILES" | sed 's/^/    - /'
  echo ""
  echo "Consider running: git reset HEAD <file> to unstage them."
  echo ""
fi

exit 0
