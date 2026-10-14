import * as path from 'node:path';
import { JSON_OUTPUT_RULES } from './json-output-rules';
import { FigmaFrameContext, FigmaNodeLayout } from '../figma/figma-rest.client';

export const implementerSearchRule = 'For a rename or terminology migration, search with a broad case-insensitive '
  + 'substring search (e.g. /oldterm/i), not a word-boundary-only pattern (e.g. /\\boldterm\\b/) — the latter misses '
  + 'kebab-case identifiers (old-term-thing), capitalized prose (OldTerm), and other non-word-boundary forms that are '
  + 'still real occurrences of the term being migrated. Run this search across the whole repository, including '
  + 'docs/specs directories, not only the source directories the plan happened to list.';

export const implementerDeleteOrphanRule = (searchTool: string): string =>
  `For any file you edit or delete content from as part of a rename, removal, or refactor, use ${searchTool} to check `
  + 'whether it still has any remaining importers/callers once your edits land. If it has zero remaining references '
  + 'anywhere in the repo, delete it rather than leaving an orphaned module behind — do not just note it as dead '
  + 'code for a future ticket.';

export const needleSearchReminder = 'Search for the needle case-insensitively across the whole repository, '
  + 'including non-code files such as docs, specs, config, env files and CI.';

export const gitignoreSearchNote = 'Claude\'s Grep honours .gitignore, so ignored files need '
  + '`git grep --no-index` through Bash.';

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
     or a single-purpose helper generalized to a second call site), or touches one only in passing
     (an importer, a mock, a doc reference, a sibling of code being removed), state whether its name
     still describes its actual behavior. If not, the rename is part of this step, not a follow-up.
   - Trace impact across the codebase: when touching shared functions, nullable fields, CLI options,
     or documentation, follow every call site, consumer, and user-facing surface to decide whether
     it also needs updating. State findings explicitly.
   - Cross-check consistency: docstrings should match guard clauses, return types should reflect
     call-site options, and test assertions should exercise the strongest viable positive check
     (not just "no throw").
   - Surface hidden gaps: note dead code after removals, cover error-swallowing paths with tests,
     register smoke tests under \`verification.targeted\` or explicitly defer them.
   - Do not write plan steps that run verification commands, check \`git status\` or \`git diff --cached\`,
     stage, commit, or dictate commit/PR message wording or trailers. Declare commands in
     \`verification.targeted\` so the tool runs and records them; commit handling is managed by the tool.
   - When "Known UI interaction patterns" or "Element class conventions" are listed under
     repository conventions, cite and match the referenced file or convention before proposing
     a new approach to the same interaction or choosing a Tailwind class (duplicate links,
     scroll-reset-on-navigation, aria-hidden/tabindex suppression, native control suppression,
     heading and grid-gap class choices).
   - Prefer re-running generators over manually patching generated output.
   - When a step adds or renames a config field, schema property, or option, trace it to its
     consumer and list every copy point (raw schema, normalizer, derived types, docs) in the same
     step — a value that validates but is never read is a defect, not future-proofing.
   - For plans affecting more than 10 files, group steps into phases with intermediate verification
     checkpoints using the \`phases\` array.
   - ${implementerSearchRule} ${gitignoreSearchNote}
   - For any new guardrail, fallback or downgrade, state what happens on empty or failed input, whether the
     logic already exists elsewhere (reuse it), and whether a failure is visible beyond a log line.`;

export const planFileListingInstructions = `3. Files that will be **modified** — use objects with "filePath" and "status". Prefix EVERY
   path with its repository name. Use REAL file paths from the repository — not globs, not
   placeholders. Set status to "found" for existing files, "to-delete" for orphaned files the plan deletes, or "to-create" for new files.
   Verify each path exists with tools before listing it — hallucinated paths cause the implementer to stall.
4. Files needed for **context only** (read, not edit) — same object shape as affectedFiles.
   All context files must have status "found". Verify each path exists before listing it.
5. Potential risks or considerations — objects with "description" and "severity" (low/medium/high). Judge severity by blast radius: shared modules, nullable fields, config surfaces, and migration danger. The tool computes the final plan complexity from the highest risk severity plus plan size, so do not estimate complexity yourself.
6. Repositories that will be affected (if known)
7. New repositories that must be created (not yet existing locally) — a subset of affectedRepositories. Omit or leave empty when the plan only touches existing repos`;

