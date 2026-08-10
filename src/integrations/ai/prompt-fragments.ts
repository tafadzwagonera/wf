import { JSON_OUTPUT_RULES } from './json-output-rules';

// ─── Plan prompt fragments ───────────────────────────────────────────────────

/**
 * Condensed step-writing principles for the plan prompt.
 * Gen-5 models respond better to judgment-oriented principles than to
 * exhaustive "When X, do Y" checklists.
 */
export const planStepPrinciples = `   Plan step principles — apply judgment, not rote checklists:
   - Be explicit about before and after: renames, moves, type changes, and helper placements
     should state both the current and target names/paths/types so the implementer does not guess.
   - Trace impact across the codebase: when touching shared functions, nullable fields, CLI options,
     or documentation, follow every call site, consumer, and user-facing surface to decide whether
     it also needs updating. State findings explicitly.
   - Cross-check consistency: docstrings should match guard clauses, return types should reflect
     call-site options, and test assertions should exercise the strongest viable positive check
     (not just "no throw").
   - Surface hidden gaps: note dead code after removals, cover error-swallowing paths with tests,
     run or explicitly defer smoke tests, and verify both working-tree and staged state before handoff.
   - Prefer re-running generators over manually patching generated output.
   - For plans affecting more than 10 files, group steps into phases with intermediate verification
     checkpoints using the \`phases\` array.`;

export const planFileListingInstructions = `3. Estimated complexity (low/medium/high)
4. Files that will be **modified** — use objects with "filePath" and "status". Prefix EVERY
   path with its repository name. Use REAL file paths from the repository — not globs, not
   placeholders. Set status to "found" for existing files or "to-create" for new files.
   Verify each path exists with tools before listing it — hallucinated paths cause the implementer to stall.
5. Files needed for **context only** (read, not edit) — same object shape as affectedFiles.
   All context files must have status "found". Verify each path exists before listing it.
6. Potential risks or considerations
7. Repositories that will be affected (if known)
8. New repositories that must be created (not yet existing locally) — a subset of affectedRepositories. Omit or leave empty when the plan only touches existing repos`;

export const planMinimalChangePrinciple = `Minimal-change principle: propose the smallest effective change scoped to the ticket. Limit verification to files edited by this plan. Prefer changes that are replaceable or deletable without cascading effects.`;

/**
 * Build verification instructions, optionally including the Node shell-safety addendum.
 */
export const buildPlanVerificationBlock = (hasNodeInfra: boolean): string => {
  const shellSafety = hasNodeInfra
    ? `\n   - Verification commands must be shell-safe. For inline \`node -e\`, prefer single-quoted JS strings or properly escaped backticks.`
    : '';
  return `9. Task-specific verification only when needed:
   - Use "verification.targeted" for focused checks required by this plan
   - Use "verification.waivers" only to explicitly waive a repo-level baseline check
   - Omit "verification" entirely when no targeted checks or waivers are needed
   - Commands run from the repository root and must exit 0 on success
   - Commands must be copy-paste-runnable: reference only scripts from "Available test infrastructure"
   - Each command must target the specific behavior this plan introduces — not the whole test suite or unrelated output
   - Cross-check CLI flag names against the installed framework version${shellSafety}`;
};

export const buildPlanTestConventionsBlock = (hasTestInfra: boolean): string => {
  if (!hasTestInfra) return '';
  return `When prescribing test changes, follow all test conventions detected above — mock cleanup, DI wiring, and the repo's existing isolation strategy. Mock setup must be concrete and complete, not conditional.`;
};

// ─── Review prompt fragments ─────────────────────────────────────────────────

export const reviewInstructions = `Provide a code review with:
1. A brief summary of the changes
2. Any issues found (errors, warnings, or info)
3. A trace provenance label: evidence-based, best-effort, or unavailable
4. A nested tree-like call stack walking the changed code path from concrete functions in the diff
5. A frame-aligned state transition tree capturing variable changes between frames
6. A suggestion for each issue — recommend the smallest effective fix in plain, human-friendly language
7. Optional trailing suggestions for general follow-up not tied to a single issue
8. Whether the code is approved`;

export const reviewTraceGuidance = `Trace guidance:
- Describe the changed code path using concrete identifiers (Class.method(...), functionName(...)), not review-process steps like "analyzing" or "issues found".
- Nest callStack nodes by invocation; attach external effects (HTTP calls, DB queries) as leaf nodes.
- For state transitions, use \`captured\` for observed variables and \`changes\` for values that changed between frames.
- Set traceProvenance to "unavailable" with empty callStack/stateTransition when the path cannot be traced confidently.`;

export const reviewOutputSchema = `Return ONLY a valid JSON object. Reference:
{"summary":"Rename display label from X to Y across all user-facing text.","issues":[{"severity":"warning","message":"Missing JSDoc block on new private method.","file":"src/service.ts","line":42,"suggestion":"Add a minimal JSDoc block."},{"severity":"info","message":"Unused import spans multiple lines.","file":"src/utils.ts","line":10,"endLine":14},{"severity":"info","message":"Log message change loses diagnostic value."}],"traceProvenance":"evidence-based","callStack":[{"frame":"Service.method(params)","children":[{"frame":"Helper.transform(input)","children":[]}]}],"stateTransition":{"from":"entry-frame","to":"exit-frame","steps":[{"frame":"Service.method(params)","captured":{"dep":"Dep { ... }"},"changes":{"dep":{"before":"old","after":"new"}},"children":[]}]},"suggestions":["Extract predicate into a named helper for readability."],"approved":true}

Prefer an absolute line number. Degrade to a line range (line + endLine) when the issue spans multiple lines. Omit line and endLine entirely when the issue cannot be pinned to specific lines.
When an optional field has no value, omit it from the JSON entirely. Do not use null.

${JSON_OUTPUT_RULES}`;

// ─── Shared builders ─────────────────────────────────────────────────────────

export const buildPlanSkillSection = (skillNames?: string[]): string => {
  if (!skillNames?.length) return '';
  return '\n\nSkill-specific instructions:\nBefore starting work, invoke each of the following skills using the Skill tool:\n'
    + skillNames.map(s => `- Skill('${s}')`).join('\n')
    + '\nFollow each skill\'s instructions fully before proceeding.';
};

export const buildReviewSkillSection = (skillNames?: string[]): string => {
  if (!skillNames?.length) return '';
  return '\nSkill-specific instructions:\nBefore starting review, invoke each of the following skills using the Skill tool:\n'
    + skillNames.map(s => `- Skill('${s}')`).join('\n')
    + '\nFollow each skill\'s instructions fully before proceeding.\n';
};

export const buildSonarSection = (sonarOutput?: string): string => {
  if (!sonarOutput) return '';
  return '\nStatic Analysis (SonarScanner) Output:\n```\n' + sonarOutput + '\n```\n'
    + 'Consider the above static analysis findings as additional context when reviewing. '
    + 'They do not independently determine approval.\n';
};

export const deriveModelSource = (provider: string, model: string): string => {
  const prefixMap: Record<string, string> = { anthropic: 'claude-', deepseek: 'deepseek-', google: 'gemini-', openai: 'gpt-' };
  const prefix = prefixMap[provider] ?? '';
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
};
