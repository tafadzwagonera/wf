---
name: writing-plans
description: Guidance for writing ResolutionPlan JSON objects accepted by wf's quality validators.
---

**Category:** Methodology skill.

## ResolutionPlan Shape

The plan output is a single JSON object. Required fields are marked **required**; all others are optional.

```json
{
  "action": "fix",
  "summary": "one-sentence description of the plan",
  "steps": ["string — one literal change per step"],
  "stepIntents": ["string — goal checkable from the diff, or null"],
  "phases": [
    { "label": "string", "stepIndices": [0, 1], "verifyAfter": ["yarn test ..."] }
  ],
  "affectedFiles": [
    { "filePath": "repo/src/path/to/file.ts", "status": "found" }
  ],
  "affectedFilesContext": [
    { "filePath": "repo/src/path/to/context.ts", "status": "found" }
  ],
  "verification": {
    "targeted": [
      {
        "id": "unique-id",
        "run": "yarn test src/path/to/file.spec.ts",
        "policy": "enforced",
        "reason": "why this command verifies this plan"
      }
    ],
    "waivers": [
      { "id": "waiver-id", "reason": "why this verification is skipped" }
    ]
  }
}
```

Field notes:
- `action` — **required**. One of `"fix" | "feature" | "investigate"`.
- `summary` — **required**. One-sentence description of the plan.
- `steps` — **required**. One literal change per step.
- `stepIntents` — optional. Emit `stepIntents` only for steps that prescribe a literal (a call chain, signature, regex, or test name). State each intent as a goal checkable from the diff, keep it index-aligned with `steps` (same length), and use `null` for every other step. Omit `stepIntents` when no step prescribes a literal. Only the spec-fidelity check reads intents; the step assessor sees step text alone.
- `phases` — optional. Groups steps into named phases with optional post-phase verification commands.
- `affectedFiles` — optional. Files changed by the plan. Valid `status` values: `"found"` for existing files, `"to-delete"` for orphaned files the plan deletes, `"to-create"` for new files, `"not-found"` when a file was searched for but does not exist. All listed paths must be verified to exist before listing them with `"found"`.
- `affectedFilesContext` — optional. Files read for context but not modified.
- `verification.targeted` — optional. Commands wf runs to verify plan completion. Omit `verification` entirely when no targeted checks or waivers apply. Omit optional fields instead of setting them to `null`.
- `verification.waivers` — optional. Entries that suppress a specific verification command by id. Use when a command cannot run in this context; include a clear reason.

## Step Quality Rules

Three checks apply to plan steps. Only `no-placeholders` is supplied by `writing-plans.skill.ts`'s `getQualityRules()`. `rename-target-required` and `needle-search-required` are enforced unconditionally by `src/shared/utils/plan-quality.ts`, independent of this skill, and are not re-assessed by `plan-step-verification.service.ts`.

**(1) no-placeholders** — Step text must not match the `PLACEHOLDER_PATTERN` regex defined in `src/skills/writing-plans.skill.ts`. Write the actual before-and-after code change, not a description of intent. A step saying "add appropriate error handling" is rejected. A step saying "wrap the `readFile` call in a `try`/`catch` that returns `null` on `ENOENT`" is accepted.

**(2) rename-target-required** — A step that uses a rename or move verb must state both the source path or symbol name and its replacement path or symbol name explicitly. A step saying "rename the helper function" is rejected. A step saying "rename `tryReadPattern` to `readSkillContent` in `src/skills/skill-content.ts`" is accepted.

**(3) needle-search-required** — A step that deletes, drops, removes, replaces or renames a term needs a `verification.targeted` command that proves zero matches case-insensitively across the whole repository, for example `bash -c '! git grep -I -i -q -F NUXT_POWERREVIEWS'` (the `bash -c` wrapper keeps it inside the verification allowlist). A command without `-i`, or one that only uses `\b` word-boundary patterns, does not satisfy the rule. Intentional leftovers (an ADR, a changelog) are declared with a `verification.waivers` entry whose id is `needle-search-required`. The rule is advisory: it surfaces as a plan-quality risk, not a hard failure.

## Diff-Based Assessment

`plan-step-verification.service.ts` and `step-spec-fidelity.service.ts` assess whether each step was completed by reading the git diff. They never execute code or run tests. Step text must describe the literal change made such that the diff makes it unambiguous:

- Accepted: "Change the return type of `readSkillContent` from `string` to `string | null` in `src/skills/skill-content.ts`."
- Rejected: "Improve the error handling in the skill loader."

Write steps that an assessor could verify from a diff alone.

## Verification Commands

The correct form is:

```
yarn test src/path/to/file.spec.ts
```

No `--` separator, no `--testPathPatterns` flag, no `--runInBand` unless testing for open handles.