export const planChangePrinciple = `Change principle: propose the most effective and sustainable change scoped to the ticket, including renames and cleanups that the change itself makes necessary. Limit verification to files edited by this plan. Prefer changes that are replaceable or deletable without cascading effects.`;

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
  return `8. Verification principles — include only when the plan introduces testable behavior:
   - Write commands that verify the specific behavior this plan introduces, not the entire test suite.
     A good verification command is copy-paste-runnable from the repo root, exits 0 on success,
     and references real scripts from "Available test infrastructure."
   - Use "verification.targeted" for focused checks, "verification.waivers" to explicitly waive
     a baseline check, or omit "verification" entirely when neither applies.
   - Prefer verification that enters the system where users do — a real config file, a CLI
     invocation, an on-disk artifact — over direct calls to the internals behind them.
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
6. For each issue, suggest the most effective and sustainable fix in concise and straightforward language
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

export const buildReviewPrompt = ({ diff, guidelines, figmaContextSection }: {
  diff: string;
  guidelines: string[];
  figmaContextSection?: string;
}): string => {
  const numberedGuidelines = guidelines.map((g, i) => (i + 1) + '. ' + g).join('\n');
  return [
    `\nCode Changes:\n\`\`\`\n${diff}\n\`\`\``,
    `\nReview Guidelines:\n${numberedGuidelines}`,
    `\n${reviewInstructions}`,
    ...(figmaContextSection ? [figmaContextSection] : []),
    reviewTraceGuidance,
    `\n${reviewOutputSchema}`,
  ].join('\n');
};

function formatNodeHeader(node: FigmaNodeLayout, indent: string): string {
  const dims = node.width !== undefined && node.height !== undefined
    ? ` (${node.width}×${node.height}px)`
    : '';
  const attrs: string[] = [];
  if (node.layoutMode) attrs.push(node.layoutMode.toLowerCase());
  if (node.primaryAxisAlign) attrs.push(node.primaryAxisAlign.toLowerCase().replace('_', '-'));
  const attrsSuffix = attrs.length ? ' [' + attrs.join(' | ') + ']' : '';
  return `${indent}${node.name}${dims}${attrsSuffix}`;
}

function formatNodeProps(node: FigmaNodeLayout): string[] {
  const props: string[] = [];
  const { paddingTop: pt, paddingRight: pr, paddingBottom: pb, paddingLeft: pl } = node;
  if (pt !== undefined && pr !== undefined && pb !== undefined && pl !== undefined) {
    props.push(pt === pr && pr === pb && pb === pl ? `pad:${pt}px` : `pad:${pt}px ${pr}px ${pb}px ${pl}px`);
  }
  if (node.gap !== undefined) props.push(`gap:${node.gap}px`);
  if (node.cornerRadius !== undefined) props.push(`radius:${node.cornerRadius}px`);
  if (node.fills?.length) props.push(`fill:${node.fills.map(f => f.hex ?? f.type).join(',')}`);
  return props;
}

function formatNodeTypography(node: FigmaNodeLayout, indent: string): string {
  if (!node.typography) return '';
  const t = node.typography;
  const parts = [
    t.fontSize ? `${t.fontSize}px` : '', t.fontWeight ? `w${t.fontWeight}` : '',
    t.lineHeightPx ? `lh:${Math.round(t.lineHeightPx)}px` : '',
    t.textDecoration ? t.textDecoration.toLowerCase() : '',
  ].filter(Boolean).join(' ');
  return parts ? `${indent}  [font:${parts}]` : '';
}

function formatNodeLayout(node: FigmaNodeLayout, indent = ''): string {
  const lines: string[] = [formatNodeHeader(node, indent)];
  const props = formatNodeProps(node);
  if (props.length) lines.push(`${indent}  [${props.join(' | ')}]`);
  const typo = formatNodeTypography(node, indent);
  if (typo) lines.push(typo);
  if (node.text) {
    const preview = node.text.length > 60 ? node.text.slice(0, 60) + '…' : node.text;
    lines.push(`${indent}  [text:"${preview}"]`);
  }
  if (node.children?.length) {
    for (const child of node.children) lines.push(formatNodeLayout(child, `${indent}  `));
  }
  return lines.join('\n');
}

export const buildFigmaContextSection = (frames: FigmaFrameContext[]): string => {
  if (!frames.length) return '';
  return frames.map(f => {
    const header = `Frame: ${f.url}\nName: ${f.name} (${f.width}×${f.height}px)\nScreenshot: ${f.screenshotUrl}`;
    return `${header}\n\nLayout:\n${formatNodeLayout(f.layout)}`;
  }).join('\n\n---\n\n');
};

export const deriveModelSource = (provider: string, model: string): string => {
  const prefixMap: Record<string, string> = { anthropic: 'claude-', deepseek: 'deepseek-', google: 'gemini-', openai: 'gpt-' };
  const prefix = prefixMap[provider] ?? '';
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
};

export function formatUiDesignScreenshotsPlanPromptSection(paths: string[]): string {
  if (!paths.length) return '';
  const basenames = paths.map(p => `- ${path.basename(p)}`).join('\n');
  return `UI design screenshots provided:\n${basenames}\nThese screenshots are injected as images into this prompt call. Do not guess spacing, colour, or typography values — derive all values from the design reference.`;
}

export function buildUiDesignComplianceSystemPromptSection(
  context: { figmaLinks?: string[]; uiDesignScreenshots?: string[] }
): string {
  if (!context.figmaLinks?.length && !context.uiDesignScreenshots?.length) return '';
  return '**UI design compliance (survives compaction)**\nDesign reference is active for this task. Implement the UI to strictly match the design provided — Figma frames or screenshots as listed. Every spacing value, colour token, typography rule, and layout property must come from the design reference or from existing design system conventions already in the repository. Never invent new CSS classes, Tailwind utilities, or style values not grounded in the design reference or the codebase design system.';
}
