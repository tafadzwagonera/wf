import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import dayjs from 'dayjs';
import { AIError, isAIErrorLike } from '../../shared/utils/errors';
import { LoggerService } from '../../shared/logger/logger.service';
import { LLM_ADAPTER } from './llm-adapter.interface';
import type { LlmAdapter } from './llm-adapter.interface';
import { formatTestInfraPromptSection, type TestInfraContext } from '../../shared/utils/detect-test-infra';
import { postProcessCodeReview } from '../../review/code-review-post-processing';
import { resolveSkills } from '../../skills';
import {
  formatRepoConventionsPromptSection,
  type RepoConventionsContext,
} from '../../shared/utils/detect-repo-conventions';
import {
  formatPriorPlansPromptSection,
  formatPlanCorrelationPromptSection,
  type PriorPlanContext,
  type PlanCorrelationResult,
} from '../../shared/utils/detect-prior-plans';
import {
  formatCrossRepoPatternsPromptSection,
  type CrossRepoContext,
} from '../../shared/utils/detect-cross-repo-patterns';
import type {
  AIRequest,
  AIResponse,
  AIConversationRequest,
  FindingsDocument,
  FileEntry,
  ResolutionPlan,
} from '../../shared/types/ai.types';
import type { CodeReview } from '../../shared/types/review.types';
import { codeReviewSchema } from '../../shared/schemas/review.schema';
import type { ResolutionAction, StageProgressCallback } from '../../shared/types/agent.types';

export type {
  AIRequest,
  AIResponse,
  AIConversationRequest,
  FindingsDocument,
  FileStatus,
  FileEntry,
  ResolutionPlan,
} from '../../shared/types/ai.types';
export type { CodeIssue, CodeReview } from '../../shared/types/review.types';
export { REVIEW_VERDICT_APPROVED, REVIEW_VERDICT_CHANGES_REQUESTED } from '../../shared/types/review.types';

const DEFAULT_PLAN_MAX_TOKENS = 16384 as const;
const DEFAULT_FINDINGS_MAX_TOKENS = 16384 as const;
const DEFAULT_REVIEW_MAX_TOKENS = 16384 as const;

/**
 * Strips a single wrapping Markdown code fence from LLM output.
 * Handles ```typescript, ```ts, ```js, ```json, and plain ``` fences.
 * When the model adds preamble or trailing text around the fence, the first
 * embedded fence block is extracted instead.
 * @param content Raw LLM response string
 * @returns File content without the outermost code fence, or the original string if none is present
 */
export const stripCodeFences = (content: string): string => {
  const exactMatch = /^```\w*\n?([\s\S]*?)```\s*$/.exec(content);
  if (exactMatch) return exactMatch[1];

  const embeddedMatch = /```\w*\n([\s\S]*?)```/.exec(content);
  if (embeddedMatch) return embeddedMatch[1];

  return content;
};

/**
 * Advance the JSON brace-depth scanner state by one character.
 * @param char Current character
 * @param isEscaped Whether the previous character was a backslash escape
 * @param inString Whether the scanner is currently inside a JSON string
 * @returns Updated [inString, isEscaped] tuple
 */
const advanceJsonStringState = (char: string, isEscaped: boolean, inString: boolean): [boolean, boolean] => {
  if (!inString) return char === '"' ? [true, false] : [false, false];
  if (isEscaped) return [true, false];
  if (char === '\\') return [true, true];
  if (char === '"') return [false, false];
  return [true, false];
};

/**
 * Process one character for the brace-depth scanner when outside a string.
 * @param char Current character
 * @param braceDepth Current brace depth
 * @returns Updated braceDepth, or null to signal a complete balanced-object match
 */
const processJsonBraceChar = (char: string, braceDepth: number): number | null => {
  if (char === '{') return braceDepth + 1;
  if (char !== '}') return braceDepth;
  if (braceDepth - 1 === 0) return null;
  return braceDepth - 1;
};

/**
 * Scan forward through content to find the index of the first opening brace.
 * @param content String to scan
 * @returns Index of first '{', or -1 when not found
 */
const findFirstBrace = (content: string): number => {
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === '{') return i;
  }
  return -1;
};

/**
 * Extract the first balanced JSON object from arbitrary text.
 * Ignores braces inside JSON strings so wrapper text can be skipped safely.
 * @param content Raw content that may contain a JSON object
 * @returns First balanced JSON object substring, or null when none is found
 */
const extractFirstJsonObject = (content: string): string | null => {
  const startIndex = findFirstBrace(content);
  if (startIndex === -1) return null;

  let braceDepth = 1;
  let inString = false;
  let isEscaped = false;

  for (let i = startIndex + 1; i < content.length; i += 1) {
    [inString, isEscaped] = advanceJsonStringState(content[i], isEscaped, inString);
    if (inString) continue;
    const next = processJsonBraceChar(content[i], braceDepth);
    if (next === null) return content.slice(startIndex, i + 1);
    braceDepth = next;
  }

  return null;
};

/**
 * Extract the outermost JSON object by slicing from the first '{' to the last '}'.
 * Greedy — captures the longest possible substring. This handles responses where
 * the conservative brace-depth scanner returns a truncated result because prose
 * preamble contains its own balanced brace pair (e.g. "{fix}"), causing
 * findFirstBrace to anchor on the wrong opening brace.
 * @param content Raw content that may contain a JSON object
 * @returns Outermost brace-delimited substring, or null when no valid boundary pair exists
 */
const extractOutermostJsonObject = (content: string): string | null => {
  const first = content.indexOf('{');
  const last = content.lastIndexOf('}');
  return first !== -1 && last > first ? content.slice(first, last + 1) : null;
};

/** Tri-state result from {@link detectBraceFailurePos}. */
const BRACE_POS_VALID = -1;
const BRACE_POS_UNREPAIRABLE = -2;

/**
 * Detect the character position of a JSON syntax failure caused by an excess closing brace.
 * @param content Raw JSON string to probe
 * @returns Positive failure position when repairable, {@link BRACE_POS_VALID} when content
 *          parses successfully, or {@link BRACE_POS_UNREPAIRABLE} when the error is not a
 *          brace-repair candidate.
 */
const detectBraceFailurePos = (content: string): number => {
  try {
    JSON.parse(content);
    return BRACE_POS_VALID;
  } catch (error) {
    if (!(error instanceof SyntaxError)) return BRACE_POS_UNREPAIRABLE;
    const match = /position (\d+)/.exec(error.message);
    if (!match) return BRACE_POS_UNREPAIRABLE;
    const pos = Number(match[1]);
    return pos >= 2 && content[pos - 1] === '}' ? pos : BRACE_POS_UNREPAIRABLE;
  }
};

/**
 * Build removal candidates around a failure position and return the first that parses.
 * @param content Raw JSON string
 * @param failPos Character position reported by JSON.parse
 * @returns Repaired string, or null when no candidate parses
 */
const tryBraceRemovals = (content: string, failPos: number): string | null => {
  const candidates = [
    content.slice(0, failPos - 1) + content.slice(failPos),
    content[failPos - 2] === ']' ? content.slice(0, failPos - 2) + content.slice(failPos) : null,
    content[failPos] === ']' ? content.slice(0, failPos - 1) + content.slice(failPos + 1) : null,
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      JSON.parse(c);
      return c;
    } catch { /* candidate did not parse */ }
  }
  return null;
};

