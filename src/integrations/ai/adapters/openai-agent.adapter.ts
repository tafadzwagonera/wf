import { ConfigService } from '@nestjs/config';
import {
  Agent,
  MaxTurnsExceededError,
  ModelBehaviorError,
  OpenAIProvider,
  Runner,
  RunContext,
  SystemError,
  ToolCallError,
  ToolTimeoutError,
  UserError,
  setTracingExportApiKey,
  tool,
} from '@openai/agents';
import type { StreamedRunResult, RunState } from '@openai/agents';
import { OpenAIResponsesCompactionSession } from '@openai/agents-openai';
import chalk from 'chalk';
import * as fs from 'node:fs/promises';
import { exec } from 'node:child_process';
import { glob } from 'glob';
import OpenAI from 'openai';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type {
  TicketArtifact,
  PlanArtifact,
  ImplementerOptions,
  ImplementerBackend,
  VerificationScript,
  VerificationOutcome,
} from '../../../agents/interfaces';
import { resolveSkippedSteps, printVerificationReport } from './verification-report';
import {
  buildVerificationCommandOrder,
  buildVerificationProgressSignal,
  countDiagnosticLines,
  extractVerificationErrorClasses,
  type ImplementProgressVerificationSnapshot,
} from '../../../shared/utils/implement-verification';
import { loadAiContextConfig } from './load-ai-context-config';
import {
  resolveModelRouting,
  normalizeCommand,
  buildAllowedCommands,
  stripRepoPrefix,
  isGlobPattern,
  buildPlanContext,
  buildImplementerRulesSection,
} from './shared-routing';
import { buildSkillPromptFragment } from '../../../skills/skill-content';
import type { ResolutionPlan } from '../ai.service';

const execAsync = promisify(exec);
const DEFAULT_MODEL = 'gpt-4.1';
const MAX_BUFFER_IN_BYTES = 1024 * 1024 * 10;
const MAX_GREP_LINE_LENGTH = 500;
const MAX_READ_LINES = 200;
const DEFAULT_MECHANICAL_MODEL = 'gpt-5.1-codex-mini';
const OPENAI_AGENT_LABEL = 'openai-agent';
const MAX_VERIFICATION_OUTPUT_LINES = 200;
const COMPACTION_INPUT_TOKEN_CEILING = 80_000;
const STATE_PRUNING_TOKEN_CEILING = 120_000;
const STATE_PRUNING_KEEP_TAIL_ITEMS = 20;
const MAX_CONSECUTIVE_RATE_LIMIT_RETRIES = 5;

const shellEscape = (value: string): string => "'" + value.replaceAll("'", String.raw`'\''`) + "'";

type WorkspaceRoot = { name: string; root: string };

type OpenAiImplementerContext = {
  repoDir: string;
  readRoots: WorkspaceRoot[];
  allowedVerificationCommands: Set<string>;
};

type ValidationFailure = { path: string; error: string; line?: number };

type ToolMutableState = {
  fileChangeStatus: Map<string, 'created' | 'updated' | 'deleted'>;
  changedFilesSinceLastVerification: Set<string>;
  validationFailures: ValidationFailure[];
};

type VerifyCommandState = {
  verificationCommandOrder: Map<string, number>;
  previousSnapshot: ImplementProgressVerificationSnapshot | undefined;
  changedFiles: Set<string>;
  verificationScripts: VerificationScript[];
  verificationOutcomes: VerificationOutcome[];
};

export type OpenAiUsageSummary = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  compacted: boolean;
};

type RawResponseUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputTokensDetails?: { cachedTokens?: number; cached_tokens?: number };
  requestUsageEntries?: Array<{ endpoint?: string }>;
};

type StreamLoopState = {
  usageSummary: OpenAiUsageSummary;
  fileChangeStatus: Map<string, string>;
  lastObservedInputTokens: number;
  consecutiveRateLimitAttempts: number;
  eventsInSegment: number;
};

type StreamRunConfig = {
  runner: Runner;
  agent: Agent<OpenAiImplementerContext>;
  context: OpenAiImplementerContext;
  maxTurns: number;
  compaction: OpenAIResponsesCompactionSession;
};

type RunItemShape = {
  type?: string;
  name?: string;
  status?: string;
  content?: Array<{ text?: string }>;
  rawItem?: { content?: Array<{ text?: string }> };
};

type AgentClassification = { label: string; detail: string; recoverable: boolean };

type ExecError = { stdout?: string; stderr?: string; message?: string; code?: number };

type OaiAgent = Agent<OpenAiImplementerContext>;

type OaiStreamedRun = StreamedRunResult<OpenAiImplementerContext, OaiAgent>;

type GenerateAndVerifyParams = {
  ticket: TicketArtifact;
  planArtifact: PlanArtifact;
  verificationScripts: VerificationScript[];
  repoFiles: string[];
  contextFiles?: string[];
  repoName: string;
  trackedFilePaths: string[];
  skillNames?: string[];
};

/**
 * Finds a safe prune cut index that avoids orphaning reasoning/function_call pairs.
 *
 * @param items - Generated items array from RunState
 * @param desiredCut - Initial desired cut boundary
 * @returns Safe cut index, or 0 if none exists
 */
const findSafePruneIndex = (
  items: Array<Record<string, unknown>>,
  desiredCut: number
): number => {
  let cutIndex = desiredCut;
  while (cutIndex > 0) {
    const rawItem = items[cutIndex]?.rawItem as Record<string, unknown> | undefined;
    if (rawItem?.type === 'function_call') {
      cutIndex--;
      continue;
    }
    break;
  }
  return cutIndex;
};

/**
 * Builds a compact summary message for pruned state items.
 *
 * @param cutIndex - Number of items removed
 * @param fileChangeStatus - Map of file paths to change status
 * @returns Summary string
 */
const buildPruneSummary = (cutIndex: number, fileChangeStatus: Map<string, string>): string => {
  const changed = [...fileChangeStatus.entries()].map(([p, s]) => `${p} (${s})`).join(', ');
  return [
    `[Context pruned: ${cutIndex} earlier items removed to stay within context limits.]`,
    changed ? `Files changed so far: ${changed}` : '',
    'Continue from where you left off. Do not re-read files you have already edited unless needed.',
  ].filter(Boolean).join('\n');
};

/**
 * Extracts the generated items array from run state if prunable.
 *
 * @param state - The RunState from `streamedRun.state`
 * @returns Items array, or undefined if unavailable or too small
 */
const extractPrunableItems = (state: unknown): Array<Record<string, unknown>> | undefined => {
  const rec = state as Record<string, unknown> | undefined;
  const items = Array.isArray(rec?._generatedItems)
    ? (rec._generatedItems as Array<Record<string, unknown>>)
    : undefined;
  return items && items.length > STATE_PRUNING_KEEP_TAIL_ITEMS ? items : undefined;
};

/**
 * Prunes the Runner's in-memory `_generatedItems` to keep context within bounds.
 *
 * @param state - RunState from `streamedRun.state`
 * @param lastObservedInputTokens - Input token count from latest response
 * @param fileChangeStatus - Map of file paths to change status
 * @returns Number of items pruned, or 0 if skipped
 */
const pruneStateIfNeeded = (
  state: unknown,
  lastObservedInputTokens: number,
  fileChangeStatus: Map<string, string>
): number => {
  if (lastObservedInputTokens < STATE_PRUNING_TOKEN_CEILING) return 0;
  const items = extractPrunableItems(state);
  if (!items) return 0;
  const cutIndex = findSafePruneIndex(items, items.length - STATE_PRUNING_KEEP_TAIL_ITEMS);
  if (cutIndex <= 0) return 0;
  const summary = buildPruneSummary(cutIndex, fileChangeStatus);
  items.splice(0, cutIndex, { rawItem: { role: 'user', content: summary }, type: 'message' });
  return cutIndex;
};

/**
 * Truncates command output to the last N lines.
 *
 * @param output - Raw command output
 * @param maxLines - Maximum lines to keep
 * @returns Truncated output string
 */
const truncateOutput = (output: string, maxLines: number): string => {
  const lines = output.split('\n');
  if (lines.length <= maxLines) return output;
  const kept = lines.slice(-maxLines);
  return `[... ${lines.length - maxLines} lines truncated — showing last ${maxLines} lines ...]\n${kept.join('\n')}`;
};

/**
 * Deduplicates workspace roots by composite key.
 *
 * @param roots - Array of roots, possibly with duplicates
 * @returns Deduplicated array
 */
