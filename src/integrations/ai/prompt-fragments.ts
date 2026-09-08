import { JSON_OUTPUT_RULES } from './json-output-rules';
import { FigmaFrameContext } from '../figma/figma-rest.client';

/**
 * Condensed step-writing principles for the plan prompt.
 * Gen-5 models respond better to judgment-oriented principles than to
 * prescriptive principles, such as "When X, do Y" checklists.
 */
export const planStepPrinciples = `   Plan step principles — apply judgment, not rote checklists:
   - Be explicit about before and after: renames, moves, type changes, and helper placements
     should state both the current and target names/paths/types so the implementer does not guess.
   - When a step reuses an existing file, component, class, method, or utility function outside the
     context it was originally named for (e.g. a page-scoped component pulled onto an unrelated page,
     or a single-purpose helper generalized to a second call site), state whether its name still
     describes its general behavior. If not, the rename is part of this step, not a follow-up.
   - Trace impact across the codebase: when touching shared functions, nullable fields, CLI options,
     or documentation, follow every call site, consumer, and user-facing surface to decide whether
     it also needs updating. State findings explicitly.
   - Cross-check consistency: docstrings should match guard clauses, return types should reflect
     call-site options, and test assertions should exercise the strongest viable positive check
     (not just "no throw").
   - Surface hidden gaps: note dead code after removals, cover error-swallowing paths with tests,
     run or explicitly defer smoke tests, and verify both working-tree and staged state before handoff.
   - When "Known UI interaction patterns" or "Element class conventions" are listed under
     repository conventions, cite and match the referenced file or convention before proposing
     a new approach to the same interaction or choosing a Tailwind class (duplicate links,
     scroll-reset-on-navigation, aria-hidden/tabindex suppression, native control suppression,
     heading and grid-gap class choices).
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
 * Format the Figma discovery block for the plan prompt.
 *
 * @param figmaLinks - Figma frame links extracted from the ticket, if any
 * @param hasDesignSystem - Whether a frontend design system was detected in the target repo
 * @returns A formatted section instructing the model on Figma-derived values, or empty string
 *   when there is nothing actionable to say (no links, and no detected design system to warn about)
 */
const FIGMA_TOOL_FETCH_NOTICE = 'The wf tool will fetch these frames automatically from the Figma REST API '
  + 'and inject the design context before passing the plan to the implementer. Do not write any plan step '
  + 'that fetches Figma data — that is handled transparently by the tool. Instead, write steps that apply '
  + 'the design tokens and component conventions already detected in the repository '
  + '(linter rules, design system, class conventions) to implement the UI.';

export const formatFigmaPlanPromptSection = (
  figmaLinks: string[] | undefined, hasDesignSystem: boolean
): string => {
  if (figmaLinks?.length) {
    const linkLines = figmaLinks.map(link => '- ' + link).join('\n');
    return 'Figma reference(s) captured for this ticket:\n' + linkLines + '\n' + FIGMA_TOOL_FETCH_NOTICE;
  }
  if (!hasDesignSystem) return '';
  return 'No Figma reference was found for this ticket. Do not assert exact spacing, typography, or colour '
    + 'values as final in this plan — flag them under "risks" as unconfirmed pending a design reference.';
};

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

export const buildPlanSkillSection = (skillNames?: string[]): string => {
  if (!skillNames?.length) return '';
  return '\n\nSkill-specific instructions:\nBefore starting work, invoke each of the following skills using the Skill tool:\n'
    + skillNames.map(s => `- Skill('${s}')`).join('\n')
    + '\nFollow each skill\'s instructions fully before proceeding.';
};

export const buildFigmaContextSection = (frames: FigmaFrameContext[]): string => {
  if (!frames.length) return '';
  return frames
    .map(f => `Frame: ${f.url}\nName: ${f.name} (${f.width}×${f.height}px)\nScreenshot: ${f.screenshotUrl}`)
    .join('\n\n');
};

export const buildReviewSkillSection = (skillNames?: string[], figmaContextSection?: string): string => {
  if (!skillNames?.length && !figmaContextSection) return '';
  const lines: string[] = (skillNames ?? []).map(s => `- Skill('${s}')`);
  const skillBlock = lines.length
    ? '\nSkill-specific instructions:\nBefore starting review, invoke each of the following skills using the Skill tool:\n'
    + lines.join('\n')
    + '\nFollow each skill\'s instructions fully before proceeding.\n'
    : '';
  return figmaContextSection ? `${skillBlock}\n\n${figmaContextSection}` : skillBlock;
};

export const deriveModelSource = (provider: string, model: string): string => {
  const prefixMap: Record<string, string> = { anthropic: 'claude-', deepseek: 'deepseek-', google: 'gemini-', openai: 'gpt-' };
  const prefix = prefixMap[provider] ?? '';
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
};