/**
 * Attempt to repair a JSON string that has excess closing tokens from a deeply
 * nested structure. Tries removing `}`, `]}`, and `}]` patterns around the failure point.
 * @param content Raw content that should be a JSON object
 * @returns Repaired content string, or null when repair is not possible
 */
const repairExtraBrace = (content: string): string | null => {
  const failPos = detectBraceFailurePos(content);
  if (failPos === BRACE_POS_VALID) return content;
  if (failPos === BRACE_POS_UNREPAIRABLE) return null;
  return tryBraceRemovals(content, failPos);
};

/**
 * Build the ordered list of candidate strings to attempt JSON parsing against.
 * @param content Raw LLM response content
 * @returns Ordered array of candidate strings (non-empty)
 */
const buildJsonCandidates = (content: string): string[] => {
  const trimmed = content.trim();
  const stripped = stripCodeFences(trimmed);
  return [
    stripped,
    repairExtraBrace(stripped),
    extractOutermostJsonObject(stripped),
    extractFirstJsonObject(stripped),
    extractFirstJsonObject(trimmed),
  ].filter((c): c is string => c !== null);
};

/**
 * Parse JSON from an LLM response after removing common wrapper text or fences.
 * @param content Raw LLM response content
 * @returns Parsed JSON payload
 * @throws SyntaxError when no valid JSON object can be parsed
 */
export const parseJsonResponse = <T>(content: string): T => {
  const candidates = buildJsonCandidates(content);
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new SyntaxError('No valid JSON object found in AI response');
};

/**
 * Normalize a repository hint for plan prompt examples.
 * @param repositories Optional affected repository list
 * @returns First repository name or a generic fallback
 */
const resolvePlanPromptRepoExample = (repositories?: string[]): string => {
  const firstRepository = repositories?.find(repo => typeof repo === 'string' && repo.trim());
  return firstRepository?.trim() || 'current-repo';
};

const REVIEW_TRACE_META_PATTERNS: RegExp[] = [
  /\banalyz(?:e|ed|ing|is)?\b/i,
  /\breviewer?\b/i,
  /\bdiff[_\s-]?loaded\b/i,
  /\bdiff review\b/i,
  /\bticket lookup\b/i,
  /\bpr discovery\b/i,
  /\bcode review complete\b/i,
  /\bissues? found\b/i,
  /\bgenerat(?:e|ed|ing)\s+suggestions?\b/i,
  /\bprovid(?:e|ed|ing)\s+suggestions?\b/i,
  /\bapproval status\b/i,
  /\breview flow\b/i,
  /\breview process\b/i,
  /\breviewed\b/i,
];

const REVIEW_TRACE_ANCHOR_PATTERNS: RegExp[] = [
  /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /\bclass\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
  /\b(?:public|private|protected)?\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g,
  /\b(?:this\.)?([A-Za-z_$][\w$]*)\s*=\s*/g,
];

const REVIEW_TRACE_STOP_WORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'constructor',
  'default', 'delete', 'do', 'else', 'false', 'finally', 'for', 'function', 'if', 'import',
  'let', 'new', 'null', 'protected', 'private', 'public', 'return', 'static', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'undefined', 'var', 'while', 'with',
]);

/**
 * Collect identifiers matched by one anchor pattern from the diff.
 * @param diff Git diff text to scan
 * @param pattern Anchor regex with a capture group for the identifier
 * @returns Set of lowercased identifiers (stop words excluded)
 */
const collectAnchorMatches = (diff: string, pattern: RegExp): Set<string> => {
  const found = new Set<string>();
  for (const match of diff.matchAll(pattern)) {
    const candidate = match[1]?.trim();
    if (!candidate) continue;
    const lowered = candidate.toLowerCase();
    if (!REVIEW_TRACE_STOP_WORDS.has(lowered)) found.add(lowered);
  }
  return found;
};

/**
 * Extract code identifiers from a diff that can be used as trace anchors.
 * @param diff Git diff text
 * @returns Array of unique lowercased identifier strings
 */
const extractReviewTraceAnchors = (diff: string): string[] => {
  const anchors = new Set<string>();
  for (const pattern of REVIEW_TRACE_ANCHOR_PATTERNS) {
    for (const id of collectAnchorMatches(diff, pattern)) anchors.add(id);
  }
  return [...anchors];
};

const traceContainsCodeAnchors = (traceText: string, anchors: string[]): boolean =>
  anchors.some(anchor => traceText.includes(anchor));

const traceContainsReviewerAnalysisLanguage = (traceText: string): boolean =>
  REVIEW_TRACE_META_PATTERNS.some(pattern => pattern.test(traceText));

/**
 * Build the lowercase JSON text used for trace contamination checks.
 * @param review Code review object whose trace fields are serialized
 * @returns Lowercased JSON string of callStack and stateTransition
 */
const buildTraceText = (review: CodeReview): string =>
  JSON.stringify({ callStack: review.callStack ?? [], stateTransition: review.stateTransition ?? {} }).toLowerCase();

/**
 * Sanitize the code review trace, clearing contaminated or unverifiable entries.
 * @param review Parsed CodeReview object
 * @param diff Git diff used for anchor extraction
 * @returns Review with cleared trace fields when contamination is detected
 */
export const sanitizeCodeReviewTrace = (review: CodeReview, diff: string): CodeReview => {
  const traceText = buildTraceText(review);
  const anchors = extractReviewTraceAnchors(diff);
  const hasCodeAnchors = anchors.length > 0 && traceContainsCodeAnchors(traceText, anchors);
  const hasReviewerAnalysisLanguage = traceContainsReviewerAnalysisLanguage(traceText);

  if (!hasCodeAnchors || hasReviewerAnalysisLanguage) {
    return { ...review, traceProvenance: 'unavailable', callStack: [], stateTransition: {} };
  }

  return review;
};

type ReviewResponseDiagnostics = Pick<
  AIResponse,
  'provider' | 'model' | 'finishReason' | 'stopReason' | 'refusal' | 'contentTypes' | 'usage'
> & {
  content: string;
};

type ResponseContentDiagnostics = Pick<
  AIResponse,
  'provider' | 'model' | 'finishReason' | 'stopReason' | 'refusal' | 'contentTypes' | 'usage'
> & {
  content: string;
};

const REVIEW_EMPTY_RESPONSE_RETRY_LIMIT = 1;

const BLANK_REVIEW_FINISH_REASONS = new Set([
  'content_filter', 'error', 'guardrail', 'invalid_request',
  'model_context_window_exceeded', 'recitation', 'refusal',
  'safety', 'tool_use',
]);

const isBlankReviewResponse = (response: ReviewResponseDiagnostics): boolean => response.content.trim().length === 0;

const hasJsonContent = (content: string): boolean => findFirstBrace(content) !== -1;

/**
 * Return true when the finish/stop reason or refusal signals a non-retriable failure.
 * @param response Adapter response diagnostics
 * @returns Whether a non-recoverable signal is present
 */
const hasNonRecoverableSignal = (response: ReviewResponseDiagnostics): boolean => {
  if (response.refusal?.trim()) return true;
  const finishReason = response.finishReason?.trim().toLowerCase();
  if (finishReason && BLANK_REVIEW_FINISH_REASONS.has(finishReason)) return true;
  const stopReason = response.stopReason?.trim().toLowerCase();
  if (stopReason && BLANK_REVIEW_FINISH_REASONS.has(stopReason)) return true;
  const contentTypes = response.contentTypes ?? [];
  return contentTypes.length > 0 && !contentTypes.includes('text');
};

