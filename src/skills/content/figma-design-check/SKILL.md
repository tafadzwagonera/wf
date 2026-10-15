---
name: figma-design-check
description: >-
  Audit implemented UI against Figma frames. Use after implementation to verify
  visual conformance — spacing, typography, colour, component states, and dark
  mode — before marking a feature done.
argument-hint: '<figma frame link(s)> <base branch>'
allowed-tools:
  - Bash(git status:*)
  - Bash(git diff:*)
  - Bash(git log:*)
  - Bash(grep:*)
  - Bash(find:*)
  - mcp__figma__get_design_context
  - mcp__figma__get_variable_defs
  - mcp__figma__get_metadata
  - mcp__figma__get_screenshot
  - mcp__figma__list_file_components_for_code_connect
  - Read
---

# Figma Design Check

Audit: $ARGUMENTS

## Live state

Read current git state before opening any Figma frame.

```
!git status --short
!git branch --show-current
```

Everything that follows is a claim about the diff, so ground it in the actual
git state and diff rather than in memory of what was built.

## Discipline: read the code before the frames

Read every changed file in the diff before calling any Figma tool. The diff is
the source of truth for what was actually implemented. The frames are the
authority on what was intended. Comparing them without reading both is guessing.

1. `git diff <base-branch>...HEAD` to get the full diff.
2. Read each changed component/page file to understand the actual implementation.
3. Note the design system config file path (Tailwind config or global CSS) — you
   will need token names from it.
4. Only then open the frames.

## Step 1 — Harvest all design values from the frames

Call `mcp__figma__get_variable_defs` on each frame node first — it returns token
names and resolved literals compactly. Then call `mcp__figma__get_design_context`
for layout and structure.

Write down every value as a harvest table before comparing anything. Comparing
while harvesting mixes two cognitive modes and produces missed items.

| Element | Property | Figma value | Token name |
| ------- | -------- | ----------- | ---------- |
|         | bg       |             |            |
|         | text     |             |            |
|         | padding  |             |            |
|         | radius   |             |            |
|         | gap      |             |            |

Always build the harvest table before comparing. Separating harvesting from
comparing is what turns "looks about right" into "matches exactly".

## Step 2 — Mechanical checks before opening the full diff

Run these checks first — they are fast, unambiguous, and cover the most common
deviations.

```bash
# Check for literal hex values that should be tokens
grep -rn '#[0-9a-fA-F]\{6\}' src/ --include='*.css' --include='*.vue' --include='*.tsx' --include='*.svelte'

# Check for inline px values that bypass the spacing scale
grep -rn 'style="[^"]*px' src/ --include='*.vue' --include='*.tsx' --include='*.svelte'

# Check for hardcoded font-size / line-height
grep -rn 'font-size:\|line-height:' src/ --include='*.css'
```

Each hit is a candidate deviation — mark it in the table, not as a confirmed
finding. Some literals are intentional (one-off illustrations, generated
content). Confirm in the diff before calling it a finding.

## Step 3 — Compare harvest table to implementation

For each row in the harvest table, locate the implementation value in the diff
and compare. Use the token name from the design system config to resolve the
design value, then compare with what is in the code.

**Three authorities — when values conflict:**

1. **The frame** — the designed intent.
2. **The code** — what was actually implemented.
3. **The design system** — the tiebreaker when frame and code conflict but both
   are plausible.

If the design system registers a token as `bg-primary` for the frame's colour,
the implementation must use `bg-primary` regardless of whether the hex matches.
Token binding is the finding, not the hex disagreement.

## Step 4 — Sort deviations into four buckets

| Bucket | Label | When to use |
| ------ | ----- | ----------- |
| A | Fix | Implementation is wrong; the frame is the authority. |
| B | Correct + reason | Implementation differs intentionally; document why. |
| C | Question for design | Frame is ambiguous or conflicts with the design system. |
| D | Design system overrules | The design system overrides the frame; the frame may be stale. |

A deviation without a bucket is not a finding. It is ambiguity.

## Step 5 — Report

Emit one row per deviation. Use the emoji column to make bucket D visible
without reading the prose.

| Element | Property | Frame | Code | Bucket | Action |
| ------- | -------- | ----- | ---- | ------ | ------ |
|         |          |       |      | ✅ A   |        |
|         |          |       |      | ⚠️ B   |        |
|         |          |       |      | ❓ C   |        |
|         |          |       |      | 🔒 D   |        |

After the table, one verdict line:

> **Verdict:** [N] fix items (bucket A) · [N] intentional deviations (B) · [N]
> questions for design (C) · [N] design-system overrides (D). Offer to implement
> fixes, document bucket B reasoning, or draft questions to design — whichever
> is most useful next.

## Scope boundaries

This skill reads. It does not write production code. If bucket-A items are
worth fixing now, offer to run `figma-implement` on the affected elements. Do
not begin writing without that explicit handoff.

Dark mode is in scope only when a `darkModeConvention` is detected in the repo
conventions and the frame includes a dark-mode variant.

## Common failure modes

- **Treating bucket D as a fix** — design-system overrides are wins, not
  defects. Mark them 🔒 and move on.
- **Confirming a grep hit without reading the diff** — grep finds candidates.
  The diff confirms findings.
- **Calling a deviation ambiguous without checking the design system** — the
  design system is the tiebreaker. Check it before escalating to design.
