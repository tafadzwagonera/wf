import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import dayjs from 'dayjs';
import { AiProviderError, isAiProviderErrorLike } from '../../shared/utils/errors';
import { formatZodError, isZodErrorLike } from '../../shared/utils/zod-error.util';
import { LoggerService } from '../../shared/logger/logger.service';
import { LLM_ADAPTER } from './llm-adapter.interface';
import type { LlmAdapter } from './llm-adapter.interface';
import { formatTestInfraPromptSection, type TestInfraContext } from '../../shared/utils/detect-test-infra';
import {
  parseDiffFileStats,
  formatDiffStatSummary,
  buildPrioritizedDiffExcerpt,
  isDocsOnlyChangeset,
  declaresDocsOnlyType,
  extractConventionalType,
} from '../../shared/utils/commit-diff-stat';
import { postProcessCodeReview } from '../../review/code-review-post-processing';
import { resolveSkills } from '../../skills';
import {
  formatRepoConventionsPromptSection,
  type RepoConventionsContext,
} from '../../shared/utils/detect-repo-conventions';
import { isUiRelevantTicket } from '../../shared/utils/detect-ui-relevance';
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
import {
  formatReuseCandidatesPromptSection,
  type ReuseCandidateContext,
} from '../../shared/utils/detect-reuse-candidates';
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
import { resolutionPlanSchema } from '../../shared/schemas/ai.schema';
import type { ResolutionAction, StageProgressCallback } from '../../shared/types/agent.types';
import { JSON_OUTPUT_RULES } from './json-output-rules';
import {
  buildPlanSkillSection,
  buildPlanTestConventionsBlock,
  buildPlanVerificationBlock,
  buildReviewSkillSection,
  buildUiDesignComplianceSystemPromptSection,
  deriveModelSource,
  formatFigmaPlanPromptSection,
  formatUiDesignScreenshotsPlanPromptSection,
  planFileListingInstructions,
  planMinimalChangePrinciple,
  planStepPrinciples,
  reviewInstructions,
  reviewOutputSchema,
  reviewTraceGuidance,
} from './prompt-fragments';
import { UiDesignScreenshotsStageService } from '../../review/ui-design-screenshots-stage.service';
import type { UiDesignScreenshot } from '../../shared/types/ui-design-screenshot';

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