const hasRecoverableBlankReviewMetadata = (response: ReviewResponseDiagnostics): boolean =>
  !hasNonRecoverableSignal(response);

/**
 * Validates that a review-stage model response contains JSON-bearing text.
 *
 * @param response - Adapter or stage-agent response plus diagnostics
 * @returns Trimmed response content when non-empty
 * @throws AIError when the provider returned blank or non-text review output
 */
export const requireReviewResponseContent = (response: ReviewResponseDiagnostics): string =>
  requireAiResponseContent(response, 'AI provider returned an empty review response');

/**
 * Build the AIError thrown when the provider returns empty content.
 * @param response Adapter response diagnostics
 * @param message Human-readable error message
 * @returns Constructed AIError
 */
const buildEmptyResponseError = (response: ResponseContentDiagnostics, message: string): AIError =>
  new AIError(
    message,
    {
      provider: response.provider,
      model: response.model,
      finishReason: response.finishReason,
      stopReason: response.stopReason,
      refusal: response.refusal,
      contentTypes: response.contentTypes,
      usage: response.usage,
      response: response.content,
    },
    hasRecoverableBlankReviewMetadata(response)
  );

/**
 * Validates that a provider response contains non-empty text content.
 *
 * @param response - Adapter response plus diagnostics
 * @param message - Error message to raise for empty output
 * @returns Trimmed response content when non-empty
 * @throws AIError when the provider returned blank output
 */
export const requireAiResponseContent = (response: ResponseContentDiagnostics, message: string): string => {
  if (!isBlankReviewResponse(response)) return response.content.trim();
  throw buildEmptyResponseError(response, message);
};

/**
 * Validates that a review-stage response contains JSON-bearing text.
 * Composes with the blank-content check, then adds a JSON-presence check.
 *
 * @param response - Adapter or stage-agent response plus diagnostics
 * @returns Trimmed response content when it contains at least one `{`
 * @throws AIError when the provider returned blank output (delegated to requireReviewResponseContent)
 * @throws AIError when the provider returned non-blank prose without any JSON
 */
// eslint-disable-next-line max-lines-per-function -- parity with buildEmptyResponseError detail fields
const requireReviewJsonContent = (response: ReviewResponseDiagnostics): string => {
  const content = requireReviewResponseContent(response);
  if (hasJsonContent(content)) return content;
  throw new AIError(
    'AI provider returned a prose review response without JSON',
    {
      provider: response.provider,
      model: response.model,
      finishReason: response.finishReason,
      stopReason: response.stopReason,
      refusal: response.refusal,
      contentTypes: response.contentTypes,
      usage: response.usage,
      response: content,
    },
    hasRecoverableBlankReviewMetadata(response)
  );
};

/**
 * Normalizes a mixed array of legacy string paths and FileEntry objects
 * into a uniform FileEntry array. Legacy strings default to status 'found'.
 *
 * @param raw - Array of string paths or FileEntry objects
 * @returns Normalized FileEntry array
 */
export const normalizeFileEntries = (raw: (string | FileEntry)[]): FileEntry[] =>
  raw.map(entry => (typeof entry === 'string' ? { filePath: entry, status: 'found' as const } : entry));

/**
 * Collect non-empty discovery prompt sections for the given context.
 * @param context Raw plan context object
 * @returns Array of non-empty section strings
 */
const collectDiscoverySections = (context: Record<string, unknown>): string[] => {
  const repoName = (context.affectedRepositories as string[] | undefined)?.[0] ?? 'repo';
  const candidates = [
    context.conventions && formatRepoConventionsPromptSection(context.conventions as RepoConventionsContext, repoName),
    context.crossRepoPatterns && formatCrossRepoPatternsPromptSection(context.crossRepoPatterns as CrossRepoContext),
    context.planCorrelation && formatPlanCorrelationPromptSection(context.planCorrelation as PlanCorrelationResult),
    context.priorPlans && formatPriorPlansPromptSection(context.priorPlans as PriorPlanContext),
  ];
  return candidates.filter((s): s is string => typeof s === 'string');
};

/**
 * Build the discovery context block injected into the plan prompt.
 * @param context Raw plan context object
 * @returns Newline-delimited discovery sections, or empty string
 */
const buildPlanDiscoveryBlock = (context: Record<string, unknown>): string => {
  const parts = collectDiscoverySections(context);
  return parts.length > 0 ? `\n${parts.join('\n\n')}\n` : '';
};

/**
 * Build the agent-analysis preamble block from context.
 * @param context Optional plan context
 * @returns Agent analysis block string, or empty string
 */
const buildAgentAnalysisBlock = (context?: Record<string, unknown>): string =>
  context?.agentAnalysis
    ? `Prior analysis (from agent codebase exploration — use as structured input, output JSON only):\n${(context.agentAnalysis as string).slice(0, 8000)}\n\n`
    : '';

/**
 * Build the repo-hint and retry-feedback preamble blocks from context.
 * @param context Optional plan context
 * @returns Object with repoHint and retryFeedbackBlock strings
 */
type PlanFeedbackBlocks = { repoHint: string; retryFeedbackBlock: string };

const buildPlanFeedbackBlocks = (context?: Record<string, unknown>): PlanFeedbackBlocks => {
  const repos = context?.affectedRepositories as string[] | undefined;
  const repoHint = repos?.length
    ? `Affected repositories (hint): ${repos.join(', ')}\n\n`
    : '';
  const qualityFeedback = context?.planQualityFeedback;
  const retryFeedbackBlock
    = Array.isArray(qualityFeedback) && (qualityFeedback as string[]).length > 0
      ? `Previous plan attempt was rejected for these exact reasons:\n${(qualityFeedback as string[]).join('\n')}\n\nRegenerate the full plan and fix every listed problem. Do not repeat any rejected step wording.\n\n`
      : '';
  return { repoHint, retryFeedbackBlock };
};

/**
 * Build the preamble section of the plan prompt.
 * @param action Plan action type
 * @param issueContent Raw issue text
 * @param context Optional plan context
 * @returns Preamble string
 */
const buildPlanPreamble = (
  action: ResolutionAction,
  issueContent: string,
  context?: Record<string, unknown>
): string => {
  const agentAnalysisBlock = buildAgentAnalysisBlock(context);
  const { repoHint, retryFeedbackBlock } = buildPlanFeedbackBlocks(context);
  return `${agentAnalysisBlock}
Action: ${action}
Issue Content:
${issueContent}

${context ? `Context:\n${JSON.stringify(context, null, 2)}` : ''}

${repoHint}${retryFeedbackBlock}`;
};

