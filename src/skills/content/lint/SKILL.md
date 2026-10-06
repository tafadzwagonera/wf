---
name: lint
description: ESLint fix policy — no suppression, fix the code. Use when editing files that trigger lint violations or when resolving ESLint errors.
---

## Rule

NEVER add eslint-disable comments (inline, block, or file-level) to files you create or modify. If a lint rule fails in a file you are editing — whether the violation is new or pre-existing — fix the underlying code so the rule passes. Suppressing lint errors masks real problems.