const reviewTraceMetaPatterns: RegExp[] = [
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

const reviewTraceAnchorPatterns: RegExp[] = [
  /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /\bclass\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
  /\b(?:public|private|protected)?\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g,
  /\b(?:this\.)?([A-Za-z_$][\w$]*)\s*=\s*/g,
];

const reviewTraceStopWords = new Set([
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
    if (!reviewTraceStopWords.has(lowered)) found.add(lowered);
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
  for (const pattern of reviewTraceAnchorPatterns) {
    for (const id of collectAnchorMatches(diff, pattern)) anchors.add(id);
  }
  return [...anchors];
};

const traceContainsCodeAnchors = (traceText: string, anchors: string[]): boolean =>
  anchors.some(anchor => traceText.includes(anchor));

const traceContainsReviewerAnalysisLanguage = (traceText: string): boolean =>
  reviewTraceMetaPatterns.some(pattern => pattern.test(traceText));

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
const PLAN_EMPTY_RESPONSE_RETRY_LIMIT = 1;

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
 * @throws AiProviderError when the provider returned blank or non-text review output
 */
export const requireReviewResponseContent = (response: ReviewResponseDiagnostics): string =>
  requireAiResponseContent(response, 'AI provider returned an empty review response');

/**
 * Build the AiProviderError thrown when the provider returns empty content.
 * @param response Adapter response diagnostics
 * @param message Human-readable error message
 * @returns Constructed AiProviderError
 */
// eslint-disable-next-line max-lines-per-function -- category arg extends parity with requireReviewJsonContent
const buildEmptyResponseError = (response: ResponseContentDiagnostics, message: string): AiProviderError =>
  new AiProviderError(
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
    hasRecoverableBlankReviewMetadata(response),
    'parse'
  );

/**
 * Validates that a provider response contains non-empty text content.
 *
 * @param response - Adapter response plus diagnostics
 * @param message - Error message to raise for empty output
 * @returns Trimmed response content when non-empty
 * @throws AiProviderError when the provider returned blank output
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
 * @throws AiProviderError when the provider returned blank output (delegated to requireReviewResponseContent)
 * @throws AiProviderError when the provider returned non-blank prose without any JSON
 */
// eslint-disable-next-line max-lines-per-function -- parity with buildEmptyResponseError detail fields
const requireReviewJsonContent = (response: ReviewResponseDiagnostics): string => {
  const content = requireReviewResponseContent(response);
  if (hasJsonContent(content)) return content;
  throw new AiProviderError(
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
    hasRecoverableBlankReviewMetadata(response),
    'parse'
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
 * @param issueContent
 * @returns Array of non-empty section strings
 */
const buildDiscoveryCandidates = (
  context: Record<string, unknown>, conventions: RepoConventionsContext | undefined,
  repoName: string, isUiRelevant: boolean,
) => [
  conventions && formatRepoConventionsPromptSection(conventions, repoName, { includeDesignSystem: isUiRelevant }),
  context.crossRepoPatterns && formatCrossRepoPatternsPromptSection(context.crossRepoPatterns as CrossRepoContext),
  context.planCorrelation && formatPlanCorrelationPromptSection(context.planCorrelation as PlanCorrelationResult),
  context.priorPlans && formatPriorPlansPromptSection(context.priorPlans as PriorPlanContext),
  context.reuseCandidates && formatReuseCandidatesPromptSection(context.reuseCandidates as ReuseCandidateContext),
  formatFigmaPlanPromptSection(context.figmaLinks as string[] | undefined, Boolean(conventions?.designSystem)),
  formatUiDesignScreenshotsPlanPromptSection(context.uiDesignScreenshots as string[] ?? []),
];

const collectDiscoverySections = (context: Record<string, unknown>, issueContent = ''): string[] => {
  const repoName = (context.affectedRepositories as string[] | undefined)?.[0] ?? 'repo';
  const conventions = context.conventions as RepoConventionsContext | undefined;
  const figmaLinks = context.figmaLinks as string[] | undefined;
  const isUiRelevant = Boolean(figmaLinks?.length) || isUiRelevantTicket(issueContent);
  const candidates = buildDiscoveryCandidates(context, conventions, repoName, isUiRelevant);
  return candidates.filter((s): s is string => typeof s === 'string' && s.length > 0);
};

/**
 * Build the discovery context block injected into the plan prompt.
 * @param context Raw plan context object
 * @returns Newline-delimited discovery sections, or empty string
 */
const buildPlanDiscoveryBlock = (context: Record<string, unknown>, issueContent = ''): string => {
  const parts = collectDiscoverySections(context, issueContent);
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

const planStepInstructions = `Create a detailed resolution plan with:
1. A brief summary of the issue and proposed solution
2. Specific, actionable steps to resolve the issue — when the ticket includes code examples, embed relevant snippets inline (e.g., "Replace \`oldFunction()\` with \`newFunction()\` in src/utils.ts")
${planStepPrinciples}
${planFileListingInstructions}`;

/**
 * Build the JSON output schema example for the plan prompt.
 * @param action Plan action type
 * @param repoExample Example repository name
 * @returns Output schema string
 */
const buildPlanOutputSchema = (action: ResolutionAction, repoExample: string): string => {
  return `Return ONLY a valid JSON object. Reference:
{"action":"${action}","summary":"Extract shared auth guard into a reusable middleware.","steps":["Rename AuthGuard to SharedAuthGuard in ${repoExample}/src/auth/guard.ts","Update all import paths in ${repoExample}/src/controllers/"],"estimatedComplexity":"medium","affectedFiles":[{"filePath":"${repoExample}/src/auth/guard.ts","status":"found"},{"filePath":"${repoExample}/src/middleware/auth.middleware.ts","status":"to-create"}],"affectedFilesContext":[{"filePath":"${repoExample}/package.json","status":"found"}],"affectedRepositories":["${repoExample}"],"newRepositories":[],"risks":["Renaming may break downstream consumers"],"verification":{"targeted":[{"id":"manual-review","run":"yarn test:manual -- test-auth-guard","policy":"enforced","reason":"Verify guard behaviour after rename"}]}}

When an optional field has no value, omit it from the JSON entirely. Do not use null.

${JSON_OUTPUT_RULES}`;
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
  [preamble, discoveryBlock, planStepInstructions, skillSection, '\n', ...testSections, planMinimalChangePrinciple, '\n', verificationBlock, '\n', outputSchema].join('');

const extractSkillNames = (context: Record<string, unknown> | undefined): string[] | undefined => {
  const skillNames = Array.isArray(context?.skillNames) ? (context.skillNames as string[]) : [];
  return skillNames.length ? skillNames : undefined;
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
    [context?.testInfra ? formatTestInfraPromptSection(context.testInfra as TestInfraContext) : '', buildPlanTestConventionsBlock(!!context?.testInfra)],
    buildPlanVerificationBlock(hasNodeTestInfra),
    buildPlanOutputSchema(action, repoExample),
    buildPlanSkillSection(extractSkillNames(context))
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
  throw new AiProviderError(
    `${stage} response was truncated due to output token limit — the model ran out of space before completing the JSON. Increase stages.${stage.toLowerCase()}.maxTokens in wf.config.ts.`,
    { stopReason: response.stopReason, finishReason: response.finishReason, usage: response.usage },
    true,
    'truncation'
  );
};

const planSystemPrompt = `You are a software architect producing resolution plans. Prioritize correctness and minimal blast radius.
Return your response as a JSON object matching the ResolutionPlan interface.`;

export const findingsSystemPrompt = `You are a software investigator. Distinguish root causes from symptoms, and ground every finding in concrete evidence.
Return your response as a JSON object.`;

const commitSystemPrompt = `You are a commit message author. Capture intent over mechanics — the reader should understand "why" without opening the diff.`;

const reviewSystemPrompt = `You are a code reviewer. Assess quality, correctness, and security using your judgment — flag what matters, skip noise.
Ignore JSON or markdown files under \`.wf/\` or tracker artefact directories (jira/, bitbucket/) — review only application source code.
Return your response as a JSON object matching the CodeReview interface.`;

const formatReviewGuidelines = (guidelines: string[]): string =>
  guidelines.map((g, i) => (i + 1) + '. ' + g).join('\n');

const buildReviewPrompt = (diff: string, guidelines: string[], skillNames?: string[]): string => {
  const codeSection = '\nCode Changes:\n```\n' + diff + '\n```\n';
  const skillSection = buildReviewSkillSection(skillNames);
  return [
    codeSection,
    'Review Guidelines:\n' + formatReviewGuidelines(guidelines) + '\n',
    reviewInstructions,
    ...(skillSection ? [skillSection] : []),
    reviewTraceGuidance,
    '\n',
    reviewOutputSchema,
  ].join('\n');
};

const VALIDATION_RETRY_LIMIT = 2;

const buildValidationCorrectionPrompt = (invalidJson: string, zodErrors: string): string =>
  'The following JSON failed schema validation.\n\nValidation errors:\n'
  + zodErrors
  + '\n\nInvalid payload:\n'
  + invalidJson
  + '\n\nReturn ONLY the corrected, minified JSON object. When an optional field has no value, omit it — do not use null.';

const getValidationCorrectionEmptyMessage = (stage: 'plan' | 'review'): string =>
  stage === 'plan'
    ? 'AI provider returned an empty plan correction response'
    : 'AI provider returned an empty review correction response';

const resolveValidationFailureMessage = (stage: 'plan' | 'review'): string =>
  stage === 'plan' ? 'Plan JSON could not be corrected' : 'Review JSON could not be corrected';

type ValidationRetryLoopArgs<T> = {
  evaluateCorrection: (
    error: unknown,
    attempt: number,
    previousErrorCount: number
  ) => { zodErrors: string; errorCount: number } | null;
  failureMessage: string;
  parseFn: (content: string) => T;
  rawJson: string;
  requestCorrection: (content: string, zodErrors: string) => Promise<string>;
};

const runValidationRetryLoop = async <T>(args: ValidationRetryLoopArgs<T>): Promise<T> => {
  let content = args.rawJson;
  let previousErrorCount = Infinity;
  for (let attempt = 0; attempt <= VALIDATION_RETRY_LIMIT; attempt += 1) {
    try {
      return args.parseFn(content);
    } catch (error) {
      const correction = args.evaluateCorrection(error, attempt, previousErrorCount);
      if (!correction) break;
      previousErrorCount = correction.errorCount;
      content = await args.requestCorrection(content, correction.zodErrors);
    }
  }
  throw new AiProviderError(args.failureMessage, { response: content }, true, 'parse');
};

const buildPlanProseErrorDetails = (
  response: AIResponse,
  content: string
): Record<string, unknown> => ({
  provider: response.provider,
  model: response.model,
  finishReason: response.finishReason,
  stopReason: response.stopReason,
  refusal: response.refusal,
  contentTypes: response.contentTypes,
  usage: response.usage,
  response: content,
});

/**
 * Execute one review attempt with unusable-response retry logic.
 * Retries when the response is blank or non-blank prose without JSON.
 * @param executeFn Async function that performs a single AI review call
 * @param validateFn
 * @param maxRetries Maximum number of recoverable retries
 * @returns Final AIResponse after retries are exhausted or a usable response arrives
 */
// eslint-disable-next-line max-lines-per-function
const retryOnUnusableResponse = async (
  executeFn: () => Promise<AIResponse>,
  validateFn: (response: AIResponse) => string,
  maxRetries: number
): Promise<AIResponse> => {
  let response = await executeFn();
  for (let attemptCount = 0; attemptCount < maxRetries; attemptCount += 1) {
    try {
      validateFn(response);
      return response;
    } catch (error) {
      if (!isAiProviderErrorLike(error) || !error.recoverable) throw error;
      response = await executeFn();
    }
  }
  validateFn(response);
  return response;
};

const findingsInvestigationPrinciples = `Investigation principles:
- Follow the plan's investigation steps, but surface findings you discover beyond them
- Distinguish root causes from symptoms — recommendations should address causes
- Be specific: reference files, config keys, error messages, and identifiers`;

const findingsOutputSchema = `Return ONLY a valid JSON object:
{
  "action": "investigate",
  "summary": "Brief summary of what was investigated and the key findings",
  "findings": ["finding 1", "finding 2", ...],
  "recommendations": ["recommendation 1", ...],
  "conclusion": "Overall conclusion and suggested next steps"
}

${JSON_OUTPUT_RULES}`;

/**
 * Build the findings prompt from an investigation plan.
 * @param plan The investigation plan to summarize
 * @param ticketContent Optional raw ticket text for extra context
 * @returns Prompt string for the findings generation call
 */
export const buildFindingsPrompt = (plan: ResolutionPlan, ticketContent?: string): string => `
Investigation Plan:
${JSON.stringify(plan, null, 2)}
${ticketContent ? `\nTicket Context:\n${ticketContent}\n` : ''}
${findingsInvestigationPrinciples}

${findingsOutputSchema}`;

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

const COMMIT_DIFF_EXCERPT_MAX_CHARS = 3000;

/**
 * Build the commit message generation prompt. Leads with a full, untruncated
 * file-change summary (sorted by lines changed) so the model always sees the
 * true scope of the change, then fills the remaining budget with the diff
 * content for the most-changed files first — the highest-signal files are
 * never the ones silently dropped by truncation.
 * @param diff Git diff text
 * @param commitHistory Recent commit messages
 * @param formatInstructions Format-specific instructions
 * @param detectedFormat Resolved commit format
 * @param ticketContext Optional ticket context string
 * @param correction Optional corrective note appended when retrying after a type/scope mismatch
 * @returns Prompt string for commit message generation
 */
const buildCommitPrompt = (
  diff: string,
  commitHistory: string[],
  formatInstructions: string,
  detectedFormat: 'conventional' | 'freeform',
  ticketContext?: string,
  correction?: string
): string => {
  const ticketContextSection = ticketContext ? `Ticket context: ${ticketContext}\n\n` : '';
  const { statSummary, diffExcerpt } = buildDiffContextSections(diff);
  const principles = buildCommitPromptPrinciples(detectedFormat, correction);
  return `\n${ticketContextSection}${statSummary}Git Diff:\n\`\`\`\n${diffExcerpt}\n\`\`\`\n\nRecent Commit History:\n`
    + `${commitHistory.slice(0, 5).join('\n')}\n\n${formatInstructions}\n\n${principles}`
    + '\n\nReturn ONLY the commit message description, nothing else.';
};

const buildDiffContextSections = (diff: string): { statSummary: string; diffExcerpt: string } => {
  const stats = parseDiffFileStats(diff);
  const statSummary = stats.length > 0 ? `${formatDiffStatSummary(stats)}\n\n` : '';
  const diffExcerpt = buildPrioritizedDiffExcerpt(diff, stats, COMMIT_DIFF_EXCERPT_MAX_CHARS);
  return { statSummary, diffExcerpt };
};

const buildCommitPromptPrinciples = (detectedFormat: 'conventional' | 'freeform', correction?: string): string => {
  const styleRule = detectedFormat === 'conventional' ? 'follows conventional commits format' : 'follows the existing commit message style';
  const styleRuleBullet = `Match the repository's existing commit style and ${styleRule}`;
  const bullets = [
    "Capture the ticket's intent, not just the mechanical code change",
    styleRuleBullet,
    'Be concise but informative — a reader should understand the "why" without opening the diff',
    'Omit ticket IDs or project codes (e.g. WBP-1234) — the prefix is added automatically',
    'The type/scope must reflect the full file list above, not just the first files in the diff',
  ];
  const bulletLines = bullets.map(b => `- ${b}`).join('\n');
  const correctionLine = correction ? `\n\n${correction}` : '';
  return `Commit message principles:\n${bulletLines}${correctionLine}`;
};

interface CommitPromptParams {
  diff: string;
  commitHistory: string[];
  formatInstructions: string;
  detectedFormat: 'conventional' | 'freeform';
  ticketContext?: string;
  correction?: string;
}

/**
 * Build a corrective instruction for a retry after the model declared a
 * docs/style/chore type on a changeset that isn't docs-only.
 * @param previousMessage The mismatched commit message from the first attempt
 * @returns Corrective instruction text to append to the retry prompt
 */
const buildDocsTypeCorrection = (previousMessage: string): string => {
  const type = extractConventionalType(previousMessage) ?? 'docs';
  return `Correction: your previous type ("${type}") implied a docs-only change, but the file list above includes `
    + 'substantive source changes outside docs/tests. Re-classify the type (e.g. feat, fix, refactor).';
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
  @Optional()
  @Inject(UiDesignScreenshotsStageService)
  private readonly uiDesignScreenshotsStageService?: UiDesignScreenshotsStageService;

  constructor(
    private readonly logger: LoggerService,
    @Inject(LLM_ADAPTER) private readonly adapter: LlmAdapter,
    private readonly configService: ConfigService
  ) {}

  async execute(request: AIRequest): Promise<AIResponse> {
    const target = this.resolveAiTarget(request.stage, request.provider, request.model);
    return this.adapter.execute({ ...request, ...target });
  }

  /**
   * Execute a multi-turn conversation with the configured LLM provider.
   * Maintains conversation history by passing full message array to the adapter.
   *
   * @param request - Conversation request with message history
   * @returns AI response with content and token usage
   */
  async executeWithHistory(request: AIConversationRequest): Promise<AIResponse> {
    const target = this.resolveAiTarget(request.stage, request.provider, request.model);
    return this.adapter.executeWithHistory({ ...request, ...target });
  }

  async generatePlan(
    action: ResolutionAction,
    issueContent: string,
    context?: Record<string, unknown>
  ): Promise<ResolutionPlan> {
    const screenshots = this.encodeUiScreenshots(context);
    const { prompt, planMaxTokens } = this.buildPlanGenerationRequest(action, issueContent, context);
    const response = await retryOnUnusableResponse(
      () => this.executePlanPrompt(prompt, planMaxTokens, screenshots),
      response => this.requirePlanJsonContent(response),
      PLAN_EMPTY_RESPONSE_RETRY_LIMIT
    );
    throwIfTruncated(response, 'Plan');
    return this.parsePlanResponse(response);
  }

  private encodeUiScreenshots(context?: Record<string, unknown>): UiDesignScreenshot[] {
    const paths = context?.uiDesignScreenshots as string[] | undefined;
    if (!paths?.length || !this.uiDesignScreenshotsStageService) return [];
    return this.uiDesignScreenshotsStageService.encodeFromPaths(paths).screenshots;
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
    const response = await this.execute({ prompt: buildFindingsPrompt(plan, ticketContent), systemPrompt: findingsSystemPrompt, temperature: 0.4, maxTokens: findingsMaxTokens, stage: 'implement' });
    throwIfTruncated(response, 'Implement');
    return this.parseFindingsResponse(response);
  }

  private async runCommitPrompt(params: CommitPromptParams): Promise<string> {
    const { diff, commitHistory, formatInstructions, detectedFormat, ticketContext, correction } = params;
    const prompt = buildCommitPrompt(
      diff, commitHistory, formatInstructions, detectedFormat, ticketContext, correction
    );
    const response = await this.execute({ prompt, systemPrompt: commitSystemPrompt, temperature: 0.3, maxTokens: 200, stage: 'commit' });
    return requireAiResponseContent(response, 'AI provider returned an empty commit message response');
  }

  async generateCommitMessage(
    diff: string,
    commitHistory: string[],
    format: 'conventional' | 'freeform' | 'auto' = 'auto',
    ticketContext?: string
  ): Promise<string> {
    const detectedFormat = this.resolveCommitFormat(format, commitHistory);
    const formatInstructions = resolveCommitFormatInstructions(detectedFormat);
    const base = { diff, commitHistory, formatInstructions, detectedFormat, ticketContext };
    const firstAttempt = await this.runCommitPrompt(base);

    const stats = parseDiffFileStats(diff);
    if (isDocsOnlyChangeset(stats) || !declaresDocsOnlyType(firstAttempt)) return firstAttempt;

    return this.runCommitPrompt({ ...base, correction: buildDocsTypeCorrection(firstAttempt) });
  }

  async reviewCode(
    diff: string, guidelines: string[], onProgress?: StageProgressCallback
  ): Promise<CodeReview> {
    onProgress?.('Synthesizing review...');
    const reviewMaxTokens = this.configService.get<number>('stages.review.maxTokens', DEFAULT_REVIEW_MAX_TOKENS);
    const reviewPrompt = await this.buildReviewPromptFrom(diff, guidelines);
    const response = await retryOnUnusableResponse(
      () => this.executeReviewPrompt(reviewPrompt, reviewMaxTokens),
      requireReviewJsonContent,
      REVIEW_EMPTY_RESPONSE_RETRY_LIMIT
    );
    throwIfTruncated(response, 'Review');
    return this.validateReviewJson(requireReviewResponseContent(response), diff, reviewMaxTokens);
  }

  private async buildReviewPromptFrom(diff: string, guidelines: string[]): Promise<string> {
    const reviewSkillIds = this.configService.get<string[]>('stages.review.skills') ?? [];
    const reviewSkillNames = await this.resolveReviewSkillNames(reviewSkillIds);
    return buildReviewPrompt(diff, guidelines, reviewSkillNames.length ? reviewSkillNames : undefined);
  }

  /**
   * Returns the full AI provider display name for use in dry-run previews.
   * Reads ai.provider from config (default: 'anthropic').
   *
   * @param stage - Optional workflow stage name; when provided, the stage-level provider override is checked first
   * @returns 'Anthropic Claude' | 'OpenAI' | 'Google Gemini' | 'DeepSeek'
   */
  getProviderDisplayName(stage?: string): string {
    const provider = stage
      ? resolveStageProvider(this.configService, stage) ?? this.configService.get<string>('ai.provider', 'anthropic')
      : this.configService.get<string>('ai.provider', 'anthropic');
    if (provider === 'openai') return 'OpenAI';
    if (provider === 'google') return 'Google Gemini';
    if (provider === 'deepseek') return 'DeepSeek';
    return 'Anthropic Claude';
  }

  /**
   * Returns a short AI provider name for use in interactive chat UI labels.
   * Reads ai.provider from config (default: 'anthropic').
   *
   * @param stage - Optional workflow stage name; when provided, the stage-level provider override is checked first
   * @returns 'Claude' | 'OpenAI' | 'Gemini' | 'DeepSeek'
   */
  getProviderShortName(stage?: string): string {
    const provider = stage
      ? resolveStageProvider(this.configService, stage) ?? this.configService.get<string>('ai.provider', 'anthropic')
      : this.configService.get<string>('ai.provider', 'anthropic');
    if (provider === 'openai') return 'OpenAI';
    if (provider === 'google') return 'Gemini';
    if (provider === 'deepseek') return 'DeepSeek';
    return 'Claude';
  }

  /**
   * Returns the API endpoint path for the resolved provider.
   *
   * @param stage - Optional workflow stage name; when provided, the stage-level provider override is checked first
   * @returns '/v1/messages' | '/chat/completions' | '/v1beta/models'
   */
  getProviderEndpoint(stage?: string): string {
    const provider = stage
      ? resolveStageProvider(this.configService, stage) ?? this.configService.get<string>('ai.provider', 'anthropic')
      : this.configService.get<string>('ai.provider', 'anthropic');
    if (provider === 'google') return '/v1beta/models';
    if (provider === 'openai' || provider === 'deepseek') return '/chat/completions';
    return '/v1/messages';
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
    if (!stageProvider || !stageModel) throw new AiProviderError(`AI stage target for "${stage}" must define provider and model together.`);
    return { provider: stageProvider, model: stageModel };
  }

  private resolveAiTarget(
    stage?: 'plan' | 'implement' | 'review' | 'generate' | 'commit' | 'create',
    providerOverride?: string,
    modelOverride?: string
  ): { provider?: string; model?: string } {
    if (providerOverride || modelOverride) {
      if (!providerOverride || !modelOverride) throw new AiProviderError('AI provider and model overrides must be supplied together.');
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

  private executePlanPrompt(
    prompt: string, maxTokens: number, screenshots?: UiDesignScreenshot[],
  ): Promise<AIResponse> {
    const paths = screenshots?.map(s => s.path);
    const compliance = buildUiDesignComplianceSystemPromptSection({ uiDesignScreenshots: paths });
    const systemPrompt = compliance ? `${planSystemPrompt}\n\n${compliance}` : planSystemPrompt;
    const context = screenshots?.length ? { screenshots } : undefined;
    return this.execute({ prompt, systemPrompt, temperature: 0.5, maxTokens, stage: 'plan', context });
  }

  private executeReviewPrompt(prompt: string, maxTokens: number): Promise<AIResponse> {
    return this.execute({ prompt, systemPrompt: reviewSystemPrompt, temperature: 0.3, maxTokens, stage: 'review' });
  }

  private buildPlanGenerationRequest(
    action: ResolutionAction,
    issueContent: string,
    context?: Record<string, unknown>
  ): { planMaxTokens: number; prompt: string } {
    const repoExample = resolvePlanPromptRepoExample(context?.affectedRepositories as string[] | undefined);
    const discoveryBlock = context ? buildPlanDiscoveryBlock(context, issueContent) : '';
    const hasNodeInfra = detectNodeTestInfra(context);
    return {
      planMaxTokens: this.configService.get<number>('stages.plan.maxTokens', DEFAULT_PLAN_MAX_TOKENS),
      prompt: buildPlanPromptBody(action, issueContent, context, repoExample, discoveryBlock, hasNodeInfra),
    };
  }

  private async resolveReviewSkillNames(reviewSkillIds: string[]): Promise<string[]> {
    if (!reviewSkillIds.length) return [];
    return (await resolveSkills(reviewSkillIds, { interactive: false, stage: 'review' })).map(s => s.id);
  }

  private requirePlanJsonContent(response: AIResponse): string {
    const content = requireAiResponseContent(response, 'AI provider returned an empty plan response');
    if (hasJsonContent(content)) return content;
    throw new AiProviderError(
      'AI provider returned a prose plan response without JSON',
      buildPlanProseErrorDetails(response, content),
      hasRecoverableBlankReviewMetadata(response),
      'parse'
    );
  }

  private applyRepositoriesAffected(
    plan: ResolutionPlan,
    repositoriesAffected?: string[]
  ): ResolutionPlan {
    if (!plan.affectedRepositories && repositoriesAffected) {
      plan.affectedRepositories = repositoriesAffected;
    }
    return plan;
  }

  /**
   * Parse and normalize the AI response into a ResolutionPlan.
   * @param response Raw AI response from the plan execution call
   * @returns Normalized ResolutionPlan with provider metadata
   * @throws AiProviderError on empty or unparseable response
   */
  private parsePlanResponse(response: AIResponse): ResolutionPlan {
    try {
      const parsedPlan = parseJsonResponse<ResolutionPlan & { repositoriesAffected?: string[] }>(
        requireAiResponseContent(response, 'AI provider returned an empty plan response')
      );
      const plan = this.parsePlanContent(parsedPlan);
      this.stampPlanMetadata(plan, response);
      return plan;
    } catch (error) {
      if (isAiProviderErrorLike(error)) throw error;
      this.logger.error('Failed to parse AI response as JSON', error);
      throw new AiProviderError('Failed to parse resolution plan from AI response', { response: response.content, error }, true, 'parse');
    }
  }

  private parsePlanContent(parsedPlan: ResolutionPlan & { repositoriesAffected?: string[] }): ResolutionPlan {
    return this.applyRepositoriesAffected(resolutionPlanSchema.parse(parsedPlan), parsedPlan.repositoriesAffected);
  }

  /**
   * Parse the findings AI response into a FindingsDocument.
   * @param response Raw AI response from the findings execution call
   * @returns Parsed FindingsDocument
   * @throws AiProviderError on empty or unparseable response
   */
  private parseFindingsResponse(response: AIResponse): FindingsDocument {
    try {
      return parseJsonResponse<FindingsDocument>(
        requireAiResponseContent(response, 'AI provider returned an empty investigation findings response')
      );
    } catch (error) {
      if (isAiProviderErrorLike(error)) throw error;
      this.logger.error('Failed to parse findings response', error);
      throw new AiProviderError('Failed to parse investigation findings from AI response', { response: response.content, error }, true, 'parse');
    }
  }

  /**
   * Validate and repair raw review JSON via Zod, retrying up to VALIDATION_RETRY_LIMIT times.
   * @param rawJson Raw JSON string from the AI provider
   * @param diff Git diff used for trace sanitization
   * @param maxTokens Optional token limit for correction calls
   * @returns Validated and post-processed CodeReview
   * @throws AiProviderError when the review JSON cannot be corrected after retries
   */
  async validateReviewJson(rawJson: string, diff: string, maxTokens?: number): Promise<CodeReview> {
    const reviewMaxTokens = maxTokens ?? this.configService.get<number>('stages.review.maxTokens', DEFAULT_REVIEW_MAX_TOKENS);
    return this.retryValidationParsing(
      rawJson,
      content => this.parseAndProcessReviewContent(content, diff),
      'review',
      reviewSystemPrompt,
      reviewMaxTokens
    );
  }

  /**
   * Validate and repair raw plan JSON via Zod, retrying up to VALIDATION_RETRY_LIMIT times.
   * @param rawJson Raw JSON string from the AI provider
   * @returns Validated and stamped ResolutionPlan
   * @throws AiProviderError when the plan JSON cannot be corrected after retries
   */
  async validatePlanJson(rawJson: string): Promise<ResolutionPlan> {
    const planMaxTokens = this.configService.get<number>('stages.plan.maxTokens', DEFAULT_PLAN_MAX_TOKENS);
    const plan = await this.retryValidationParsing<ResolutionPlan>(
      rawJson,
      content => this.parsePlanValidationContent(content),
      'plan',
      planSystemPrompt,
      planMaxTokens
    );
    this.stampPlanMetadata(plan, {});
    return plan;
  }

  private parseAndProcessReviewContent(content: string, diff: string): CodeReview {
    const parsed = codeReviewSchema.parse(parseJsonResponse<CodeReview>(content));
    const processedReview = postProcessCodeReview(sanitizeCodeReviewTrace(parsed, diff), diff);
    return { ...processedReview.review, executionMode: 'standard', repairStrategy: 'validation' };
  }

  private parsePlanValidationContent(content: string): ResolutionPlan {
    return this.parsePlanContent(
      parseJsonResponse<ResolutionPlan & { repositoriesAffected?: string[] }>(content)
    );
  }

  private async requestValidationCorrection(
    content: string,
    zodErrors: string,
    systemPrompt: string,
    stage: 'plan' | 'review',
    maxTokens: number
  ): Promise<string> {
    return this.requireValidationCorrectionContent(
      await this.executeValidationCorrection(content, zodErrors, systemPrompt, stage, maxTokens),
      stage
    );
  }

  private createValidationCorrectionRequester(
    systemPrompt: string,
    stage: 'plan' | 'review',
    maxTokens: number
  ): (content: string, zodErrors: string) => Promise<string> {
    return (content, zodErrors) => this.requestValidationCorrection(content, zodErrors, systemPrompt, stage, maxTokens);
  }

  private executeValidationCorrection(
    content: string,
    zodErrors: string,
    systemPrompt: string,
    stage: 'plan' | 'review',
    maxTokens: number
  ): Promise<AIResponse> {
    return this.execute({
      prompt: buildValidationCorrectionPrompt(content, zodErrors),
      systemPrompt,
      temperature: 0.2,
      maxTokens,
      stage,
    });
  }

  private requireValidationCorrectionContent(response: AIResponse, stage: 'plan' | 'review'): string {
    return requireAiResponseContent(response, getValidationCorrectionEmptyMessage(stage));
  }

  private evaluateValidationCorrection(
    error: unknown, attempt: number, previousErrorCount: number
  ): { zodErrors: string; errorCount: number } | null {
    if (isAiProviderErrorLike(error)) throw error;
    const errorCount = isZodErrorLike(error) ? error.issues.length : Infinity;
    const stalled = attempt > 0 && errorCount >= previousErrorCount;
    if (stalled || attempt >= VALIDATION_RETRY_LIMIT) return null;
    return { zodErrors: isZodErrorLike(error) ? formatZodError(error) : String(error), errorCount };
  }

  private async retryValidationParsing<T>(
    rawJson: string,
    parseFn: (content: string) => T,
    stage: 'plan' | 'review',
    systemPrompt: string,
    maxTokens: number
  ): Promise<T> {
    return runValidationRetryLoop({
      rawJson,
      parseFn,
      evaluateCorrection: this.evaluateValidationCorrection.bind(this),
      failureMessage: resolveValidationFailureMessage(stage),
      requestCorrection: this.createValidationCorrectionRequester(systemPrompt, stage, maxTokens),
    });
  }
}