const PLAN_STEP_INSTRUCTIONS = `Create a detailed resolution plan with:
1. A brief summary of the issue and proposed solution
2. Specific, actionable steps to resolve the issue — when the ticket includes code examples, embed relevant snippets inline (e.g., "Replace \`oldFunction()\` with \`newFunction()\` in src/utils.ts")
   Every rename, move, or refactoring step MUST state both the current name/path AND the
   replacement name/path (e.g., "Rename class \`PaymentService\` to \`PaymentProcessorService\`
   in src/payments/payment.service.ts"). A step that says only "rename X" without the target
   is unusable by the implementer and will be rejected.
   When a step adds a new call site to an existing function or method, the plan MUST trace every existing call site for that function and note whether the shared code path already handles the new case. If it does, state so explicitly and skip the redundant change. If it does not, list which call sites need updating.
   When a step adds or modifies a JSDoc comment or docstring, the prose MUST be cross-checked against the implementation's guard clauses. If the function throws on null input, the docstring must document that. If the function silently returns undefined, the docstring must not claim it throws.
   When a step says "remove line X inside block Y", the plan MUST state whether the
   surrounding block (function, if-branch, class) becomes dead code after the removal
   and whether it should also be removed. Do not leave dead-code discovery to the
   implementer.
   When prescribing a new module-level helper near existing class methods, explicitly
   state its placement: "add as a module-level function outside the class, near the
   existing \`<CONSTANT_NAME>\` constant at line N". Do not leave placement ambiguous —
   the implementer should not have to guess whether it belongs inside or outside the
   class.
   When a step introduces an interface field typed with \`| null\` or \`.nullable()\`,
   the plan MUST trace every consumer of that interface and specify the concrete
   behaviour for the null case (skip, default value, throw). Do not leave null
   handling to the implementer to discover during review.
   When a plan involves operations where cache state affects network access (e.g.,
   reading a cached token before calling an API), the plan MUST explicitly state
   that the cache check happens before the network call and note the consequence of
   reversing the order. Cache-before-network ordering bugs are silent and hard to
   catch in review.
   Generated-doc workflows (e.g., auto-generated README sections, API docs from
   schemas) MUST be treated as source-of-truth updates. The plan should prescribe
   re-running the generator — not manually patching the output file. If no generator
   exists, the plan should say so and prescribe the manual edit as a stopgap with a
   TODO to add generation later.

   When a step specifies the return type of a function or method, the plan MUST derive
   it from the call-site options that will actually be passed — not the function's
   default return type. If the call site passes options that narrow or widen the return
   type (e.g., an overload, a generic parameter, or a conditional return), the plan
   must state the concrete type the caller will see and use that in downstream steps.

   When a plan prescribes adding specific text to a file (e.g., a prompt paragraph, a
   config key, a schema field), the plan MUST include a verification step that greps
   for a unique, distinctive substring of that text in the target file. If the substring
   is already present, the step should be marked as "already implemented" and skipped.
   Do NOT conclude that prescribed text is present based on thematic similarity to
   nearby content — perform an exact substring check.

   When a plan changes the semantics of a CLI option (e.g., making an option optional,
   changing its default, renaming it, or restricting its values), the plan MUST trace
   every user-facing surface that references that option — help text, command
   documentation, README examples, man pages — and include update steps for each.
   Restricting the affected-files list to only the implementation and its test misses
   help/doc text drift.

   When the implementation stage involves iterative fix-and-retry cycles, the plan
   MUST require verification of both working-tree and staged/index state before
   handoff (e.g., before commit). A file with both staged and unstaged changes can
   cause the commit to ship a stale version. The plan should prescribe an explicit
   clean-state check before the handoff step.

   When a plan includes a manual smoke test as an acceptance check, the implementation
   stage MUST either run it or explicitly mark it as incomplete with a reason. A plan
   that lists a smoke test but never executes it appears complete when one of its
   acceptance criteria was silently skipped.

   When a plan step prescribes a test, the plan MUST trace the execution path
   through the mock/DI setup to the first point where the command returns or
   fails downstream. State whether the test will reach a clean return or a
   downstream error, and prescribe the strongest viable positive assertion for
   that path. A test that only asserts "no throw" proves nothing if the mock
   setup silently short-circuits the code under test.

   When new code intentionally swallows or downgrades errors (e.g., "log a warning
   and continue" instead of throwing), the plan MUST include failure-path test
   coverage for that behaviour. Verify that the warning is emitted, the return value
   is correct on the failure path, and downstream code handles the degraded state.
   Silent error swallowing without coverage is a latent bug.

   When a plan affects more than 10 files, group the steps into phases. Each phase should contain related changes that can be verified together (e.g., "Phase 1: Schema changes", "Phase 2: Service layer", "Phase 3: Tests"). Add a \`phases\` array to the JSON output:

     "phases": [
       { "label": "Schema changes", "stepIndices": [0, 1, 2], "verifyAfter": ["yarn test -- src/shared/schemas/"] },
       { "label": "Service updates", "stepIndices": [3, 4, 5] }
     ]

   Each phase's \`verifyAfter\` commands run after that group completes. These commands MUST be a subset of the commands in \`verification.targeted\` — do not invent commands that are not in the verification whitelist. Omit \`verifyAfter\` when no meaningful intermediate check exists. Steps not assigned to a phase are executed after all phases.
3. Estimated complexity (low/medium/high)
4. Files that will be **modified** — use objects with "filePath" and "status". Prefix EVERY
   path with its repository name (e.g., "service-tourv3/src/pricing/pricing.service.ts").
   Use the repository names from affectedRepositories when available. Use REAL file paths
   from the repository — not globs, not placeholders. Set status to "found" for existing
   files or "to-create" for new files the plan will create.
   IMPORTANT: Do NOT guess or infer file paths from conventions. You MUST verify each path
   exists by searching the repository (e.g., grep, find, or reading directory listings)
   before listing it. Hallucinated paths cause the implementer to stall.
5. Files needed for **context only** (read, not edit) — same object shape as affectedFiles.
   E.g., reading package.json to confirm a dependency is installed. All context files must
   have status "found" — you cannot read a file that does not exist yet. Verify each path
   exists before listing it.
6. Potential risks or considerations
7. Repositories that will be affected (if known — use provided hints or infer from ticket text)
8. New repositories that must be created (not yet existing locally) — a subset of affectedRepositories. Omit or leave empty when the plan only touches existing repos`;

const PLAN_VERIFICATION_CORE = `9. Task-specific verification only when needed:
   - Use "verification.targeted" for focused checks required by this specific plan
   - Use "verification.waivers" only when this plan needs to explicitly waive a repo-level baseline check
   - Omit "verification" entirely when no targeted checks or waivers are needed
   - Verification commands run from the selected repository root
   - Every verification command must exit 0 when it succeeds
   - Commands must be copy-paste-runnable: reference ONLY scripts/binaries listed in the
     "Available test infrastructure" section. Do not invent scripts.
   - CRITICAL: verification commands are validated against the allowlist above. Any command
     that does not match an allowed form will be rejected. When unsure, use: node -e "..."`;

const PLAN_VERIFICATION_NODE_ADDENDUM = `   - Verification commands MUST be shell-safe by construction. For inline \`node -e\`, prefer
     single-quoted JS strings or properly escaped backticks — never rely on unescaped
     template literals inside double-quoted shell strings.`;

const PLAN_VERIFICATION_TAIL = `   - Each verification command MUST be relevant to this plan: it should verify a side effect
     or behavior introduced by the steps above, not just run the whole test suite.
   - Each verification command MUST target the specific behavior introduced by the step it validates
     — not unrelated output like global README string order or full-file snapshots.
     A verification that checks something the step did not change will produce false failures.
     Good: "node -e \\"require('node:assert').ok(require('./src/config').validate())\\""
     Bad: "yarn test" (too broad — does not target the planned change)
   - Verification commands that use CLI flags (e.g., jest --forceExit, tsc --noEmit) MUST
     cross-check flag names against the installed framework version. If the flag was added
     in a later version or renamed, the command will fail for reasons unrelated to the
     change. When uncertain, prefer the long-form flag name and note the minimum version.
   - For inline assertions, prefer: node -e "const assert = require('node:assert'); ..."
     (when node:test is available) or the installed test framework CLI
   - If you need to prove an expected failure, wrap it in a shell assertion that exits 0 when the expected failure occurs.`;

