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
 * Judgment-oriented verification principles.
 * Gen-5 models produce better verification steps when guided by intent
 * rather than exhaustive constraint lists.
 */
export const buildPlanVerificationBlock = (hasNodeInfra: boolean): string => {
  const shellSafety = hasNodeInfra
    ? `\n   - Keep inline \`node -e\` commands shell-safe (single-quoted JS or escaped backticks).`
    : '';
  return `9. Verification principles — include only when the plan introduces testable behavior:
   - Write commands that verify the specific behavior this plan introduces, not the entire test suite.
     A good verification command is copy-paste-runnable from the repo root, exits 0 on success,
     and references real scripts from "Available test infrastructure."
   - Use "verification.targeted" for focused checks, "verification.waivers" to explicitly waive
     a baseline check, or omit "verification" entirely when neither applies.
   - Cross-check CLI flags against the installed framework version — stale flags cause false passes.${shellSafety}`;
};

export const buildPlanTestConventionsBlock = (hasTestInfra: boolean): string => {
  if (!hasTestInfra) return '';
  return `Test convention principle: match the repo's detected patterns for mock cleanup, DI wiring, and isolation. Keep mock setup concrete — conditional or partial mocks hide failures.`;
};

// ─── Review prompt fragments ─────────────────────────────────────────────────

/**
 * Judgment-oriented review instructions.
 * Gen-5 models produce better reviews when guided by principles
 * rather than exhaustive output checklists.
 */
export const reviewInstructions = `   Review principles — apply judgment to each area:
1. Summarize the intent and scope of the changes
2. Surface issues by severity (error, warning, info) — flag what matters, skip noise
3. Assess trace confidence honestly: evidence-based when you can follow the path,
   best-effort when partially visible, unavailable when opaque
4. Walk the changed code path as a concrete call stack using real identifiers from the diff
5. Capture variable state transitions between frames to show what moved
6. For each issue, suggest the smallest effective fix in plain language
7. Offer follow-up suggestions only when they add value beyond the immediate issues
8. Approve when the changes are sound — reject only with clear justification`;

/**
 * Judgment-oriented trace guidance, matching the planStepPrinciples style.
 */
export const reviewTraceGuidance = `   Trace principles — use judgment, not mechanical rules:
   - Ground traces in concrete identifiers (Class.method(...), functionName(...));
     reflect the actual call path, not the review process.
   - Structure callStack nodes by real invocation depth; external effects (HTTP, DB)
     belong as leaf nodes.
   - Distinguish observed state (captured) from mutations (changes) so readers can
     follow what was inspected versus what moved.
   - Prefer honest provenance: label "unavailable" with empty structures rather than
     fabricating a path you cannot trace confidently.`;

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

export const deriveModelSource = (provider: string, model: string): string => {
  const prefixMap: Record<string, string> = { anthropic: 'claude-', deepseek: 'deepseek-', google: 'gemini-', openai: 'gpt-' };
  const prefix = prefixMap[provider] ?? '';
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
};