const deduplicateRoots = (roots: WorkspaceRoot[]): WorkspaceRoot[] => {
  const unique: WorkspaceRoot[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const key = `${root.name}:${root.root}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(root);
  }
  return unique;
};

/**
 * Builds workspace roots from the primary repo and additional dirs.
 *
 * @param repoDir - Primary repository directory
 * @param additionalRepoDirs - Additional read-only directories
 * @returns Deduplicated workspace roots
 */
const toWorkspaceRoots = (repoDir: string, additionalRepoDirs: string[]): WorkspaceRoot[] => {
  const roots = [
    { name: path.basename(path.resolve(repoDir)), root: path.resolve(repoDir) },
    ...additionalRepoDirs.map(dir => ({
      name: path.basename(path.resolve(dir)),
      root: path.resolve(dir),
    })),
  ];
  return deduplicateRoots(roots);
};

const isWithinRoot = (absolutePath: string, root: string): boolean => {
  const rel = path.relative(root, absolutePath);
  return rel.length > 0 && !rel.startsWith('..');
};

/**
 * Tries to match a path's prefix against a known workspace root.
 *
 * @param segments - Path segments from the input
 * @param roots - Available workspace roots
 * @returns Resolved absolute path if matched, undefined otherwise
 */
const matchRootPrefix = (segments: string[], roots: WorkspaceRoot[]): string | undefined => {
  const [prefix, ...rest] = segments;
  const matched = roots.find(r => r.name === prefix);
  return matched && rest.length > 0 ? path.resolve(matched.root, rest.join(path.sep)) : undefined;
};

/**
 * Resolves a potentially repo-prefixed path to absolute.
 *
 * @param requestedPath - Raw path from tool input
 * @param roots - Available workspace roots
 * @param defaultRoot - Fallback root
 * @returns Resolved absolute path
 */
const resolveRepoPrefixedPath = (requestedPath: string, roots: WorkspaceRoot[], defaultRoot: string): string => {
  const trimmed = requestedPath.trim();
  if (!trimmed) throw new Error('File path is required.');
  if (path.isAbsolute(trimmed)) return path.resolve(trimmed);
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  return matchRootPrefix(segments, roots) ?? path.resolve(defaultRoot, trimmed);
};

/**
 * Resolves a path and validates it's within allowed read roots.
 *
 * @param requestedPath - Raw path from tool input
 * @param ctx - Implementer context
 * @returns Resolved absolute path
 */
const resolveReadablePath = (requestedPath: string, ctx: OpenAiImplementerContext): string => {
  const abs = resolveRepoPrefixedPath(requestedPath, ctx.readRoots, ctx.repoDir);
  if (!ctx.readRoots.some(r => isWithinRoot(abs, r.root))) {
    throw new Error(`Read path is outside the allowed workspace roots: ${requestedPath}`);
  }
  return abs;
};

/**
 * Resolves a path and validates it's within the primary repository.
 *
 * @param requestedPath - Raw path from tool input
 * @param ctx - Implementer context
 * @returns Resolved absolute path
 */
const resolveWritablePath = (requestedPath: string, ctx: OpenAiImplementerContext): string => {
  const abs = resolveRepoPrefixedPath(requestedPath, ctx.readRoots, ctx.repoDir);
  const primaryRoot = ctx.readRoots[0]?.root ?? ctx.repoDir;
  if (!isWithinRoot(abs, primaryRoot) && abs !== primaryRoot) {
    throw new Error(`Write path is outside the primary repository: ${requestedPath}`);
  }
  return abs;
};

/**
 * Extracts and validates the tool context from a run context.
 *
 * @param runContext - OpenAI agent run context
 * @returns Validated implementer context
 */
const getToolContext = (runContext: RunContext<unknown> | undefined): OpenAiImplementerContext => {
  const ctx = runContext?.context as OpenAiImplementerContext | undefined;
  if (!ctx) throw new Error('OpenAI agent tool context is missing.');
  return ctx;
};

/**
 * Parses usage fields from a response_done response object.
 *
 * @param response - Response object from a response_done event
 * @returns Usage summary, or null if absent
 */
const parseResponseUsage = (response: unknown): OpenAiUsageSummary | null => {
  const usage = (response as Record<string, unknown> | null)?.usage as RawResponseUsage | undefined;
  if (!usage) return null;
  const cached = usage.inputTokensDetails?.cachedTokens ?? usage.inputTokensDetails?.cached_tokens ?? 0;
  const compacted = usage.requestUsageEntries?.some(e => e.endpoint === 'responses.compact') ?? false;
  return {
    inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0, cachedInputTokens: cached, compacted,
  };
};

/**
 * Checks whether an event is a response_done raw_model_stream_event.
 *
 * @param event - A stream event from the OpenAI agent SDK
 * @returns Response object if matched, null otherwise
 */
const extractResponseDone = (event: unknown): Record<string, unknown> | null => {
  if (!event || typeof event !== 'object' || !('type' in event)) return null;
  if ((event as { type?: string }).type !== 'raw_model_stream_event') return null;
  const raw = event as { data?: { type?: string; response?: unknown } };
  return raw.data?.type === 'response_done' ? (raw.data.response ?? null) as Record<string, unknown> | null : null;
};

/**
 * Extracts token usage from a raw_model_stream_event with data.type === 'response_done'.
 *
 * @param event - A stream event from the OpenAI agent SDK
 * @returns Usage summary or null
 */
export const extractUsageFromEvent = (event: unknown): OpenAiUsageSummary | null => {
  const response = extractResponseDone(event);
  return response ? parseResponseUsage(response) : null;
};

/**
 * Classifies an HTTP status code error.
 *
 * @param status - HTTP status code
 * @param error - The original error
 * @returns Classification or null
 */
const classifyByStatus = (
  status: number | undefined,
  error: unknown
): AgentClassification | null => {
  if (status === 429) {
    return { label: 'Rate limited', detail: error instanceof Error ? error.message : 'Too many requests (429)', recoverable: true };
  }
  if (status === 401 || status === 403) {
    return { label: 'Authentication error', detail: error instanceof Error ? error.message : `Authentication failed (${status})`, recoverable: false };
  }
  return null;
};

/**
 * Classifies an HTTP status error from an error object.
 *
 * @param error - An error object potentially with a status property
 * @returns Classification or null
 */
const classifyHttpStatusError = (error: unknown): AgentClassification | null => {
  if (!error || typeof error !== 'object' || !('status' in error)) return null;
  return classifyByStatus((error as { status?: number }).status, error);
};

/**
 * Classifies an SDK-specific error by instance type.
 *
 * @param error - The error thrown during an agent run
 * @returns Classification or null
 */
const classifySdkError = (error: unknown): AgentClassification | null => {
  if (error instanceof MaxTurnsExceededError) return { label: 'Max turns exceeded', detail: error.message, recoverable: false };
  if (error instanceof ToolTimeoutError) return { label: 'Tool timeout', detail: error.message, recoverable: true };
  if (error instanceof ToolCallError) return { label: 'Tool call error', detail: error.message, recoverable: true };
  if (error instanceof ModelBehaviorError) return { label: 'Model behavior error', detail: error.message, recoverable: false };
  if (error instanceof UserError) return { label: 'User error', detail: error.message, recoverable: false };
  if (error instanceof SystemError) return { label: 'System error', detail: error.message, recoverable: false };
  return null;
};

/**
 * Classifies an error from the OpenAI agent SDK into a structured label.
 *
 * @param error - The error thrown during an agent run
 * @returns Structured classification
 */
export const classifyAgentError = (error: unknown): AgentClassification => {
  const sdk = classifySdkError(error);
  if (sdk) return sdk;
  const http = classifyHttpStatusError(error);
  if (http) return http;
  if (error instanceof Error && /rate limit/i.test(error.message)) {
    return { label: 'Rate limited', detail: error.message, recoverable: true };
  }
  return { label: 'Unknown error', detail: error instanceof Error ? error.message : 'unknown error', recoverable: false };
};

/**
 * Extracts the retry delay from a rate-limit error message.
 *
 * @param error - The rate-limit error
 * @returns Delay in milliseconds
 */
export const parseRetryDelayMs = (error: unknown): number => {
  const DEFAULT_DELAY_MS = 30_000;
  if (!(error instanceof Error)) return DEFAULT_DELAY_MS;
  const match = new RegExp(/try again in (\d+(?:\.\d+)?)\s*(ms|s|seconds?)?/i).exec(error.message);
  if (!match) return DEFAULT_DELAY_MS;
  const value = Number.parseFloat(match[1]);
  if (Number.isNaN(value) || value <= 0) return DEFAULT_DELAY_MS;
  const unit = (match[2] ?? 's').toLowerCase();
  return unit === 'ms' ? Math.ceil(value) : Math.ceil(value * 1000);
};

type OpenAiModelPricing = { inputPerMToken: number; cachedInputPerMToken: number; outputPerMToken: number };

const OPENAI_PRICING: Record<string, OpenAiModelPricing> = {
  'gpt-4.1': { inputPerMToken: 2, cachedInputPerMToken: 0.5, outputPerMToken: 8 },
  'gpt-4.1-mini': { inputPerMToken: 0.4, cachedInputPerMToken: 0.1, outputPerMToken: 1.6 },
  'gpt-4.1-nano': { inputPerMToken: 0.1, cachedInputPerMToken: 0.025, outputPerMToken: 0.4 },
  'o4-mini': { inputPerMToken: 1.1, cachedInputPerMToken: 0.275, outputPerMToken: 4.4 },
  'gpt-4o': { inputPerMToken: 2.5, cachedInputPerMToken: 1.25, outputPerMToken: 10 },
  'gpt-4o-mini': { inputPerMToken: 0.15, cachedInputPerMToken: 0.075, outputPerMToken: 0.6 },
  'gpt-5-mini': { inputPerMToken: 1, cachedInputPerMToken: 0.25, outputPerMToken: 4 },
  'gpt-5.1-codex-mini': { inputPerMToken: 0.5, cachedInputPerMToken: 0.125, outputPerMToken: 2 },
};

/**
 * Estimates the USD cost of an OpenAI API run.
 *
 * @param model - OpenAI model identifier
 * @param inputTokens - Total input tokens
 * @param outputTokens - Total output tokens
 * @param cachedInputTokens - Cached input tokens
 * @returns Estimated cost in USD, or null
 */
export const estimateOpenAiCostUsd = (
  model: string, inputTokens: number, outputTokens: number, cachedInputTokens: number
): number | null => {
  const pricing = OPENAI_PRICING[model];
  if (!pricing) return null;
  const uncached = inputTokens - cachedInputTokens;
  return (uncached / 1_000_000) * pricing.inputPerMToken
    + (cachedInputTokens / 1_000_000) * pricing.cachedInputPerMToken
    + (outputTokens / 1_000_000) * pricing.outputPerMToken;
};

/**
 * Checks a class declaration for duplicate constructor bodies.
 *
 * @param node - TypeScript AST node
 * @param ts - TypeScript module reference
 * @returns Error message or null
 */
const checkDuplicateConstructor = (
  node: import('typescript').Node,
  ts: typeof import('typescript')
): string | null => {
  if (!ts.isClassDeclaration(node)) return null;
  const name = node.name?.text ?? '<anonymous>';
  const ctors = node.members.filter(m => ts.isConstructorDeclaration(m) && m.body !== undefined);
  return ctors.length > 1
    ? `Class "${name}" has ${ctors.length} constructor declarations with bodies — merge parameters into a single constructor`
    : null;
};

/**
 * Checks an import declaration for duplicate named bindings.
 *
 * @param node - TypeScript AST node
 * @param ts - TypeScript module reference
 * @returns Error message or null
 */
const checkDuplicateImport = (
  node: import('typescript').Node,
  ts: typeof import('typescript')
): string | null => {
  if (!ts.isImportDeclaration(node) || !node.importClause?.namedBindings) return null;
  if (!ts.isNamedImports(node.importClause.namedBindings)) return null;
  const seen = new Map<string, string>();
  const mod = (node.moduleSpecifier as { text?: string }).text ?? '';
  for (const el of node.importClause.namedBindings.elements) {
    const key = `${el.name.text}::${mod}`;
    if (seen.has(key)) return `Duplicate import "${el.name.text}" from "${mod}"`;
    seen.set(key, el.name.text);
  }
  return null;
};

/**
 * Recursively visits AST nodes checking for structural issues.
 *
 * @param node - Current AST node
 * @param ts - TypeScript module reference
 * @returns Error message or null
 */
const visitTsNode = (
  node: import('typescript').Node,
  ts: typeof import('typescript')
): string | null =>
  checkDuplicateConstructor(node, ts)
  ?? checkDuplicateImport(node, ts)
  ?? ts.forEachChild(node, child => visitTsNode(child, ts))
  ?? null;

/**
 * Validates a TypeScript file's content for structural correctness after an edit.
 *
 * @param filePath - File path for filtering and diagnostics
 * @param content - Full file content after proposed edit
 * @returns Error message string if invalid, or null
 */
export const validateTypeScriptEdit = (filePath: string, content: string): string | null => {
  if (!/\.tsx?$/.test(filePath)) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ts = require('typescript') as typeof import('typescript');
  const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const diag = (sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
  if (diag && diag.length > 0) {
    return `syntax error in ${filePath}: ${(diag[0] as { messageText?: string }).messageText ?? 'parse error'}`;
  }
  return visitTsNode(sf, ts);
};

const AVAILABLE_TOOLS_BLOCK = `Available tools:
- read_file(path, offset?, limit?): read a file with optional line range (default: first ${MAX_READ_LINES} lines)
- write_file(path, content): write a full file into the primary repository only
- edit_file(path, old_string, new_string): surgically replace a unique string in a file
- delete_file(path): delete a file from the primary repository only
- search_files(pattern, path?, file_glob?, max_results?): search file contents by regex
- find_files(pattern, path?, max_results?): find files by glob pattern
- verify_command(command): run a verification command only if it is on the whitelist`;

const implementerRulesSection = buildImplementerRulesSection({
  read: 'read_file', write: 'write_file', edit: 'edit_file',
  search: 'search_files', glob: 'find_files', verify: 'verify_command',
})
+ '\n- Use delete_file only when a file should be removed.';

const SUMMARY_TEMPLATE = `### What I changed
<Bullet list of actual edits made. If nothing was changed, write: "No file content changes were required.">

### Verification run
<Bullet list of commands run with ✅ (pass) or ✖ (fail). Omit if no commands ran.>

### Files
- **Updated:** <comma-separated list or "none">
- **New:** <comma-separated list or "none">
- **Deleted:** <comma-separated list or "none">

### Assumptions / risk note
<Any assumptions made or risks identified. Write "None." if there are none.>`;

/**
 * Builds the risks and guardrails section.
 *
 * @param planRisks - Risk notes from the plan artifact
 * @returns Formatted risks text
 */
const buildRisksBlock = (planRisks?: string[]): string => {
  const items = planRisks && planRisks.length > 0
    ? planRisks.map((r, i) => `  ${i + 1}. ${r}`).join('\n')
    : '  (none identified)';
  return `Risks and guardrails:\n${items}`;
};

/**
 * Assembles scope-specific rules for a given repo directory.
 *
 * @param repoDir - Primary repository directory
 * @returns Combined rules text
 */
const buildScopedRules = (repoDir: string): string => [
  implementerRulesSection,
  `- Writes must stay scoped to the primary repository (${repoDir}).`,
  `- Reads may target ${repoDir} and any configured read-only sibling repositories.`,
].join('\n');

type SystemPromptParams = {
  ticketKey: string;
  repoDir: string;
  repoName: string;
  repoFiles: string[];
  contextFiles?: string[];
  trackedFilePaths: string[];
  verificationScripts: VerificationScript[];
  planSteps: string[];
  planSummary?: string;
  planRisks?: string[];
  planAction?: 'fix' | 'feature' | 'investigate';
  skillNames?: string[];
};

/**
 * Builds the plan context portion of the system prompt.
 *
 * @param p - System prompt params
 * @returns Plan context string
 */
const buildPlanSection = (p: SystemPromptParams): string =>
  buildPlanContext({
    ticketKey: p.ticketKey, repoDir: p.repoDir, repoName: p.repoName,
    repoFiles: p.repoFiles, contextFiles: p.contextFiles,
    trackedFilePaths: p.trackedFilePaths, verificationScripts: p.verificationScripts,
    planSteps: p.planSteps, planSummary: p.planSummary,
    planRisks: p.planRisks, planAction: p.planAction,
    skillNames: p.skillNames,
  });

/**
 * Builds the complete system prompt for the OpenAI agent.
 *
 * @param p - Ticket, plan, repo, and verification context
 * @returns Complete system prompt string
 */
const buildSystemPrompt = (p: SystemPromptParams): string => {
  const plan = buildPlanSection(p);
  const rules = buildScopedRules(p.repoDir);
  const risks = buildRisksBlock(p.planRisks);
  return `${plan}\n\n${AVAILABLE_TOOLS_BLOCK}\n\n${rules}\n\n${SUMMARY_TEMPLATE}\n\n${risks}`;
};

/**
 * Accumulates raw token counts into a running summary.
 *
 * @param usage - Single-response usage data
 * @param summary - Running accumulator
 */
const addTokenCounts = (usage: OpenAiUsageSummary, summary: OpenAiUsageSummary): void => {
  summary.inputTokens += usage.inputTokens;
  summary.outputTokens += usage.outputTokens;
  summary.totalTokens += usage.totalTokens;
  summary.cachedInputTokens += usage.cachedInputTokens;
  if (usage.compacted) summary.compacted = true;
};

/**
 * Accumulate token usage, handle compaction, and trigger state pruning.
 *
 * @param params - Usage event, summary accumulator, run state, and file status
 * @returns Updated lastObservedInputTokens value
 */
type AccumulateUsageParams = {
  usage: OpenAiUsageSummary;
  summary: OpenAiUsageSummary;
  runState: unknown;
  lastObservedInputTokens: number;
  fileChangeStatus: Map<string, string>;
};

const accumulateUsage = (p: AccumulateUsageParams): number => {
  addTokenCounts(p.usage, p.summary);
  let observed = p.usage.compacted ? 0 : p.usage.inputTokens;
  const pruned = pruneStateIfNeeded(p.runState, observed, p.fileChangeStatus);
  if (pruned > 0) {
    console.log(chalk.yellow(`  [openai-agent] State pruned: removed ${pruned} items (input was ${observed} tokens)`));
    observed = 0;
  }
  return observed;
};

/**
 * Formats a response_done event into a progress message.
 *
 * @param event - The stream event
 * @returns Formatted message or null
 */
const formatRawModelEvent = (event: unknown): { message: string; isWarning?: boolean } | null => {
  const usage = extractUsageFromEvent(event);
  if (usage?.compacted) return { message: '  [openai-agent] Context compacted', isWarning: true };
  if (usage && usage.totalTokens > 0) {
    return { message: `  [openai-agent] Response: ${usage.inputTokens} in / ${usage.outputTokens} out tokens` };
  }
  return null;
};

/**
 * Formats a run_item_stream_event by event name.
 *
 * @param name - Event name field
 * @param item - Item payload
 * @returns Formatted message or null
 */
const formatRunItemByName = (
  name: string | undefined,
  item: { name?: string } | undefined
): { message: string } | null => {
  switch (name) {
    case 'message_output_created': return { message: '  [openai-agent] Message output started' };
    case 'handoff_requested': return { message: '  [openai-agent] Handoff requested' };
    case 'handoff_occurred': return { message: '  [openai-agent] Handoff occurred' };
    case 'tool_search_called': return { message: '  [openai-agent] Tool search called' };
    case 'tool_search_output_created': return { message: '  [openai-agent] Tool search completed' };
    case 'tool_approval_requested':
      return { message: `  [openai-agent] Tool approval requested: ${item?.name ?? 'unknown'}` };
    default: return null;
  }
};

/**
 * Extracts reasoning text from an item's content arrays.
 *
 * @param item - Run item with content and rawItem
 * @returns Extracted text or empty string
 */
const extractReasoningText = (item: RunItemShape): string =>
  item.content?.map(p => p.text).filter(Boolean).join(' ')
  || item.rawItem?.content?.map(p => p.text).filter(Boolean).join(' ')
  || '';

/**
 * Formats a run_item_stream_event by item type.
 *
 * @param item - Run item payload
 * @returns Formatted message or null
 */
const formatRunItemByType = (item: RunItemShape): { message: string } | null => {
  if (item.type === 'function_call') return { message: `  [openai-agent] Tool requested: ${item.name ?? 'unknown'}` };
  if (item.type === 'function_call_result') return { message: `  [openai-agent] Tool completed: ${item.name ?? 'unknown'}` };
  if (item.type !== 'reasoning') return null;
  const text = extractReasoningText(item);
  return { message: text ? `  [openai-agent] Reasoning: ${text.trim().slice(0, 160)}` : '  [openai-agent] Reasoning updated' };
};

/**
 * Dispatches a run_item_stream_event to name or type formatters.
 *
 * @param eventName - Event name field
 * @param item - Run item payload
 * @returns Formatted message or null
 */
const formatRunItemEvent = (
  eventName: string | undefined,
  item: RunItemShape | undefined
): { message: string; isWarning?: boolean } | null => {
  const byName = formatRunItemByName(eventName, item);
  if (byName) return byName;
  return item?.type ? formatRunItemByType(item) : null;
};

/**
 * Formats an OpenAI agent stream event into a progress message.
 *
 * @param event - A stream event from the OpenAI agent SDK
 * @returns Formatted message or null
 */
export const formatProgressMessage = (event: unknown): { message: string; isWarning?: boolean } | null => {
  if (!event || typeof event !== 'object' || !('type' in event)) return null;
  const eventType = (event as { type?: string }).type;
  if (eventType === 'raw_model_stream_event') {
    const raw = event as { data?: { type?: string } };
    return raw.data?.type === 'response_done' ? formatRawModelEvent(event) : null;
  }
  if (eventType === 'agent_updated_stream_event') {
    const agentEvt = event as { agent?: { name?: string } };
    return { message: `  [openai-agent] Agent updated: ${agentEvt.agent?.name ?? 'unknown'}` };
  }
  if (eventType !== 'run_item_stream_event') return null;
  const re = event as { name?: string; item?: RunItemShape };
  return formatRunItemEvent(re.name, re.item);
};

/**
 * Formats a summary section with title and file paths.
 *
 * @param title - Section title
 * @param filePaths - List of file paths
 * @param label - Label prefix for each path
 * @returns Formatted lines
 */
const formatSummarySection = (title: string, filePaths: string[], label: string): string[] => {
  if (filePaths.length === 0) return [];
  return [`  ${title}:`, ...filePaths.map(fp => `    - ${label}: ${fp}`)];
};

/**
 * Builds a JSON result for a read_file operation.
 *
 * @param rel - Repo-relative file path
 * @param allLines - All lines in the file
 * @param offset - Starting line offset
 * @param limit - Maximum lines to return
 * @returns JSON string
 */
const buildReadFileResult = (rel: string, allLines: string[], offset: number, limit: number): string => {
  const total = allLines.length;
  const selected = allLines.slice(offset, offset + limit);
  const truncated = total > offset + limit;
  const numbered = selected.map((line, i) => `${offset + i + 1}: ${line}`).join('\n');
  return JSON.stringify({
    path: rel, totalLines: total, offset, linesReturned: selected.length,
    truncated, content: numbered,
    ...(truncated && { hint: `File has ${total} lines. Use offset=${offset + limit} to read the next section.` }),
  });
};

/**
 * Executes the read_file tool.
 *
 * @param input - Tool input
 * @param runContext - OpenAI agent run context
 * @returns JSON string with file content
 */
const executeReadFile = async (
  input: { path: string; offset: number; limit: number },
  runContext: RunContext<unknown> | undefined
): Promise<string> => {
  const ctx = getToolContext(runContext);
  const abs = resolveReadablePath(input.path, ctx);
  const content = await fs.readFile(abs, 'utf-8');
  const offset = Math.max(input.offset, 0);
  const limit = input.limit > 0 ? input.limit : MAX_READ_LINES;
  return buildReadFileResult(path.relative(ctx.repoDir, abs), content.split('\n'), offset, limit);
};

/**
 * Checks if a file exists.
 *
 * @param filePath - Absolute file path
 * @returns True if the file exists
 */
const fileExists = (filePath: string): Promise<boolean> =>
  fs.access(filePath).then(() => true).catch(() => false);

/**
 * Records a file mutation in shared mutable state and logs it.
 *
 * @param rel - Repo-relative file path
 * @param status - Change status
 * @param mutable - Shared mutable state
 */
const recordFileChange = (
  rel: string,
  status: 'created' | 'updated' | 'deleted',
  mutable: ToolMutableState
): void => {
  mutable.fileChangeStatus.set(rel, status);
  mutable.changedFilesSinceLastVerification.add(rel);
  console.log(chalk.cyan(`  [openai-agent] File ${status}: ${rel}`));
};

/**
 * Executes the write_file tool.
 *
 * @param input - Tool input
 * @param runContext - OpenAI agent run context
 * @param mutable - Shared mutable state
 * @returns JSON string
 */
const executeWriteFile = async (
  input: { path: string; content: string },
  runContext: RunContext<unknown> | undefined,
  mutable: ToolMutableState
): Promise<string> => {
  const ctx = getToolContext(runContext);
  const abs = resolveWritablePath(input.path, ctx);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const existed = await fileExists(abs);
  await fs.writeFile(abs, input.content, 'utf-8');
  const rel = path.relative(ctx.repoDir, abs);
  const status = existed ? 'updated' : 'created';
  recordFileChange(rel, status, mutable);
  return JSON.stringify({ path: rel, status });
};

/**
 * Executes the delete_file tool.
 *
 * @returns JSON string
 * @param repoDir
 * @param abs
 */
const buildMissingFileResult = (repoDir: string, abs: string): string =>
  JSON.stringify({ path: path.relative(repoDir, abs), status: 'missing', message: 'File does not exist.' }, null, 2);

const executeDeleteFile = async (
  input: { path: string }, runContext: RunContext<unknown> | undefined, mutable: ToolMutableState
): Promise<string> => {
  const ctx = getToolContext(runContext);
  const abs = resolveWritablePath(input.path, ctx);
  if (!(await fileExists(abs))) return buildMissingFileResult(ctx.repoDir, abs);
  await fs.unlink(abs);
  const rel = path.relative(ctx.repoDir, abs);
  recordFileChange(rel, 'deleted', mutable);
  return JSON.stringify({ path: rel, status: 'deleted' });
};

/**
 * Builds a verification snapshot and progress signal.
 *
 * @param command - Verification command
 * @param idx - Order index
 * @param exitCode - Process exit code
 * @param stdout - Standard output
 * @param stderr - Standard error
 * @param vs - Mutable verification state
 * @returns Progress signal object
 */
/**
 * Creates a verification snapshot record.
 *
 * @param command - Verification command
 * @param idx - Order index
 * @param exitCode - Process exit code
 * @param stdout - Standard output
 * @param stderr - Standard error
 * @returns Snapshot record
 */
const createVerificationSnapshot = (
  command: string, idx: number, exitCode: number, stdout: string, stderr: string
): ImplementProgressVerificationSnapshot => ({
  command, commandIndex: idx, exitCode,
  diagnosticLineCount: countDiagnosticLines(stdout, stderr),
  errorClasses: extractVerificationErrorClasses(stdout, stderr),
});

const buildSnapshot = (
  command: string, idx: number, exitCode: number, stdout: string, stderr: string, vs: VerifyCommandState
): unknown => {
  const snap = createVerificationSnapshot(command, idx, exitCode, stdout, stderr);
  const progress = buildVerificationProgressSignal({
    currentSnapshot: snap, previousSnapshot: vs.previousSnapshot,
    changedFilesSinceLastVerification: [...vs.changedFiles],
  });
  vs.previousSnapshot = snap;
  vs.changedFiles.clear();
  return progress;
};

/**
 * Builds a denial response for a disallowed verification command.
 *
 * @param command - The command string
 * @param allowed - Array of allowed commands
 * @param message - Denial reason
 * @returns JSON string
 */
const buildDenial = (command: string, allowed: string[], message: string): string =>
  JSON.stringify({ command, allowed: false, message, allowedCommands: allowed }, null, 2);

/**
 * Handles a successful verification command.
 *
 * @param command - Command that was run
 * @param idx - Order index
 * @param stdout - Standard output
 * @param stderr - Standard error
 * @param vs - Verification state
 * @returns JSON string
 */
const handleVerifySuccess = (
  command: string, idx: number, stdout: string, stderr: string, vs: VerifyCommandState
): string => {
  const progress = buildSnapshot(command, idx, 0, stdout, stderr, vs);
  console.log(chalk.cyan(`  [openai-agent] Verification passed: ${command}`));
  const script = vs.verificationScripts.find(s => command.includes(s.command) || s.command.includes(command));
  vs.verificationOutcomes.push({ id: script?.id ?? 'unknown', command, policy: script?.policy ?? 'best_effort', status: 'passed' });
  return JSON.stringify({ command, allowed: true, exitCode: 0, progress });
};

/**
 * Handles a failed verification command.
 *
 * @param command - Command that was run
 * @param idx - Order index
 * @param err - The exec error
 * @param vs - Verification state
 * @returns JSON string
 */
const handleVerifyFailure = (command: string, idx: number, err: ExecError, vs: VerifyCommandState): string => {
  const stdout = err.stdout?.trim?.() ?? '';
  const stderr = err.stderr?.trim?.() ?? err.message ?? '';
  const exitCode = err.code ?? 1;
  const progress = buildSnapshot(command, idx, exitCode, stdout, stderr, vs);
  console.log(chalk.red(`  [openai-agent] Verification failed: ${command}`));
  const script = vs.verificationScripts.find(s => command.includes(s.command) || s.command.includes(command));
  vs.verificationOutcomes.push({ id: script?.id ?? 'unknown', command, policy: script?.policy ?? 'best_effort', status: 'failed' });
  return JSON.stringify({
    command, allowed: true, exitCode,
    stdout: truncateOutput(stdout, MAX_VERIFICATION_OUTPUT_LINES),
    stderr: truncateOutput(stderr, MAX_VERIFICATION_OUTPUT_LINES),
    progress,
  });
};

/**
 * Runs a whitelisted verification command.
 *
 * @param command - Normalized command
 * @param ctx - Implementer context
 * @param vs - Verification state
 * @returns JSON string
 */
const runVerificationCommand = async (
  command: string, ctx: OpenAiImplementerContext, vs: VerifyCommandState
): Promise<string> => {
  console.log(chalk.cyan(`  [openai-agent] Verification running: ${command}`));
  const idx = vs.verificationCommandOrder.get(command) ?? -1;
  try {
    const { stdout, stderr } = await execAsync(command, { cwd: ctx.repoDir, maxBuffer: MAX_BUFFER_IN_BYTES });
    return handleVerifySuccess(command, idx, stdout, stderr, vs);
  } catch (error: unknown) {
    return handleVerifyFailure(command, idx, error as ExecError, vs);
  }
};

/**
 * Executes the verify_command tool.
 *
 * @param input - Tool input
 * @param runContext - OpenAI agent run context
 * @param vs - Verification state
 * @returns JSON string
 */
/**
 * Builds a denial message for a command not on the whitelist.
 *
 * @param command - The rejected command
 * @param allowed - List of allowed commands
 * @returns Denial message string
 */
const buildWhitelistDenial = (command: string, allowed: string[]): string => {
  console.log(chalk.red(`  [openai-agent] Verification denied: ${command}`));
  const msg = `Command "${command}" is not in the verification whitelist. Allowed commands: ${allowed.join(', ') || '(none configured)'}.`;
  return buildDenial(command, allowed, msg);
};

const executeVerifyCommand = async (
  input: { command: string }, runContext: RunContext<unknown> | undefined, vs: VerifyCommandState
): Promise<string> => {
  const ctx = getToolContext(runContext);
  const command = normalizeCommand(input.command);
  const allowed = [...ctx.allowedVerificationCommands];
  if (!command) return buildDenial(command, allowed, 'Verification command missing a command string.');
  if (!ctx.allowedVerificationCommands.has(command)) return buildWhitelistDenial(command, allowed);
  return runVerificationCommand(command, ctx, vs);
};

/**
 * Parses a single grep output line into a match object.
 *
 * @param line - Raw grep output line
 * @param repoDir - Repo root for relative path computation
 * @returns Match object
 */
const parseGrepLine = (
  line: string, repoDir: string
): { file: string; line: number; content: string } => {
  const c1 = line.indexOf(':');
  const c2 = line.indexOf(':', c1 + 1);
  if (c1 === -1 || c2 === -1) return { file: line, line: 0, content: '' };
  return {
    file: path.relative(repoDir, line.slice(0, c1)),
    line: Number.parseInt(line.slice(c1 + 1, c2), 10),
    content: line.slice(c2 + 1).slice(0, MAX_GREP_LINE_LENGTH),
  };
};

/**
 * Parses grep output into structured match objects.
 *
 * @param stdout - Raw grep output
 * @param repoDir - Repo root
 * @param max - Max matches
 * @returns Array of match objects
 */
const parseGrepMatches = (
  stdout: string, repoDir: string, max: number
): Array<{ file: string; line: number; content: string }> =>
  stdout.split('\n').filter(Boolean).slice(0, max).map(line => parseGrepLine(line, repoDir));

/**
 * Handles a successful grep execution.
 *
 * @param stdout - Grep stdout
 * @param repoDir - Repo root
 * @param pattern - Search pattern
 * @param max - Max results
 * @returns JSON string
 */
const handleGrepSuccess = (stdout: string, repoDir: string, pattern: string, max: number): string => {
  const matches = parseGrepMatches(stdout, repoDir, max);
  console.log(chalk.cyan(`  [openai-agent] Search: ${matches.length} match(es) for "${pattern}"`));
  return JSON.stringify({ pattern, matches, truncated: matches.length >= max });
};

/**
 * Handles a grep error.
 *
 * @param err - The exec error
 * @param pattern - Search pattern
 * @returns JSON string
 */
const handleGrepError = (err: { code?: number; message?: string }, pattern: string): string => {
  if (err.code === 1) return JSON.stringify({ pattern, matches: [], truncated: false });
  return JSON.stringify({ pattern, matches: [], truncated: false, error: err.message ?? 'Search failed' });
};

/**
 * Executes the search_files tool.
 *
 * @param input - Tool input
 * @param runContext - OpenAI agent run context
 * @returns JSON string
 */
/**
 * Builds the grep command string.
 *
 * @param pattern - Search pattern
 * @param root - Search root directory
 * @param globArg - Optional glob include argument
 * @param max - Max results
 * @returns Shell command string
 */
const buildGrepCommand = (pattern: string, root: string, globArg: string, max: number): string =>
  `grep -rn ${globArg} -m ${max} -E ${shellEscape(pattern)} ${shellEscape(root)}`;

const executeSearchFiles = async (
  input: { pattern: string; path: string; file_glob: string; max_results: number },
  runContext: RunContext<unknown> | undefined
): Promise<string> => {
  const ctx = getToolContext(runContext);
  const root = input.path ? resolveReadablePath(input.path, ctx) : ctx.repoDir;
  const globArg = input.file_glob ? `--include=${shellEscape(input.file_glob)}` : '';
  const cmd = buildGrepCommand(input.pattern, root, globArg, input.max_results);
  try {
    const { stdout } = await execAsync(cmd, { maxBuffer: MAX_BUFFER_IN_BYTES });
    return handleGrepSuccess(stdout, ctx.repoDir, input.pattern, input.max_results);
  } catch (error: unknown) {
    return handleGrepError(error as { code?: number; message?: string }, input.pattern);
  }
};

/**
 * Executes the find_files tool.
 *
 * @param input - Tool input
 * @param runContext - OpenAI agent run context
 * @returns JSON string
 */
const executeFindFiles = async (
  input: { pattern: string; path: string; max_results: number },
  runContext: RunContext<unknown> | undefined
): Promise<string> => {
  const ctx = getToolContext(runContext);
  const root = input.path ? resolveReadablePath(input.path, ctx) : ctx.repoDir;
  const matches = await glob(input.pattern, { cwd: root, nodir: true });
  const truncated = matches.length > input.max_results;
  const files = matches.slice(0, input.max_results);
  console.log(chalk.cyan(`  [openai-agent] Find: ${files.length} file(s) for "${input.pattern}"`));
  return JSON.stringify({ pattern: input.pattern, files, truncated });
};

/**
 * Builds a code context snippet around a specific line.
 *
 * @param content - Full file content
 * @param line - Target line number (1-based)
 * @returns Numbered code snippet
 */
const buildEditContextSnippet = (content: string, line: number): string => {
  const allLines = content.split('\n');
  const start = Math.max(0, line - 6);
  const end = Math.min(allLines.length, line + 15);
  return allLines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n');
};

/**
 * Records a validation failure and returns an error response.
 *
 * @param content - Original file content
 * @param rel - Repo-relative path
 * @param valErr - Validation error message
 * @param line - Line number, if known
 * @param failures - Mutable failures array
 * @returns JSON string error response
 */
const recordValidationFailure = (
  content: string, rel: string, valErr: string, line: number | undefined, failures: ValidationFailure[]
): string => {
  failures.push({ path: rel, error: valErr, line });
  const location = line ? rel + ':' + line : rel;
  console.log(chalk.yellow('  [openai-agent] Edit validation failed: ' + location));
  if (!line) return JSON.stringify({ error: valErr });
  return JSON.stringify({
    error: valErr,
    hint: 'Merge your changes into the existing declaration instead of adding a duplicate. The existing code around the edit site is shown below.',
    existing_code: buildEditContextSnippet(content, line),
  });
};

/**
 * Handles the edit validation failure branch.
 *
 * @param content - Original file content
 * @param oldString - String being replaced
 * @param rel - Repo-relative path
 * @param valErr - Validation error
 * @param failures - Mutable failures array
 * @returns JSON error response
 */
const handleEditValidationError = (
  content: string, oldString: string, rel: string, valErr: string, failures: ValidationFailure[]
): string => {
  const idx = content.indexOf(oldString);
  const line = idx >= 0 ? content.substring(0, idx).split('\n').length : undefined;
  return recordValidationFailure(content, rel, valErr, line, failures);
};

/**
 * Clears stale validation failures for a file.
 *
 * @param failures - Mutable failures array
 * @param rel - Path to clear
 */
const clearStaleFailures = (failures: ValidationFailure[], rel: string): void => {
  for (let i = failures.length - 1; i >= 0; i--) {
    if (failures[i].path === rel) failures.splice(i, 1);
  }
};

/**
 * Checks edit preconditions and returns an error if invalid.
 *
 * @param content - File content
 * @param oldString - String to find
 * @returns Error JSON string or null if preconditions pass
 */
const checkEditPreconditions = (content: string, oldString: string): string | null => {
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) return JSON.stringify({ error: 'old_string not found in file' });
  if (occurrences > 1) {
    return JSON.stringify({ error: `old_string is ambiguous (${occurrences} occurrences); provide more surrounding context` });
  }
  return null;
};

/**
 * Applies a validated edit and records the change.
 *
 * @param abs - Absolute file path
 * @param updated - Updated file content
 * @param rel - Repo-relative path
 * @param mutable - Shared mutable state
 * @returns JSON string with success
 */
const applyValidEdit = async (
  abs: string, updated: string, rel: string, mutable: ToolMutableState
): Promise<string> => {
  await fs.writeFile(abs, updated, 'utf-8');
  recordFileChange(rel, 'updated', mutable);
  clearStaleFailures(mutable.validationFailures, rel);
  return JSON.stringify({ path: rel, status: 'updated' });
};

/**
 * Executes the edit_file tool.
 *
 * @param input - Tool input
 * @param runContext - OpenAI agent run context
 * @param mutable - Shared mutable state
 * @returns JSON string
 */
type EditFileInput = { path: string; old_string: string; new_string: string };

const executeEditFile = async (
  input: EditFileInput, runContext: RunContext<unknown> | undefined, mutable: ToolMutableState
): Promise<string> => {
  const ctx = getToolContext(runContext);
  const abs = resolveWritablePath(input.path, ctx);
  const content = await fs.readFile(abs, 'utf-8');
  const precondErr = checkEditPreconditions(content, input.old_string);
  if (precondErr) return precondErr;
  const updated = content.replace(input.old_string, input.new_string);
  const rel = path.relative(ctx.repoDir, abs);
  const valErr = validateTypeScriptEdit(abs, updated);
  if (valErr) return handleEditValidationError(content, input.old_string, rel, valErr, mutable.validationFailures);
  return applyValidEdit(abs, updated, rel, mutable);
};

/**
 * Creates the read_file tool.
 *
 * @returns Configured tool instance
 */
const createReadFileTool = () => tool({
  name: 'read_file',
  description: 'Read a file from the repository workspace. Use offset/limit to read specific line ranges for large files.',
  parameters: z.object({ path: z.string().min(1), offset: z.number().default(0), limit: z.number().default(0) }),
  execute: executeReadFile,
});

/**
 * Creates the write_file tool.
 *
 * @param m - Shared mutable state
 * @returns Configured tool instance
 */
const createWriteFileTool = (m: ToolMutableState) => tool({
  name: 'write_file',
  description: 'Write a full file into the primary repository workspace.',
  parameters: z.object({ path: z.string().min(1), content: z.string() }),
  execute: (input, ctx) => executeWriteFile(input, ctx, m),
});

/**
 * Creates the delete_file tool.
 *
 * @param m - Shared mutable state
 * @returns Configured tool instance
 */
const createDeleteFileTool = (m: ToolMutableState) => tool({
  name: 'delete_file',
  description: 'Delete a file from the primary repository workspace.',
  parameters: z.object({ path: z.string().min(1) }),
  execute: (input, ctx) => executeDeleteFile(input, ctx, m),
});

/**
 * Creates the verify_command tool.
 *
 * @param vs - Verification state
 * @returns Configured tool instance
 */
const createVerifyCommandTool = (vs: VerifyCommandState) => tool({
  name: 'verify_command',
  description: 'Run an exact verification command only when it appears in the whitelist.',
  parameters: z.object({ command: z.string().min(1) }),
  execute: (input, ctx) => executeVerifyCommand(input, ctx, vs),
});

/**
 * Creates the search_files tool.
 *
 * @returns Configured tool instance
 */
const createSearchFilesTool = () => tool({
  name: 'search_files',
  description: 'Search file contents by regex pattern across the workspace.',
  parameters: z.object({
    pattern: z.string().min(1), path: z.string().default(''),
    file_glob: z.string().default(''), max_results: z.number().default(50),
  }),
  execute: executeSearchFiles,
});

/**
 * Creates the find_files tool.
 *
 * @returns Configured tool instance
 */
const createFindFilesTool = () => tool({
  name: 'find_files',
  description: 'Find files by glob pattern across the workspace.',
  parameters: z.object({ pattern: z.string().min(1), path: z.string().default(''), max_results: z.number().default(200) }),
  execute: executeFindFiles,
});

/**
 * Creates the edit_file tool.
 *
 * @param m - Shared mutable state
 * @returns Configured tool instance
 */
const createEditFileTool = (m: ToolMutableState) => tool({
  name: 'edit_file',
  description: 'Replace a unique string in a file. old_string must appear exactly once.',
  parameters: z.object({ path: z.string().min(1), old_string: z.string().min(1), new_string: z.string() }),
  execute: (input, ctx) => executeEditFile(input, ctx, m),
});

/**
 * Processes events from a streamed run segment.
 *
 * @param run - Active streamed run
 * @param loop - Mutable loop state
 * @returns Number of events processed
 */
/**
 * Processes a single stream event: accumulates usage and logs progress.
 *
 * @param event - Stream event
 * @param run - Active streamed run
 * @param loop - Mutable loop state
 */
const processStreamEvent = (event: unknown, run: OaiStreamedRun, loop: StreamLoopState): void => {
  const usage = extractUsageFromEvent(event);
  if (usage) {
    loop.lastObservedInputTokens = accumulateUsage({
      usage, summary: loop.usageSummary, runState: run.state,
      lastObservedInputTokens: loop.lastObservedInputTokens, fileChangeStatus: loop.fileChangeStatus,
    });
  }
  const fmt = formatProgressMessage(event);
  if (fmt) console.log(fmt.isWarning ? chalk.yellow(fmt.message) : chalk.cyan(fmt.message));
};

const drainStreamEvents = async (run: OaiStreamedRun, loop: StreamLoopState): Promise<void> => {
  loop.eventsInSegment = 0;
  for await (const event of run) {
    loop.eventsInSegment++;
    processStreamEvent(event, run, loop);
  }
};

/**
 * Resumes a streamed run after a rate-limit error.
 *
 * @param error - The rate-limit error
 * @param run - The run that errored
 * @param config - Stream config
 * @returns New streamed run
 */
const resumeAfterRateLimit = async (
  error: unknown,
  run: OaiStreamedRun,
  config: StreamRunConfig
): Promise<OaiStreamedRun> => {
  const delayMs = parseRetryDelayMs(error);
  await new Promise(resolve => setTimeout(resolve, delayMs));
  return config.runner.run(config.agent, run.state, {
    stream: true, context: config.context, maxTurns: config.maxTurns, session: config.compaction,
  });
};

/**
 * Throws a formatted error for non-recoverable agent failures.
 *
 * @param cls - Classified error
 * @param label - Pass label for the message
 */
const throwAgentError = (cls: AgentClassification, label: string): never => {
  console.log(chalk.red(`  [openai-agent] ${label}${cls.label}: ${cls.detail}`));
  throw new Error(`OpenAI agent run failed (${cls.label}): ${cls.detail}`);
};

/**
 * Handles a stream error with rate-limit retry logic.
 *
 * @param error - The error thrown
 * @param current - Current streamed run
 * @param config - Stream config
 * @param loop - Mutable loop state
 * @param label - Pass label
 * @returns Resumed streamed run
 */
/**
 * Validates that the error is a recoverable rate-limit and we haven't exhausted retries.
 *
 * @param cls - Classified error
 * @param loop - Loop state with attempt counter
 * @param label - Pass label
 */
const guardRateLimitRetry = (cls: AgentClassification, loop: StreamLoopState, label: string): void => {
  if (!cls.recoverable || cls.label !== 'Rate limited') throwAgentError(cls, label);
  if (loop.eventsInSegment > 0) loop.consecutiveRateLimitAttempts = 0;
  loop.consecutiveRateLimitAttempts++;
  if (loop.consecutiveRateLimitAttempts > MAX_CONSECUTIVE_RATE_LIMIT_RETRIES) throwAgentError(cls, label);
};

const handleStreamRateLimitError = async (
  error: unknown, current: OaiStreamedRun, config: StreamRunConfig, loop: StreamLoopState, label: string
): Promise<OaiStreamedRun> => {
  guardRateLimitRetry(classifyAgentError(error), loop, label);
  const ms = parseRetryDelayMs(error);
  const retryMsg = `  [openai-agent] ${label}Rate limited — retrying in ${Math.ceil(ms / 1000)}s`
    + ` (attempt ${loop.consecutiveRateLimitAttempts}/${MAX_CONSECUTIVE_RATE_LIMIT_RETRIES})`;
  console.log(chalk.yellow(retryMsg));
  return resumeAfterRateLimit(error, current, config);
};

/**
 * Runs the stream loop with rate-limit retry logic.
 *
 * @param run - Initial streamed run
 * @param config - Runner configuration
 * @param loop - Mutable tracking state
 * @param label - Pass label
 * @returns Final streamed run
 */
const runStreamWithRetry = async (
  run: OaiStreamedRun, config: StreamRunConfig, loop: StreamLoopState, label: string
): Promise<OaiStreamedRun> => {
  let current = run;
  while (true) {
    try {
      await drainStreamEvents(current, loop);
      if (loop.eventsInSegment > 0) loop.consecutiveRateLimitAttempts = 0;
      return current;
    } catch (error) {
      current = await handleStreamRateLimitError(error, current, config, loop, label);
    }
  }
};

/**
 * Checks a completed run for errors and throws if present.
 *
 * @param run - Completed streamed run
 * @param label - Pass label
 */
const throwOnRunError = (
  run: OaiStreamedRun,
  label: string
): void => {
  if (!run.error) return;
  throwAgentError(classifyAgentError(run.error), label);
};

/**
 * Logs token usage and estimated cost.
 *
 * @param summary - Accumulated usage
 * @param model - Model identifier
 */
const logUsageSummary = (summary: OpenAiUsageSummary, model: string): void => {
  if (summary.totalTokens <= 0) return;
  const cached = summary.cachedInputTokens > 0 ? ` (${summary.cachedInputTokens} cached)` : '';
  console.log(chalk.cyan(`  [openai-agent] Usage: ${summary.inputTokens} input${cached} / ${summary.outputTokens} output tokens`));
  const cost = estimateOpenAiCostUsd(model, summary.inputTokens, summary.outputTokens, summary.cachedInputTokens);
  if (cost !== null) console.log(chalk.cyan(`  [openai-agent] Cost: ~$${cost.toFixed(4)} USD`));
};

/**
 * Logs the final agent output summary.
 *
 * @param finalOutput - Agent's final text output
 */
const logFinalOutput = (finalOutput: string): void => {
  if (!finalOutput) return;
  console.log(chalk.bold('\n  Summary:'));
  for (const line of finalOutput.split('\n')) {
    if (line.trim()) console.log(chalk.cyan(`    ${line}`));
  }
};

/**
 * Logs the completion summary after the agent run.
 *
 * @param run - Completed streamed run
 * @param summary - Usage statistics
 * @param model - Model identifier
 */
const logCompletion = (
  run: OaiStreamedRun,
  summary: OpenAiUsageSummary,
  model: string
): void => {
  console.log(chalk.green(`  [openai-agent] Agent completed in ${run.currentTurn} turn(s).`));
  logUsageSummary(summary, model);
  if (summary.compacted) console.log(chalk.cyan('  [openai-agent] Context compaction triggered during run'));
  console.log(chalk.green('\n✓ OpenAI agent implementation complete'));
  logFinalOutput(typeof run.finalOutput === 'string' ? run.finalOutput.trim() : '');
};

/**
 * Computes the current incomplete workload.
 *
 * @param fileChangeStatus - Changed files map
 * @param repoFiles - All planned repo files
 * @param repoName - Repository name
 * @param failures - Validation failures
 * @returns Workload metrics
 */
const computeWorkload = (
  fileChangeStatus: Map<string, string>, repoFiles: string[], repoName: string, failures: ValidationFailure[]
): { total: number; unvisited: string[]; failureCount: number } => {
  const touched = new Set(fileChangeStatus.keys());
  const unvisited = repoFiles.map(f => stripRepoPrefix(f, repoName)).filter(f => !touched.has(f) && !isGlobPattern(f));
  const failureCount = new Set(failures.map(f => `${f.path}:${f.error}`)).size;
  return { total: unvisited.length + failureCount, unvisited, failureCount };
};

/**
 * Deduplicates validation failures by path:error key.
 *
 * @param failures - Array of validation failures
 * @returns Deduplicated failures as formatted lines
 */
const formatUniqueFailures = (failures: ValidationFailure[]): string => {
  const unique = new Map<string, ValidationFailure>();
  for (const f of failures) {
    const key = `${f.path}:${f.error}`;
    if (!unique.has(key)) unique.set(key, f);
  }
  return [...unique.values()].map(f => {
    const location = f.line ? f.path + ':' + f.line : f.path;
    return '- ' + location + ' — ' + f.error;
  }).join('\n');
};

/**
 * Builds the incomplete-work sections for a continuation prompt.
 *
 * @param unvisited - Unvisited files
 * @param failureCount - Unique failure count
 * @param failures - Validation failures
 * @returns Array of section strings
 */
const buildIncompleteWorkSections = (
  unvisited: string[], failureCount: number, failures: ValidationFailure[]
): string[] => {
  const sections: string[] = [];
  if (failureCount > 0) {
    sections.push('Structural edit failures (read each file, then merge changes correctly):\n' + formatUniqueFailures(failures));
  }
  if (unvisited.length > 0) {
    sections.push('Planned files not yet modified:\n' + unvisited.map(f => '- ' + f).join('\n'));
  }
  return sections;
};

/**
 * Builds a continuation prompt.
 *
 * @param unvisited - Unvisited files
 * @param failureCount - Unique failure count
 * @param failures - Validation failures
 * @returns Continuation prompt string
 */
const buildContinuationPrompt = (unvisited: string[], failureCount: number, failures: ValidationFailure[]): string => {
  const sections = buildIncompleteWorkSections(unvisited, failureCount, failures);
  return `Continue implementing the remaining plan steps. The following work is still incomplete:\n\n${sections.join('\n\n')}\n\nFor each file listed above, read the full file first with read_file, then apply edit_file to complete the required changes. After addressing all listed files, search for any remaining migration patterns and continue editing until zero matches remain. Do not output any text or plan before calling your first tool.`;
};

/**
 * Logs a stalled workload warning.
 *
 * @param unvisited - Unvisited files
 * @param failureCount - Failure count
 */
const logStalledWorkload = (unvisited: string[], failureCount: number): void => {
  const parts: string[] = [];
  if (failureCount > 0) parts.push(`${failureCount} unresolved edit validation failure(s)`);
  if (unvisited.length > 0) parts.push(`${unvisited.length} planned file(s) not touched: ${unvisited.join(', ')}`);
  console.log(chalk.yellow('\n  [openai-agent] Workload not decreasing after 2 passes — stopping'));
  console.log(chalk.yellow(`  [openai-agent] Remaining: ${parts.join('; ')}`));
};

/**
 * Appends a user message to the run state.
 *
 * @param state - RunState with _generatedItems
 * @param prompt - Continuation prompt text
 */
const appendContinuationMessage = (state: unknown, prompt: string): void => {
  const s = state as Record<string, unknown> | undefined;
  if (!s?._generatedItems) return;
  (s._generatedItems as Array<Record<string, unknown>>).push({
    rawItem: { role: 'user', content: prompt }, type: 'message',
  });
};

/**
 * Starts a resumed agent run with the continuation state.
 *
 * @param state - Run state or fallback prompt
 * @param prompt - Continuation prompt (fallback)
 * @param config - Stream config
 * @returns New streamed run
 */
const startContinuationRun = async (
  state: unknown,
  prompt: string,
  config: StreamRunConfig
): Promise<OaiStreamedRun> =>
  config.runner.run(
    config.agent,
    (state ?? prompt) as string | RunState<OpenAiImplementerContext, OaiAgent>,
    { stream: true, context: config.context, maxTurns: config.maxTurns, session: config.compaction }
  );

/**
 * Runs a single continuation pass.
 *
 * @param passNumber - Pass number
 * @param currentRun - Current streamed run
 * @param prompt - Continuation prompt
 * @param config - Stream config
 * @param loop - Mutable loop state
 * @returns Updated streamed run
 */
const runContinuationPass = async (
  passNumber: number, currentRun: OaiStreamedRun, prompt: string, config: StreamRunConfig, loop: StreamLoopState
): Promise<OaiStreamedRun> => {
  appendContinuationMessage(currentRun.state, prompt);
  loop.consecutiveRateLimitAttempts = 0;
  let run = await startContinuationRun(currentRun.state, prompt, config);
  const label = `Pass ${passNumber} `;
  run = await runStreamWithRetry(run, config, loop, label);
  throwOnRunError(run, label);
  console.log(chalk.green(`  [openai-agent] Pass ${passNumber + 1} completed in ${run.currentTurn} turn(s).`));
  return run;
};

/**
 * Logs the start of a continuation pass.
 *
 * @param passNumber - Pass number
 * @param unvisited - Unvisited files
 * @param failureCount - Failure count
 */
const logPassStart = (passNumber: number, unvisited: string[], failureCount: number): void => {
  const reasons: string[] = [];
  if (failureCount > 0) reasons.push(`${failureCount} edit validation failure(s)`);
  if (unvisited.length > 0) reasons.push(`${unvisited.length} planned file(s) not touched`);
  console.log(chalk.yellow(`\n  [openai-agent] Pass ${passNumber}: ${reasons.join(', ')} — continuing`));
};

/**
 * Evaluates stall progress and updates counters.
 *
 * @param total - Current workload total
 * @param previous - Previous workload total
 * @param stalled - Current stalled pass count
 * @returns Updated stalled count
 */
const updateStallCounter = (total: number, previous: number, stalled: number): number =>
  total < previous ? 0 : stalled + 1;

type ContinuationLoopParams = {
  run: OaiStreamedRun;
  config: StreamRunConfig;
  loop: StreamLoopState;
  repoFiles: string[];
  repoName: string;
  failures: ValidationFailure[];
};

type ContinuationState = { prev: number; stalled: number; passNum: number; cur: OaiStreamedRun };

/**
 * Evaluates whether the continuation loop should stop.
 *
 * @param wl - Workload metrics
 * @param state - Mutable continuation state
 * @returns True if the loop should break
 */
const shouldStopContinuation = (
  wl: { total: number; unvisited: string[]; failureCount: number }, state: ContinuationState
): boolean => {
  if (wl.total === 0) return true;
  state.stalled = updateStallCounter(wl.total, state.prev, state.stalled);
  state.prev = wl.total;
  if (state.stalled < 2) return false;
  logStalledWorkload(wl.unvisited, wl.failureCount);
  return true;
};

/**
 * Runs the incomplete-work continuation loop.
 *
 * @param p - All state needed for continuation
 */
const runContinuationLoop = async (p: ContinuationLoopParams): Promise<void> => {
  const s: ContinuationState = { prev: Infinity, stalled: 0, passNum: 0, cur: p.run };
  while (true) {
    const wl = computeWorkload(p.loop.fileChangeStatus, p.repoFiles, p.repoName, p.failures);
    if (shouldStopContinuation(wl, s)) break;
    s.passNum++;
    logPassStart(s.passNum, wl.unvisited, wl.failureCount);
    const prompt = buildContinuationPrompt(wl.unvisited, wl.failureCount, p.failures);
    s.cur = await runContinuationPass(s.passNum, s.cur, prompt, p.config, p.loop);
  }
};

/**
 * Collects file paths by status.
 *
 * @param map - File change status map
 * @param status - Desired status
 * @returns Sorted list of paths
 */
const collectSummaryPaths = (map: Map<string, string>, status: string): string[] =>
  [...map.entries()].filter(([, s]) => s === status).map(([p]) => p).sort((a, b) => a.localeCompare(b));

/**
 * Logs the file change summary.
 *
 * @param status - File change status map
 * @param scripts - Verification scripts
 * @param allowed - Allowed verification commands
 */
/**
 * Builds all file summary lines from the change status map.
 *
 * @param status - File change status map
 * @returns Array of formatted summary lines
 */
const buildFileSummaryLines = (status: Map<string, string>): string[] => [
  ...formatSummarySection('New files', collectSummaryPaths(status, 'created'), 'created'),
  ...formatSummarySection('Updated files', collectSummaryPaths(status, 'updated'), 'updated'),
  ...formatSummarySection('Deleted files', collectSummaryPaths(status, 'deleted'), 'deleted'),
];

const logFileSummary = (status: Map<string, string>, scripts: VerificationScript[], allowed: Set<string>): void => {
  const lines = buildFileSummaryLines(status);
  if (lines.length > 0) {
    console.log(chalk.bold('\n  File summary:'));
    for (const l of lines) console.log(chalk.cyan(l));
  } else {
    console.log(chalk.gray('\n  File summary: no file changes were made.'));
  }
  if (scripts.length > 0) {
    console.log(chalk.gray(`  Verification whitelist respected: ${[...allowed].join(', ') || '(none)'}`));
  }
};

/**
 * Builds the prior-stage preamble if available.
 *
 * @param summary - Prior stage summary, or undefined
 * @returns Preamble string or empty string
 */
const buildPriorStagePreamble = (summary?: string): string =>
  summary
    ? `<prior-stage-context>\n${summary}\n</prior-stage-context>\n\nNote: The above is background context from a previous workflow stage.\nYour current stage's instructions take precedence over any conflicting details above.\n\n`
    : '';

/**
 * Builds the initial user prompt.
 *
 * @param contextMd - Optional OPENAI.md content
 * @param ticketKey - Ticket identifier
 * @param stepCount - Number of plan steps
 * @returns Prompt string
 */
const buildInitialPrompt = (contextMd: string | null, ticketKey: string, stepCount: number): string =>
  [
    contextMd ? contextMd.trimEnd() : '',
    `Ticket key: ${ticketKey}`,
    `Implement ALL ${stepCount} plan steps completely. Do not output any text at any point — every response must be a tool call. Start editing files immediately after minimal exploration. After ALL edits are complete, run each command listed under "Verification commands:" exactly as written, in order. Do not modify or pipe the commands. Output text only as the final summary after all work is done.`,
  ].filter(Boolean).join('\n\n');

/**
 * Determines the compaction item threshold based on plan size.
 *
 * @param stepCount - Number of plan steps
 * @returns Compaction threshold
 */
const resolveCompactionThreshold = (stepCount: number): number => {
  if (stepCount <= 5) return 10;
  if (stepCount <= 10) return 20;
  return 30;
};

/**
 * Builds a system prompt from GenerateAndVerifyParams.
 *
 * @param p - Core params
 * @param repoDir - Primary repo directory
 * @returns System prompt string
 */
const buildSystemPromptFromParams = (p: GenerateAndVerifyParams, repoDir: string): string =>
  buildSystemPrompt({
    ticketKey: p.ticket.ticketKey, repoDir, repoName: p.repoName,
    repoFiles: p.repoFiles, contextFiles: p.contextFiles,
    trackedFilePaths: p.trackedFilePaths, verificationScripts: p.verificationScripts,
    planSteps: p.planArtifact.plan.steps,
    planSummary: p.planArtifact.plan.summary, planRisks: p.planArtifact.plan.risks,
    planAction: p.planArtifact.plan.action,
    skillNames: p.skillNames,
  });

/**
 * Creates all seven agent tools.
 *
 * @param mutable - Shared mutable state
 * @param vs - Verification state
 * @returns Array of tool instances
 */
const createAllTools = (mutable: ToolMutableState, vs: VerifyCommandState) => [
  createReadFileTool(), createWriteFileTool(mutable), createEditFileTool(mutable),
  createDeleteFileTool(mutable), createSearchFilesTool(), createFindFilesTool(),
  createVerifyCommandTool(vs),
];

/**
 * Resolves model routing configuration.
 *
 * @param configService - NestJS config service
 * @param modelRouting - Routing override
 * @param plan
 * @returns Resolved model name and log message
 */
const resolveModel = (
  configService: ConfigService, modelRouting: string | undefined, plan?: ResolutionPlan
): { model: string; logMessage: string } => {
  const fallback = configService.get<string>('ai.model') || DEFAULT_MODEL;
  const fallbackPlan: ResolutionPlan = plan ?? {
    action: 'feature', summary: '', steps: [], estimatedComplexity: 'medium',
  };
  const result = resolveModelRouting({
    routing: (modelRouting ?? 'auto') as 'auto' | 'default' | 'mechanical',
    fallbackDefaultModel: fallback,
    defaultMechanicalModel: DEFAULT_MECHANICAL_MODEL,
    configService, plan: fallbackPlan, adapterLabel: OPENAI_AGENT_LABEL,
  });
  return { model: result.model, logMessage: result.logMessage };
};

/**
 * Initializes the OpenAI client and provider.
 *
 * @param apiKey - OpenAI API key
 * @returns Client and provider
 */
const initOpenAiClient = (apiKey: string): { client: OpenAI; provider: OpenAIProvider } => {
  setTracingExportApiKey(apiKey);
  const client = new OpenAI({ apiKey });
  return { client, provider: new OpenAIProvider({ openAIClient: client }) };
};

/**
 * Builds an OpenAI agent instance.
 *
 * @param model - Model identifier
 * @param instructions - Agent instructions
 * @param tools - Array of tools
 * @returns Configured Agent instance
 */
const buildAgent = (
  model: string,
  instructions: string,
  tools: ReturnType<typeof tool>[]
): Agent<OpenAiImplementerContext> =>
  new Agent<OpenAiImplementerContext>({
    name: 'wf issue:implement openai backend',
    handoffDescription: 'Implements the selected ticket by editing workspace files and validating them with whitelisted verification commands.',
    instructions, model, tools, toolUseBehavior: 'run_llm_again', resetToolChoice: true,
  });

/**
 * Creates a compaction session with plan-size-aware thresholds.
 *
 * @param client - OpenAI client
 * @param model - Model identifier
 * @param stepCount - Plan step count
 * @param loop - Stream loop state (for lastObservedInputTokens)
 * @returns Configured compaction session
 */
const buildCompactionSession = (
  client: OpenAI, model: string, stepCount: number, loop: StreamLoopState
): OpenAIResponsesCompactionSession => {
  const threshold = resolveCompactionThreshold(stepCount);
  return new OpenAIResponsesCompactionSession({
    client, model, compactionMode: 'auto',
    shouldTriggerCompaction: ({ compactionCandidateItems }) =>
      compactionCandidateItems.length >= threshold || loop.lastObservedInputTokens > COMPACTION_INPUT_TOKEN_CEILING,
  });
};

/**
 * OpenAI Agents SDK-backed implementer backend.
 * The SDK drives the edit loop while this adapter owns the filesystem
 * and verification boundaries.
 */
export class OpenAIAgentAdapter implements ImplementerBackend {
  constructor(private readonly configService: ConfigService) {}

  /**
   * Generates code changes and verifies them using a host-controlled tool set.
   *
   * @param params - Implementation inputs, repository context, and verification whitelist
   * @returns Session result
   */
  async generateAndVerify(
    params: GenerateAndVerifyParams & { options: ImplementerOptions }
  ): Promise<{ sessionId?: string; verificationOutcomes: VerificationOutcome[] }> {
    const repoDir = params.options.repoDir ?? process.cwd();
    const c = await this.buildRunComponents(params, repoDir, params.options);
    return this.executeAgentRun(params, c);
  }

  /**
   * Executes the agent run and continuation loop.
   *
   * @param c - Run components
   * @param verificationScripts
   * @returns Session result
   */
  private buildRunResult(
    c: Awaited<ReturnType<OpenAIAgentAdapter['buildRunComponents']>>,
    verificationScripts: VerificationScript[],
  ): { sessionId?: string; verificationOutcomes: VerificationOutcome[] } {
    logFileSummary(c.mutable.fileChangeStatus, verificationScripts, buildAllowedCommands(verificationScripts));
    const verificationOutcomes = resolveSkippedSteps(verificationScripts, c.vs.verificationOutcomes);
    printVerificationReport(verificationOutcomes);
    return { sessionId: undefined, verificationOutcomes };
  }

  private async executeAgentRun(
    params: GenerateAndVerifyParams & { options: ImplementerOptions },
    c: Awaited<ReturnType<OpenAIAgentAdapter['buildRunComponents']>>
  ): Promise<{ sessionId?: string; verificationOutcomes: VerificationOutcome[] }> {
    let run = await this.startInitialRun(c);
    run = await runStreamWithRetry(run, c.config, c.loop, '');
    throwOnRunError(run, '');
    logCompletion(run, c.loop.usageSummary, c.model);
    const { repoFiles, repoName, verificationScripts } = params;
    const failures = c.mutable.validationFailures;
    await runContinuationLoop({ run, config: c.config, loop: c.loop, repoFiles, repoName, failures });
    return this.buildRunResult(c, verificationScripts);
  }

  /**
   * Starts the initial agent run.
   *
   * @param c - Run components
   * @returns Streamed run result
   */
  private startInitialRun(
    c: { agent: OaiAgent; prompt: string; config: StreamRunConfig; context: OpenAiImplementerContext }
  ) {
    return c.config.runner.run(c.agent, c.prompt, {
      stream: true, context: c.context, maxTurns: c.config.maxTurns, session: c.config.compaction,
    });
  }

  /**
   * Initializes provider, client, and model routing.
   *
   * @param options - Implementer options
   * @param plan
   * @returns Provider components
   */
  private initProvider(options: ImplementerOptions, plan?: ResolutionPlan) {
    const apiKey = this.configService.get<string>('ai.openaiApiKey');
    if (!apiKey) throw new Error('OpenAI agent backend requires `ai.openaiApiKey` to be configured.');
    const { client, provider } = initOpenAiClient(apiKey);
    const { model, logMessage } = resolveModel(this.configService, options.modelRouting, plan);
    console.log(chalk.cyan(`  ${logMessage}`));
    return { apiKey, client, provider, model };
  }

  /**
   * Creates the mutable state and verification context.
   *
   * @param scripts - Verification scripts
   * @returns Mutable state and verification state
   */
  private initMutableState(scripts: VerificationScript[]) {
    const mutable: ToolMutableState = {
      fileChangeStatus: new Map(), changedFilesSinceLastVerification: new Set(), validationFailures: [],
    };
    const vs: VerifyCommandState = {
      verificationCommandOrder: buildVerificationCommandOrder(scripts),
      previousSnapshot: undefined, changedFiles: mutable.changedFilesSinceLastVerification,
      verificationScripts: scripts, verificationOutcomes: [],
    };
    return { mutable, vs };
  }

  /**
   * Builds all components needed for an agent run.
   *
   * @param params - Full generateAndVerify params
   * @param repoDir - Primary repo directory
   * @param options - Implementer options
   * @returns All run components
   */
  private async buildRunComponents(params: GenerateAndVerifyParams, repoDir: string, options: ImplementerOptions) {
    const { client, provider, model } = this.initProvider(options, params.planArtifact.plan);
    const { mutable, vs } = this.initMutableState(params.verificationScripts);
    const context = this.buildContext(repoDir, options.additionalRepoDirs ?? [], params.verificationScripts);
    const { agent, prompt } = await this.buildAgentAndPrompt(params, repoDir, model, mutable, vs, options);
    const loop = this.buildLoopState(mutable);
    const compaction = buildCompactionSession(client, model, params.planArtifact.plan.steps.length, loop);
    const runner = new Runner({ modelProvider: provider });
    const config: StreamRunConfig = { runner, agent, context, maxTurns: 500, compaction };
    return { model, config, loop, mutable, vs, agent, prompt, context };
  }

  /**
   * Builds the implementer context.
   *
   * @param repoDir - Primary repo directory
   * @param additionalDirs - Additional read-only directories
   * @param scripts - Verification scripts
   * @returns Implementer context
   */
  private buildContext(
    repoDir: string, additionalDirs: string[], scripts: VerificationScript[]
  ): OpenAiImplementerContext {
    return {
      repoDir, readRoots: toWorkspaceRoots(repoDir, additionalDirs),
      allowedVerificationCommands: buildAllowedCommands(scripts),
    };
  }

  /**
   * Builds the agent instance and user prompt.
   *
   * @param params - Core params
   * @param repoDir - Primary repo directory
   * @param model - Model identifier
   * @param mutable - Shared mutable state
   * @param vs - Verification state
   * @param options - Implementer options
   * @returns Agent and prompt
   */
  private async buildAgentAndPrompt(
    params: GenerateAndVerifyParams, repoDir: string, model: string,
    mutable: ToolMutableState, vs: VerifyCommandState, options: ImplementerOptions
  ) {
    const agent = await this.createAgent(params, repoDir, model, mutable, vs, options);
    const contextMd = await loadAiContextConfig(
      path.join(os.homedir(), '.openai', 'OPENAI.md'), '.openai/OPENAI.md', 'openai', true
    );
    const prompt = buildInitialPrompt(contextMd, params.ticket.ticketKey, params.planArtifact.plan.steps.length);
    return { agent, prompt };
  }

  /**
   * Creates the agent with tools and system prompt.
   * When skillNames are provided, SKILL.md content is loaded from disk and
   * appended to the system prompt since the OpenAI Agent SDK has no native Skill tool.
   *
   * @param params - Core params
   * @param repoDir - Primary repo directory
   * @param model - Model identifier
   * @param mutable - Shared mutable state
   * @param vs - Verification state
   * @param options - Implementer options
   * @returns Configured agent
   */
  private async createAgent(
    params: GenerateAndVerifyParams, repoDir: string, model: string,
    mutable: ToolMutableState, vs: VerifyCommandState, options: ImplementerOptions
  ): Promise<OaiAgent> {
    const tools = createAllTools(mutable, vs);
    const sysPrompt = buildSystemPromptFromParams(params, repoDir);
    const preamble = buildPriorStagePreamble(options.priorStageSummary);
    const skillFragment = params.skillNames?.length ? await buildSkillPromptFragment(params.skillNames) : '';
    if (options.resumeProviderSessionId) {
      console.log(chalk.yellow(
        '  [openai-agent] Session resumption is not yet supported for the OpenAI agent backend. Starting fresh.'
      ));
    }
    return buildAgent(model, `${preamble}${sysPrompt}${skillFragment}`, tools);
  }

  /**
   * Builds the initial stream loop state.
   *
   * @param mutable - Shared mutable state
   * @returns Loop state
   */
  private buildLoopState(mutable: ToolMutableState): StreamLoopState {
    return {
      usageSummary: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, compacted: false },
      fileChangeStatus: mutable.fileChangeStatus,
      lastObservedInputTokens: 0, consecutiveRateLimitAttempts: 0, eventsInSegment: 0,
    };
  }
}