const PLAN_MINIMAL_CHANGE = `Minimal-change principles — apply to every plan:
- Propose the smallest effective change. Do not modify files unrelated to the ticket.
- Limit verification to files edited by this plan.
- Each component should be designed to address a single responsibility.
- Prefer changes that are replaceable or deletable without cascading effects on other components.`;

const PLAN_TEST_CONVENTIONS = `When a plan step includes test code snippets or prescribes test changes:
   - Follow ALL test conventions listed above (mock cleanup, DI setup, error handling).
   - Mock isolation steps MUST be concrete, not conditional — prescribe the exact call, do not say "check whether X or add Y".
   - Test setup MUST match the DI wiring the code path requires — every injected service the code reaches MUST have a mock provider, not an empty object.
   - Follow the repo's existing test isolation conventions (detected above). If tests use jest.restoreAllMocks() in afterEach, new tests MUST do the same — do not introduce a different cleanup strategy.`;

/**
 * Build the verification block, optionally including the Node safety addendum.
 * @param hasNodeTestInfra Whether node test infrastructure was detected
 * @returns Multi-line verification instructions string
 */
const buildVerificationBlock = (hasNodeTestInfra: boolean): string =>
  [PLAN_VERIFICATION_CORE, hasNodeTestInfra ? PLAN_VERIFICATION_NODE_ADDENDUM : '', PLAN_VERIFICATION_TAIL]
    .filter(Boolean)
    .join('\n');

const PLAN_OUTPUT_SCHEMA_TEMPLATE_FILES = `  "affectedFiles": [{ "filePath": "REPO/src/path/to/file.ts", "status": "found" }, { "filePath": "REPO/src/path/to/new-file.ts", "status": "to-create" }],
  "affectedFilesContext": [{ "filePath": "REPO/package.json", "status": "found" }],`;

const PLAN_OUTPUT_SCHEMA_VERIFICATION = `  "verification": {
    "targeted": [
      {
        "id": "manual-review",
        "run": "yarn test:manual -- test-issue-review",
        "policy": "enforced",
        "reason": "Explain what this check covers"
      }
    ],
    "waivers": [
      {
        "id": "e2e",
        "reason": "Explain why this repo-level baseline check is waived"
      }
    ]
  }`;

/**
 * Build the JSON output schema example for the plan prompt.
 * @param action Plan action type
 * @param repoExample Example repository name
 * @returns Output schema string
 */
const buildPlanOutputSchema = (action: ResolutionAction, repoExample: string): string => {
  const filesSection = PLAN_OUTPUT_SCHEMA_TEMPLATE_FILES.replaceAll('REPO', repoExample);
  return `Return ONLY a valid JSON object with these fields:\n{\n  "action": "${action}",\n  "summary": "...",\n  "steps": ["step 1", "step 2", ...],\n  "estimatedComplexity": "low|medium|high",\n${filesSection}\n  "affectedRepositories": ["${repoExample}"],\n  "newRepositories": [],\n  "risks": ["risk 1", ...],\n${PLAN_OUTPUT_SCHEMA_VERIFICATION}\n}`;
};

/**
 * Build the plan prompt body from pre-built sections.
 * @param preamble Pre-built preamble string
 * @param discoveryBlock Pre-built discovery sections block
 * @param testSections Pre-built test infra and conventions sections
 * @param verificationBlock Pre-built verification instructions
 * @param outputSchema Pre-built output schema
 * @param skillSection Pre-built skill invocation hints block (empty string when no skills apply)
 * @returns Complete prompt string
 */
const assemblePlanPrompt = (
  preamble: string,
  discoveryBlock: string,
  testSections: [string, string],
  verificationBlock: string,
  outputSchema: string,
  skillSection: string
): string =>
  [preamble, discoveryBlock, PLAN_STEP_INSTRUCTIONS, skillSection, '\n', ...testSections, PLAN_MINIMAL_CHANGE, '\n', verificationBlock, '\n', outputSchema].join('');

const buildSkillSection = (context: Record<string, unknown> | undefined): string => {
  const skillNames = Array.isArray(context?.skillNames) ? (context.skillNames as string[]) : [];
  if (!skillNames.length) return '';
  return '\n\nSkill-specific instructions:\nBefore starting work, invoke each of the following skills using the Skill tool:\n'
    + skillNames.map((s: string) => `- Skill('${s}')`).join('\n')
    + '\nFollow each skill\'s instructions fully before proceeding.';
};

/**
 * Build the full plan prompt body including instructions, test infra, and output schema.
 * @param action Plan action type
 * @param issueContent Issue text
 * @param context Optional plan context
 * @param repoExample Example repository name for the JSON schema
 * @param discoveryBlock Pre-built discovery sections block
 * @param hasNodeTestInfra Whether node test infrastructure was detected
 * @returns Complete prompt string
 */
const buildPlanPromptBody = (
  action: ResolutionAction,
  issueContent: string,
  context: Record<string, unknown> | undefined,
  repoExample: string, discoveryBlock: string,
  hasNodeTestInfra: boolean
): string =>
  assemblePlanPrompt(
    buildPlanPreamble(action, issueContent, context),
    discoveryBlock,
    [context?.testInfra ? formatTestInfraPromptSection(context.testInfra as TestInfraContext) : '', context?.testInfra ? PLAN_TEST_CONVENTIONS : ''],
    buildVerificationBlock(hasNodeTestInfra),
    buildPlanOutputSchema(action, repoExample),
    buildSkillSection(context)
  );

/**
 * Detect whether the context describes a Node.js test ecosystem.
 * @param context Raw plan context object
 * @returns true when a node ecosystem entry is found
 */
const detectNodeTestInfra = (context?: Record<string, unknown>): boolean => {
  if (!context?.testInfra) return false;
  if (typeof context.testInfra !== 'object' || !('ecosystems' in context.testInfra)) return false;
  const infra = context.testInfra as { ecosystems?: Array<{ ecosystem?: string }> };
  return Array.isArray(infra.ecosystems) && infra.ecosystems.some(e => e.ecosystem === 'node');
};

/**
 * Normalize plan steps from the AI response into a plain string array.
 * @param rawSteps Array of unknown step values from the parsed plan
 * @returns String array of steps
 */
const normalizePlanSteps = (rawSteps: unknown[]): string[] =>
  rawSteps.map(step => {
    if (typeof step === 'string') return step;
    if (step && typeof step === 'object') {
      const s = step as Record<string, unknown>;
      const text = s['description'] ?? s['text'] ?? s['title'] ?? s['content'];
      if (typeof text === 'string') return text;
    }
    return String(step);
  });

/**
 * Derive the short model source identifier from a full model name and provider.
 * @param provider AI provider key
 * @param model Full model name
 * @returns Model name with provider prefix stripped
 */
const deriveModelSource = (provider: string, model: string): string => {
  const prefixMap: Record<string, string> = { anthropic: 'claude-', google: 'gemini-', deepseek: 'deepseek-', openai: 'gpt-' };
  const prefix = prefixMap[provider] ?? '';
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
};

