#!/bin/sh

set -e

# install-hooks.sh: Install git hooks

REPO_ROOT=$(git rev-parse --show-toplevel)
HOOKS_DIR="$REPO_ROOT/.git/hooks"
SCRIPTS_DIR="$REPO_ROOT/scripts/hooks"

# Ensure hooks directory exists
mkdir -p "$HOOKS_DIR"

# Copy commit-msg hook
echo "Installing commit-msg hook..."
cp "$SCRIPTS_DIR/commit-msg" "$HOOKS_DIR/commit-msg"
chmod +x "$HOOKS_DIR/commit-msg"

# Copy pre-commit hook
echo "Installing pre-commit hook..."
cp "$SCRIPTS_DIR/pre-commit" "$HOOKS_DIR/pre-commit"
chmod +x "$HOOKS_DIR/pre-commit"

echo ""
echo "✓ Hooks installed successfully"

exit 0