/**
 * Throw when a response was truncated by the output token limit.
 * @param response AI response to inspect
 * @param stage Config stage label used in the error message
 */
const throwIfTruncated = (response: AIResponse, stage: string): void => {
  const truncated
    = response.stopReason === 'max_tokens'
      || response.finishReason === 'length'
      || response.finishReason === 'MAX_TOKENS';
  if (!truncated) return;
  throw new AIError(
    `${stage} response was truncated due to output token limit — the model ran out of space before completing the JSON. Increase stages.${stage.toLowerCase()}.maxTokens in wf.config.ts.`,
    { stopReason: response.stopReason, finishReason: response.finishReason, usage: response.usage }
  );
};

const PLAN_SYSTEM_PROMPT = `You are an expert software engineer creating detailed resolution plans.
Your task is to analyze the issue and create a structured plan with clear, actionable steps.
Return your response as a JSON object matching the ResolutionPlan interface.`;

const FINDINGS_SYSTEM_PROMPT = `You are an expert software investigator providing structured findings and recommendations.
Analyse the given investigation plan and any available ticket context to produce clear, actionable findings.
Return your response as a JSON object.`;

const COMMIT_SYSTEM_PROMPT = `You are an expert at writing clear, concise git commit messages.
Analyze the diff and commit history to generate an appropriate commit message.`;

const REVIEW_SYSTEM_PROMPT = `You are an expert code reviewer providing constructive feedback.
Focus on code quality, best practices, potential bugs, and security issues.
Ignore any changes to JSON or markdown files under \`.wf/\` or tracker artefact directories (jira/, bitbucket/) — review only application source code.
Return your response as a JSON object matching the CodeReview interface.`;

const REVIEW_PROMPT_TRACE_RULES = `    Important trace rules:
    - Describe the code under review, not the review process.
    - Do not return review-process steps such as "diff loaded", "analyzing", "reviewed", or "issues found" in callStack or stateTransition.
    - If the changed code cannot be traced confidently, set traceProvenance to "unavailable" and return empty callStack and stateTransition fields.
    - Evidence-based traces must mention concrete identifiers from the diff.
    - Use concrete code identifiers as callStack node labels, such as Class.method(...), functionName(...), or Client.method(...).
    - Nest child callStack nodes under the parent frame that directly invokes or depends on them.
    - When external effects matter, attach them as leaf nodes beneath the method that performs them, for example HttpClient.get(...), POST /endpoint, or SQL query execution.
    - Prefer executable units over prose: avoid nodes like "validates request", "maps response", or "calls external API" unless the concrete method name is unavailable in the diff.
    - Keep the tree in execution tense by naming the callable units and effect leaves, not by narrating what the reviewer thinks the code does.
    - For the state transition tree, use the same frame labels and capture the variable changes observed at each frame.
    - Use \`captured\` for the variables or objects observed at a frame, and \`changes\` for the values that changed between the current frame and the previous one.
    - For detailed traces, include important intermediate methods, mappers, helpers, and client calls when they materially affect the changed path.
    - Prefer multiple distinct tree levels when downstream dependencies are nested.`;

const REVIEW_PROMPT_OUTPUT_SCHEMA = `    Return ONLY a valid JSON object:
    {
      "summary": "...",
      "issues": [
    {
      "severity": "error|warning|info",
      "message": "...",
          "file": "optional",
          "line": optional_number,
          "suggestion": "optional issue-specific remediation"
        }
      ],
      "traceProvenance": "evidence-based|best-effort|unavailable",
      "callStack": [
        {
          "frame": "Class.method(...)",
          "children": [
            {
              "frame": "Child.method(...)",
              "children": []
            }
          ]
        }
      ],
      "stateTransition": {
        "from": "entry-frame",
        "to": "exit-frame",
        "steps": [
          {
            "frame": "Class.method(...)",
            "captured": {
              "some.dep": "Dep { ... }"
            },
            "changes": {
              "some.dep": {
                "before": "old value",
                "after": "new value"
              }
            },
            "children": []
          }
        ]
      },
      "suggestions": ["general follow-up suggestion 1", ...],
      "approved": true|false
    }`;

/**
 * Build the user-facing code review prompt.
 * @param diff Git diff text to review
 * @param guidelines Ordered review guideline strings
 * @param skillNames Optional skill IDs to include as Skill-tool invocation hints in the prompt
 * @returns Full review prompt string
 */
const formatReviewGuidelines = (guidelines: string[]): string =>
  guidelines.map((g, i) => (i + 1) + '. ' + g).join('\n');

const formatReviewSkillSection = (skillNames?: string[]): string => {
  if (!skillNames?.length) return '';
  const items = skillNames.map(s => '- Skill(\'' + s + '\')').join('\n');
  return '\nSkill-specific instructions:\nBefore starting review, invoke each of the following skills using the Skill tool:\n'
    + items + '\nFollow each skill\'s instructions fully before proceeding.\n';
};

const REVIEW_PROMPT_INSTRUCTIONS = `    Provide a code review with:
    1. A brief summary of the changes
    2. Any issues found (errors, warnings, or info)
    3. A trace provenance label: evidence-based, best-effort, or unavailable
    4. A nested tree-like call stack that walks the changed code path, starting from concrete functions, handlers, or methods in the diff
    5. A frame-aligned state transition tree that captures variable changes between the frames in the call stack, not the reviewer's analysis flow
    6. A suggestion for each issue when remediation is clear — each suggestion must recommend the smallest effective fix (the minimum change that resolves the issue without introducing unnecessary scope). Write suggestions in plain, human-friendly language: be concise, use everyday phrasing, and avoid jargon-heavy or robotic sentences.
    7. Optional trailing suggestions for general follow-up work that is not tied to a single issue — each must also prefer the smallest effective fix and use the same concise, human-friendly tone
    8. Whether the code is approved
`;

const buildReviewPrompt = (diff: string, guidelines: string[], skillNames?: string[]): string => {
  const codeSection = '\nCode Changes:\n```\n' + diff + '\n```\n';
  const guidelinesSection = '    Review Guidelines:\n' + formatReviewGuidelines(guidelines) + '\n';
  const skillSection = formatReviewSkillSection(skillNames);
  return [
    codeSection,
    guidelinesSection,
    REVIEW_PROMPT_INSTRUCTIONS,
    ...(skillSection ? [skillSection] : []),
    REVIEW_PROMPT_TRACE_RULES,
    '\n',
    REVIEW_PROMPT_OUTPUT_SCHEMA,
  ].join('\n');
};

/**
 * Execute one review attempt with unusable-response retry logic.
 * Retries when the response is blank or non-blank prose without JSON.
 * @param executeFn Async function that performs a single AI review call
 * @param maxRetries Maximum number of recoverable retries
 * @returns Final AIResponse after retries are exhausted or a usable response arrives
 */
// eslint-disable-next-line max-lines-per-function
const retryOnUnusableResponse = async (executeFn: () => Promise<AIResponse>, maxRetries: number): Promise<AIResponse> => { // eslint-disable-line max-len
  let response = await executeFn();
  let attemptCount = 0;

  while (attemptCount < maxRetries) {
    try {
      requireReviewJsonContent(response);
      return response;
    } catch (error) {
      if (!isAIErrorLike(error) || !error.recoverable) throw error;
      attemptCount += 1;
      response = await executeFn();
    }
  }

  // Validate one final time after exhausting retries
  requireReviewJsonContent(response);
  return response;
};

/**
 * Build the findings prompt from an investigation plan.
 * @param plan The investigation plan to summarize
 * @param ticketContent Optional raw ticket text for extra context
 * @returns Prompt string for the findings generation call
 */
const buildFindingsPrompt = (plan: ResolutionPlan, ticketContent?: string): string => `
Investigation Plan:
${JSON.stringify(plan, null, 2)}
${ticketContent ? `\nTicket Context:\n${ticketContent}\n` : ''}
Perform the investigation described in the plan and generate structured findings and recommendations.

Return ONLY a valid JSON object:
{
  "action": "investigate",
  "summary": "Brief summary of what was investigated and the key findings",
  "findings": ["finding 1", "finding 2", ...],
  "recommendations": ["recommendation 1", ...],
  "conclusion": "Overall conclusion and suggested next steps"
}`;

/**
 * Resolve the commit format instructions string for the given format.
 * @param detectedFormat Resolved commit format
 * @returns Format instructions string
 */
const resolveCommitFormatInstructions = (detectedFormat: 'conventional' | 'freeform'): string =>
  detectedFormat === 'conventional'
    ? `Use conventional commits format: <type>(<scope>): <subject>
Types: feat, fix, docs, style, refactor, test, chore
Example: "feat(auth): add JWT token validation"`
    : 'Write a clear, concise commit message describing the changes';

/**
 * Build the commit message generation prompt.
 * @param diff Git diff text (truncated to 3000 chars)
 * @param commitHistory Recent commit messages
 * @param formatInstructions Format-specific instructions
 * @param detectedFormat Resolved commit format
 * @param ticketContext Optional ticket context string
 * @returns Prompt string for commit message generation
 */
const buildCommitPrompt = (
  diff: string,
  commitHistory: string[],
  formatInstructions: string,
  detectedFormat: 'conventional' | 'freeform',
  ticketContext?: string
): string => {
  const ticketContextSection = ticketContext ? `Ticket context: ${ticketContext}\n\n` : '';
  const diffSection = `${diff.substring(0, 3000)} ${diff.length > 3000 ? '...(truncated)' : ''}`;
  const styleRule = detectedFormat === 'conventional' ? 'Follows conventional commits format' : 'Follows the existing commit message style';
  return `\n${ticketContextSection}Git Diff:\n\`\`\`\n${diffSection}\n\`\`\`\n\nRecent Commit History:\n${commitHistory.slice(0, 5).join('\n')}\n\n${formatInstructions}\n\nGenerate a commit message that:\n1. Reflects the ticket's intent, not just the code change pattern\n2. Follows the repository's commit message style\n3. Is concise but informative\n4. ${styleRule}\n\nDo NOT include ticket IDs, issue keys, or project codes in your message (e.g. WBP-1234, TAD-575). The ticket prefix is added automatically.\nReturn ONLY the commit message description, nothing else.`;
};

/**
 * Read the provider value for a stage from config, trying both key locations.
 * @param configService NestJS ConfigService
 * @param stage Stage name to look up
 * @returns Provider string or undefined
 */
const resolveStageProvider = (configService: ConfigService, stage: string): string | undefined =>
  configService.get<string>(`stages.${stage}.provider`)
  ?? configService.get<string>(`ai.stages.${stage}.provider`);

/**
 * Read the model value for a stage from config, trying both key locations.
 * @param configService NestJS ConfigService
 * @param stage Stage name to look up
 * @returns Model string or undefined
 */
const resolveStageModel = (configService: ConfigService, stage: string): string | undefined =>
  configService.get<string>(`stages.${stage}.model`)
  ?? configService.get<string>(`ai.stages.${stage}.model`);

@Injectable()
export class AiService {
  constructor(
    private readonly logger: LoggerService,
    @Inject(LLM_ADAPTER) private readonly adapter: LlmAdapter,
    private readonly configService: ConfigService
  ) {}

  async execute(request: AIRequest): Promise<AIResponse> {
    return this.adapter.execute({
      ...request,
      ...this.resolveAiTarget(request.stage, request.provider, request.model),
    });
  }

  /**
   * Execute a multi-turn conversation with the configured LLM provider.
   * Maintains conversation history by passing full message array to the adapter.
   *
   * @param request - Conversation request with message history
   * @returns AI response with content and token usage
   */
  async executeWithHistory(request: AIConversationRequest): Promise<AIResponse> {
    return this.adapter.executeWithHistory({
      ...request,
      ...this.resolveAiTarget(request.stage, request.provider, request.model),
    });
  }

  async generatePlan(
    action: ResolutionAction,
    issueContent: string,
    context?: Record<string, unknown>
  ): Promise<ResolutionPlan> {
    const repoExample = resolvePlanPromptRepoExample(context?.affectedRepositories as string[] | undefined);
    const discoveryBlock = context ? buildPlanDiscoveryBlock(context) : '';
    const hasNodeInfra = detectNodeTestInfra(context);
    const prompt = buildPlanPromptBody(action, issueContent, context, repoExample, discoveryBlock, hasNodeInfra);
    const planMaxTokens = this.configService.get<number>('stages.plan.maxTokens', DEFAULT_PLAN_MAX_TOKENS);
    const response = await this.execute({ prompt, systemPrompt: PLAN_SYSTEM_PROMPT, temperature: 0.5, maxTokens: planMaxTokens, stage: 'plan' });
    throwIfTruncated(response, 'Plan');
    return this.parsePlanResponse(response);
  }

  /**
   * Generate structured findings and recommendations from an investigation plan.
   *
   * @param plan - The investigation plan produced by PlannerAgent
   * @param ticketContent - Optional ticket markdown for additional context
   * @returns Structured findings document with findings and recommendations
   */
  async generateFindings(plan: ResolutionPlan, ticketContent?: string): Promise<FindingsDocument> {
    const findingsMaxTokens = this.configService.get<number>('stages.implement.maxTokens', DEFAULT_FINDINGS_MAX_TOKENS);
    const response = await this.execute({ prompt: buildFindingsPrompt(plan, ticketContent), systemPrompt: FINDINGS_SYSTEM_PROMPT, temperature: 0.4, maxTokens: findingsMaxTokens, stage: 'implement' });
    throwIfTruncated(response, 'Findings');
    return this.parseFindingsResponse(response);
  }

  async generateCommitMessage(
    diff: string,
    commitHistory: string[],
    format: 'conventional' | 'freeform' | 'auto' = 'auto',
    ticketContext?: string
  ): Promise<string> {
    const detectedFormat = this.resolveCommitFormat(format, commitHistory);
    const formatInstructions = resolveCommitFormatInstructions(detectedFormat);
    const prompt = buildCommitPrompt(diff, commitHistory, formatInstructions, detectedFormat, ticketContext);
    const response = await this.execute({ prompt, systemPrompt: COMMIT_SYSTEM_PROMPT, temperature: 0.3, maxTokens: 200, stage: 'commit' });
    return requireAiResponseContent(response, 'AI provider returned an empty commit message response');
  }

  async reviewCode(diff: string, guidelines: string[], onProgress?: StageProgressCallback): Promise<CodeReview> {
    onProgress?.('Synthesizing review...');
    const reviewMaxTokens = this.configService.get<number>('stages.review.maxTokens', DEFAULT_REVIEW_MAX_TOKENS);
    const reviewSkillIds = this.configService.get<string[]>('stages.review.skills') ?? [];
    const reviewSkillNames = reviewSkillIds.length
      ? (await resolveSkills(reviewSkillIds, { interactive: false, stage: 'review' })).map(s => s.id)
      : [];
    const executeReview = () =>
      this.execute({ prompt: buildReviewPrompt(diff, guidelines, reviewSkillNames.length ? reviewSkillNames : undefined), systemPrompt: REVIEW_SYSTEM_PROMPT, temperature: 0.3, maxTokens: reviewMaxTokens, stage: 'review' });
    const response = await retryOnUnusableResponse(executeReview, REVIEW_EMPTY_RESPONSE_RETRY_LIMIT);
    throwIfTruncated(response, 'Review');
    return this.parseReviewResponse(response, diff);
  }

  /**
   * Returns the full AI provider display name for use in dry-run previews.
   * Reads ai.provider from config (default: 'anthropic').
   *
   * @returns 'Anthropic Claude' | 'OpenAI' | 'Google Gemini' | 'DeepSeek'
   */
  getProviderDisplayName(): string {
    const provider = this.configService.get<string>('ai.provider', 'anthropic');
    if (provider === 'openai') return 'OpenAI';
    if (provider === 'google') return 'Google Gemini';
    if (provider === 'deepseek') return 'DeepSeek';
    return 'Anthropic Claude';
  }

  /**
   * Returns a short AI provider name for use in interactive chat UI labels.
   * Reads ai.provider from config (default: 'anthropic').
   *
   * @returns 'Claude' | 'OpenAI' | 'Gemini' | 'DeepSeek'
   */
  getProviderShortName(): string {
    const provider = this.configService.get<string>('ai.provider', 'anthropic');
    if (provider === 'openai') return 'OpenAI';
    if (provider === 'google') return 'Gemini';
    if (provider === 'deepseek') return 'DeepSeek';
    return 'Claude';
  }

  /**
   * Resolve stage-level provider and model, validating that both or neither are set.
   * @param stage Stage name to look up
   * @param fallback Default provider/model to use when no stage override is present
   * @returns Resolved provider and model
   */
  private resolveStageTarget(
    stage: string,
    fallback: { provider: string; model: string }
  ): { provider?: string; model?: string } {
    const stageProvider = resolveStageProvider(this.configService, stage);
    const stageModel = resolveStageModel(this.configService, stage);
    if (!stageProvider && !stageModel) return fallback;
    if (!stageProvider || !stageModel) throw new AIError(`AI stage target for "${stage}" must define provider and model together.`);
    return { provider: stageProvider, model: stageModel };
  }

  private resolveAiTarget(
    stage?: 'plan' | 'implement' | 'review' | 'generate' | 'commit' | 'create',
    providerOverride?: string,
    modelOverride?: string
  ): { provider?: string; model?: string } {
    if (providerOverride || modelOverride) {
      if (!providerOverride || !modelOverride) throw new AIError('AI provider and model overrides must be supplied together.');
      return { provider: providerOverride, model: modelOverride };
    }
    const provider = this.configService.get<string>('ai.provider', 'anthropic');
    const model = this.configService.get<string>('ai.model', '');
    if (!stage) return { provider, model };
    return this.resolveStageTarget(stage, { provider, model });
  }

  /**
   * Resolve the detected commit format from the format hint and commit history.
   * @param format Requested format, may be 'auto'
   * @param commitHistory Recent commit messages used for format detection
   * @returns Resolved 'conventional' or 'freeform'
   */
  private resolveCommitFormat(
    format: 'conventional' | 'freeform' | 'auto',
    commitHistory: string[]
  ): 'conventional' | 'freeform' {
    if (format !== 'auto') return format;
    return commitHistory.length > 0 ? this.detectCommitFormat(commitHistory) : 'freeform';
  }

  private detectCommitFormat(commitHistory: string[]): 'conventional' | 'freeform' {
    const conventionalPattern = /^(feat|fix|docs|style|refactor|test|chore)(\(.+\))?:/;
    const conventionalCount = commitHistory.filter(msg => conventionalPattern.test(msg)).length;
    return conventionalCount / commitHistory.length > 0.6 ? 'conventional' : 'freeform';
  }

  /**
   * Stamp provider metadata onto a parsed plan in place.
   * @param plan Mutable ResolutionPlan to annotate
   * @param response AIResponse metadata from the adapter; falls back to
   *   resolveAiTarget('plan') when either field is absent, honouring stage overrides
   */
  private stampPlanMetadata(
    plan: ResolutionPlan & { repositoriesAffected?: string[] },
    response: { provider?: string; model?: string }
  ): void {
    if (!plan.affectedRepositories && plan.repositoriesAffected) plan.affectedRepositories = plan.repositoriesAffected;
    delete plan.repositoriesAffected;
    plan.steps = normalizePlanSteps(Array.isArray(plan.steps) ? plan.steps : []);
    const { provider, model } = response.provider && response.model ? { provider: response.provider, model: response.model } : this.resolveAiTarget('plan');
    plan.provider = provider ?? 'anthropic';
    plan.source = deriveModelSource(plan.provider, model ?? '');
    plan.timestamp = dayjs().toISOString();
  }

  /**
   * Parse and normalize the AI response into a ResolutionPlan.
   * @param response Raw AI response from the plan execution call
   * @returns Normalized ResolutionPlan with provider metadata
   * @throws AIError on empty or unparseable response
   */
  private parsePlanResponse(response: AIResponse): ResolutionPlan {
    try {
      const plan = parseJsonResponse<ResolutionPlan & { repositoriesAffected?: string[] }>(
        requireAiResponseContent(response, 'AI provider returned an empty plan response')
      );
      this.stampPlanMetadata(plan, response);
      return plan;
    } catch (error) {
      if (isAIErrorLike(error)) throw error;
      this.logger.error('Failed to parse AI response as JSON', error);
      throw new AIError('Failed to parse resolution plan from AI response', { response: response.content, error });
    }
  }

  /**
   * Parse the findings AI response into a FindingsDocument.
   * @param response Raw AI response from the findings execution call
   * @returns Parsed FindingsDocument
   * @throws AIError on empty or unparseable response
   */
  private parseFindingsResponse(response: AIResponse): FindingsDocument {
    try {
      return parseJsonResponse<FindingsDocument>(
        requireAiResponseContent(response, 'AI provider returned an empty investigation findings response')
      );
    } catch (error) {
      if (isAIErrorLike(error)) throw error;
      this.logger.error('Failed to parse findings response', error);
      throw new AIError('Failed to parse investigation findings from AI response', { response: response.content, error });
    }
  }

  /**
   * Parse the review AI response into a CodeReview.
   * @param response Raw AI response from the review execution call
   * @param diff Git diff used for trace sanitization
   * @returns Parsed and sanitized CodeReview
   * @throws AIError on empty or unparseable response
   */
  private parseReviewResponse(response: AIResponse, diff: string): CodeReview {
    try {
      const parsed = codeReviewSchema.parse(
        parseJsonResponse<CodeReview>(requireReviewResponseContent(response))
      );
      const processedReview = postProcessCodeReview(sanitizeCodeReviewTrace(parsed, diff), diff);
      return { ...processedReview.review, executionMode: 'standard' };
    } catch (error) {
      if (isAIErrorLike(error)) throw error;
      this.logger.error('Failed to parse code review response', error);
      throw new AIError('Failed to parse code review from AI response', { response: response.content, error });
    }
  }
}
