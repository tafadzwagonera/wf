import { ConfigService } from '@nestjs/config';
import { AiProviderError, ConfigurationError, ExecutionError, ValidationError } from '../../../shared/utils/errors';
import { formatPlanRisks } from '../../../shared/utils/plan-risk';
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
import { resolveSkippedSteps, printVerificationReport, STALL_THRESHOLD } from './verification-report';
import {
  buildVerificationCommandOrder,
  buildVerificationProgressSignal,
  countDiagnosticLines,
  extractVerificationErrorClasses,
  type ImplementProgressVerificationSnapshot,
} from '../../../shared/utils/implement-verification';
import { loadAiContextConfig } from './load-ai-context-config';
import {
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENAI_MECHANICAL_MODEL,
  resolveModelRouting,
  normalizeCommand,
  buildAllowedCommands,
  stripRepoPrefix,
  isGlobPattern,
  buildBehavioralContext,
  buildTaskBrief,
  buildImplementerRulesSection,
  type BuildPlanContextParams,
} from './shared-routing';
import { buildSkillPromptFragment } from '../../../skills';
import { buildUiDesignComplianceSystemPromptSection } from '../prompt-fragments';
import type { ResolutionPlan } from '../ai.service';

const execAsync = promisify(exec);
const MAX_BUFFER_IN_BYTES = 1024 * 1024 * 10;
const MAX_GREP_LINE_LENGTH = 500;
const MAX_READ_LINES = 200;
const OPENAI_AGENT_LABEL = 'openai-agent';
const MAX_VERIFICATION_OUTPUT_LINES = 200;
const COMPACTION_INPUT_TOKEN_CEILING = 80_000;
const STATE_PRUNING_TOKEN_CEILING = 120_000;
const DEFAULT_RETRY_DELAY_IN_MS = 30_000;
const STATE_PRUNING_KEEP_TAIL_ITEMS = 20;
const MAX_CONSECUTIVE_RATE_LIMIT_RETRIES = 5;
const MAX_CONTINUATION_PASSES = 15;
const MAX_CONSECUTIVE_IDLE_PASSES = 3;

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
  conventionsSection?: string;
  skillNames?: string[];
  figmaContextSection?: string;
  uiDesignScreenshotPaths?: string[];
};

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

const buildPruneSummary = (cutIndex: number, fileChangeStatus: Map<string, string>): string => {
  const changed = [...fileChangeStatus.entries()].map(([p, s]) => `${p} (${s})`).join(', ');
  return [
    `[Context pruned: ${cutIndex} earlier items removed to stay within context limits.]`,
    changed ? `Files changed so far: ${changed}` : '',
    'Continue from where you left off. Do not re-read files you have already edited unless needed.',
  ].filter(Boolean).join('\n');
};

const extractPrunableItems = (state: unknown): Array<Record<string, unknown>> | undefined => {
  const rec = state as Record<string, unknown> | undefined;
  const items = Array.isArray(rec?._generatedItems)
    ? (rec._generatedItems as Array<Record<string, unknown>>)
    : undefined;
  return items && items.length > STATE_PRUNING_KEEP_TAIL_ITEMS ? items : undefined;
};

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

const truncateOutput = (output: string, maxLines: number): string => {
  const lines = output.split('\n');
  if (lines.length <= maxLines) return output;
  const kept = lines.slice(-maxLines);
  return `[... ${lines.length - maxLines} lines truncated — showing last ${maxLines} lines ...]\n${kept.join('\n')}`;
};

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

const matchRootPrefix = (segments: string[], roots: WorkspaceRoot[]): string | undefined => {
  const [prefix, ...rest] = segments;
  const matched = roots.find(r => r.name === prefix);
  return matched && rest.length > 0 ? path.resolve(matched.root, rest.join(path.sep)) : undefined;
};

const resolveRepoPrefixedPath = (requestedPath: string, roots: WorkspaceRoot[], defaultRoot: string): string => {
  const trimmed = requestedPath.trim();
  if (!trimmed) throw new ValidationError('File path is required.');
  if (path.isAbsolute(trimmed)) return path.resolve(trimmed);
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  return matchRootPrefix(segments, roots) ?? path.resolve(defaultRoot, trimmed);
};

const resolveReadablePath = (requestedPath: string, ctx: OpenAiImplementerContext): string => {
  const abs = resolveRepoPrefixedPath(requestedPath, ctx.readRoots, ctx.repoDir);
  if (!ctx.readRoots.some(r => isWithinRoot(abs, r.root))) {
    throw new ValidationError(`Read path is outside the allowed workspace roots: ${requestedPath}`, { path: requestedPath });
  }
  return abs;
};

const resolveWritablePath = (requestedPath: string, ctx: OpenAiImplementerContext): string => {
  const abs = resolveRepoPrefixedPath(requestedPath, ctx.readRoots, ctx.repoDir);
  const primaryRoot = ctx.readRoots[0]?.root ?? ctx.repoDir;
  if (!isWithinRoot(abs, primaryRoot) && abs !== primaryRoot) {
    throw new ValidationError(`Write path is outside the primary repository: ${requestedPath}`, { path: requestedPath });
  }
  return abs;
};

const getToolContext = (runContext: RunContext<unknown> | undefined): OpenAiImplementerContext => {
  const ctx = runContext?.context as OpenAiImplementerContext | undefined;
  if (!ctx) throw new ExecutionError('OpenAI agent tool context is missing.');
  return ctx;
};

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

const extractResponseDone = (event: unknown): Record<string, unknown> | null => {
  if (!event || typeof event !== 'object' || !('type' in event)) return null;
  if ((event as { type?: string }).type !== 'raw_model_stream_event') return null;
  const raw = event as { data?: { type?: string; response?: unknown } };
  return raw.data?.type === 'response_done' ? (raw.data.response ?? null) as Record<string, unknown> | null : null;
};

export const extractUsageFromEvent = (event: unknown): OpenAiUsageSummary | null => {
  const response = extractResponseDone(event);
  return response ? parseResponseUsage(response) : null;
};

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

const classifyHttpStatusError = (error: unknown): AgentClassification | null => {
  if (!error || typeof error !== 'object' || !('status' in error)) return null;
  return classifyByStatus((error as { status?: number }).status, error);
};

const classifySdkError = (error: unknown): AgentClassification | null => {
  if (error instanceof MaxTurnsExceededError) return { label: 'Max turns exceeded', detail: error.message, recoverable: false };
  if (error instanceof ToolTimeoutError) return { label: 'Tool timeout', detail: error.message, recoverable: true };
  if (error instanceof ToolCallError) return { label: 'Tool call error', detail: error.message, recoverable: true };
  if (error instanceof ModelBehaviorError) return { label: 'Model behavior error', detail: error.message, recoverable: false };
  if (error instanceof UserError) return { label: 'User error', detail: error.message, recoverable: false };
  if (error instanceof SystemError) return { label: 'System error', detail: error.message, recoverable: false };
  return null;
};

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

export const parseRetryDelayMs = (error: unknown): number => {
  if (!(error instanceof Error)) return DEFAULT_RETRY_DELAY_IN_MS;
  const match = new RegExp(/try again in (\d+(?:\.\d+)?)\s*(ms|s|seconds?)?/i).exec(error.message);
  if (!match) return DEFAULT_RETRY_DELAY_IN_MS;
  const value = Number.parseFloat(match[1]);
  if (Number.isNaN(value) || value <= 0) return DEFAULT_RETRY_DELAY_IN_MS;
  const unit = (match[2] ?? 's').toLowerCase();
  return unit === 'ms' ? Math.ceil(value) : Math.ceil(value * 1000);
};

type OpenAiModelPricing = { inputPerMToken: number; cachedInputPerMToken: number; outputPerMToken: number };

const openaiPricing: Record<string, OpenAiModelPricing> = {
  'gpt-4.1': { inputPerMToken: 2, cachedInputPerMToken: 0.5, outputPerMToken: 8 },
  'gpt-4.1-mini': { inputPerMToken: 0.4, cachedInputPerMToken: 0.1, outputPerMToken: 1.6 },
  'gpt-4.1-nano': { inputPerMToken: 0.1, cachedInputPerMToken: 0.025, outputPerMToken: 0.4 },
  'o4-mini': { inputPerMToken: 1.1, cachedInputPerMToken: 0.275, outputPerMToken: 4.4 },
  'gpt-4o': { inputPerMToken: 2.5, cachedInputPerMToken: 1.25, outputPerMToken: 10 },
  'gpt-4o-mini': { inputPerMToken: 0.15, cachedInputPerMToken: 0.075, outputPerMToken: 0.6 },
  'gpt-5-mini': { inputPerMToken: 0.25, cachedInputPerMToken: 0.025, outputPerMToken: 2 },
  'gpt-5.1-codex-mini': { inputPerMToken: 0.25, cachedInputPerMToken: 0.025, outputPerMToken: 2 },
};

export const estimateOpenAiCostUsd = (
  model: string, inputTokens: number, outputTokens: number, cachedInputTokens: number
): number | null => {
  const pricing = openaiPricing[model];
  if (!pricing) return null;
  const uncached = inputTokens - cachedInputTokens;
  return (uncached / 1_000_000) * pricing.inputPerMToken
    + (cachedInputTokens / 1_000_000) * pricing.cachedInputPerMToken
    + (outputTokens / 1_000_000) * pricing.outputPerMToken;
};

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

const visitTsNode = (
  node: import('typescript').Node,
  ts: typeof import('typescript')
): string | null =>
  checkDuplicateConstructor(node, ts)
  ?? checkDuplicateImport(node, ts)
  ?? ts.forEachChild(node, child => visitTsNode(child, ts))
  ?? null;

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

const availableToolsBlock = `Available tools:
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

const implementerSummaryTemplate = `### What I changed
<Bullet list of actual edits made. If nothing was changed, write: "No file content changes were required.">

### Verification run
<Bullet list of commands run with ✔ (pass) or ✖ (fail). Omit if no commands ran.>

### Files
- **Updated:** <comma-separated list or "none">
- **New:** <comma-separated list or "none">
- **Deleted:** <comma-separated list or "none">

### Assumptions / risk note
<Any assumptions made or risks identified. Write "None." if there are none.>`;

const buildScopedRules = (repoDir: string): string => [
  implementerRulesSection,
  `- Writes must stay scoped to the primary repository (${repoDir}).`,
  `- Reads may target ${repoDir} and any configured read-only sibling repositories.`,
].join('\n');

type SystemPromptParams = {
  repoDir: string;
  conventionsSection?: string;
};

const buildSystemPrompt = (p: SystemPromptParams): string => {
  const behavioralContext = buildBehavioralContext(p.repoDir);
  const conventionsPart = p.conventionsSection ? `\n\n${p.conventionsSection}` : '';
  const rules = buildScopedRules(p.repoDir);
  return `${behavioralContext}${conventionsPart}\n\n${availableToolsBlock}\n\n${rules}\n\n${implementerSummaryTemplate}`;
};

const addTokenCounts = (usage: OpenAiUsageSummary, summary: OpenAiUsageSummary): void => {
  summary.inputTokens += usage.inputTokens;
  summary.outputTokens += usage.outputTokens;
  summary.totalTokens += usage.totalTokens;
  summary.cachedInputTokens += usage.cachedInputTokens;
  if (usage.compacted) summary.compacted = true;
};

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

const formatRawModelEvent = (event: unknown): { message: string; isWarning?: boolean } | null => {
  const usage = extractUsageFromEvent(event);
  if (usage?.compacted) return { message: '  [openai-agent] Context compacted', isWarning: true };
  if (usage && usage.totalTokens > 0) {
    return { message: `  [openai-agent] Response: ${usage.inputTokens} in / ${usage.outputTokens} out tokens` };
  }
  return null;
};

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

const extractReasoningText = (item: RunItemShape): string =>
  item.content?.map(p => p.text).filter(Boolean).join(' ')
  || item.rawItem?.content?.map(p => p.text).filter(Boolean).join(' ')
  || '';

const formatRunItemByType = (item: RunItemShape): { message: string } | null => {
  if (item.type === 'function_call') return { message: `  [openai-agent] Tool requested: ${item.name ?? 'unknown'}` };
  if (item.type === 'function_call_result') return { message: `  [openai-agent] Tool completed: ${item.name ?? 'unknown'}` };
  if (item.type !== 'reasoning') return null;
  const text = extractReasoningText(item);
  return { message: text ? `  [openai-agent] Reasoning: ${text.trim().slice(0, 160)}` : '  [openai-agent] Reasoning updated' };
};

const formatRunItemEvent = (
  eventName: string | undefined,
  item: RunItemShape | undefined
): { message: string; isWarning?: boolean } | null => {
  const byName = formatRunItemByName(eventName, item);
  if (byName) return byName;
  return item?.type ? formatRunItemByType(item) : null;
};

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

const formatSummarySection = (title: string, filePaths: string[], label: string): string[] => {
  if (filePaths.length === 0) return [];
  return [`  ${title}:`, ...filePaths.map(fp => `    - ${label}: ${fp}`)];
};

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

const fileExists = (filePath: string): Promise<boolean> =>
  fs.access(filePath).then(() => true).catch(() => false);

const recordFileChange = (
  rel: string,
  status: 'created' | 'updated' | 'deleted',
  mutable: ToolMutableState
): void => {
  mutable.fileChangeStatus.set(rel, status);
  mutable.changedFilesSinceLastVerification.add(rel);
  console.log(chalk.gray(`  [openai-agent] File ${status}: ${rel}`));
};

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

const buildDenial = (command: string, allowed: string[], message: string): string =>
  JSON.stringify({ command, allowed: false, message, allowedCommands: allowed }, null, 2);

const handleVerifySuccess = (
  command: string, idx: number, stdout: string, stderr: string, vs: VerifyCommandState
): string => {
  const progress = buildSnapshot(command, idx, 0, stdout, stderr, vs);
  console.log(chalk.cyan(`  [openai-agent] Verification passed: ${command}`));
  const script = vs.verificationScripts.find(s => command.includes(s.command) || s.command.includes(command));
  vs.verificationOutcomes.push({ id: script?.id ?? 'unknown', command, policy: script?.policy ?? 'best_effort', status: 'passed' });
  return JSON.stringify({ command, allowed: true, exitCode: 0, progress });
};

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

const parseGrepMatches = (
  stdout: string, repoDir: string, max: number
): Array<{ file: string; line: number; content: string }> =>
  stdout.split('\n').filter(Boolean).slice(0, max).map(line => parseGrepLine(line, repoDir));

const handleGrepSuccess = (stdout: string, repoDir: string, pattern: string, max: number): string => {
  const matches = parseGrepMatches(stdout, repoDir, max);
  console.log(chalk.cyan(`  [openai-agent] Search: ${matches.length} match(es) for "${pattern}"`));
  return JSON.stringify({ pattern, matches, truncated: matches.length >= max });
};

const handleGrepError = (err: { code?: number; message?: string }, pattern: string): string => {
  if (err.code === 1) return JSON.stringify({ pattern, matches: [], truncated: false });
  return JSON.stringify({ pattern, matches: [], truncated: false, error: err.message ?? 'Search failed' });
};

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

const buildEditContextSnippet = (content: string, line: number): string => {
  const allLines = content.split('\n');
  const start = Math.max(0, line - 6);
  const end = Math.min(allLines.length, line + 15);
  return allLines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n');
};

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

const handleEditValidationError = (
  content: string, oldString: string, rel: string, valErr: string, failures: ValidationFailure[]
): string => {
  const idx = content.indexOf(oldString);
  const line = idx >= 0 ? content.substring(0, idx).split('\n').length : undefined;
  return recordValidationFailure(content, rel, valErr, line, failures);
};

const clearStaleFailures = (failures: ValidationFailure[], rel: string): void => {
  for (let i = failures.length - 1; i >= 0; i--) {
    if (failures[i].path === rel) failures.splice(i, 1);
  }
};

const checkEditPreconditions = (content: string, oldString: string): string | null => {
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) return JSON.stringify({ error: 'old_string not found in file' });
  if (occurrences > 1) {
    return JSON.stringify({ error: `old_string is ambiguous (${occurrences} occurrences); provide more surrounding context` });
  }
  return null;
};

const applyValidEdit = async (
  abs: string, updated: string, rel: string, mutable: ToolMutableState
): Promise<string> => {
  await fs.writeFile(abs, updated, 'utf-8');
  recordFileChange(rel, 'updated', mutable);
  clearStaleFailures(mutable.validationFailures, rel);
  return JSON.stringify({ path: rel, status: 'updated' });
};

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

const createReadFileTool = () => tool({
  name: 'read_file',
  description: 'Read a file from the repository workspace. Use offset/limit to read specific line ranges for large files.',
  parameters: z.object({ path: z.string().min(1), offset: z.number().default(0), limit: z.number().default(0) }),
  execute: executeReadFile,
});

const createWriteFileTool = (m: ToolMutableState) => tool({
  name: 'write_file',
  description: 'Write a full file into the primary repository workspace.',
  parameters: z.object({ path: z.string().min(1), content: z.string() }),
  execute: (input, ctx) => executeWriteFile(input, ctx, m),
});

const createDeleteFileTool = (m: ToolMutableState) => tool({
  name: 'delete_file',
  description: 'Delete a file from the primary repository workspace.',
  parameters: z.object({ path: z.string().min(1) }),
  execute: (input, ctx) => executeDeleteFile(input, ctx, m),
});

const createVerifyCommandTool = (vs: VerifyCommandState) => tool({
  name: 'verify_command',
  description: 'Run an exact verification command only when it appears in the whitelist.',
  parameters: z.object({ command: z.string().min(1) }),
  execute: (input, ctx) => executeVerifyCommand(input, ctx, vs),
});

const createSearchFilesTool = () => tool({
  name: 'search_files',
  description: 'Search file contents by regex pattern across the workspace.',
  parameters: z.object({
    pattern: z.string().min(1), path: z.string().default(''),
    file_glob: z.string().default(''), max_results: z.number().default(50),
  }),
  execute: executeSearchFiles,
});

const createFindFilesTool = () => tool({
  name: 'find_files',
  description: 'Find files by glob pattern across the workspace.',
  parameters: z.object({ pattern: z.string().min(1), path: z.string().default(''), max_results: z.number().default(200) }),
  execute: executeFindFiles,
});

const createEditFileTool = (m: ToolMutableState) => tool({
  name: 'edit_file',
  description: 'Replace a unique string in a file. old_string must appear exactly once.',
  parameters: z.object({ path: z.string().min(1), old_string: z.string().min(1), new_string: z.string() }),
  execute: (input, ctx) => executeEditFile(input, ctx, m),
});

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

const throwAgentError = (cls: AgentClassification, label: string): never => {
  console.log(chalk.red(`  [openai-agent] ${label}${cls.label}: ${cls.detail}`));
  throw new AiProviderError(`OpenAI agent run failed (${cls.label}): ${cls.detail}`);
};

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

const throwOnRunError = (
  run: OaiStreamedRun,
  label: string
): void => {
  if (!run.error) return;
  throwAgentError(classifyAgentError(run.error), label);
};

const logUsageSummary = (summary: OpenAiUsageSummary, model: string): void => {
  if (summary.totalTokens <= 0) return;
  const cached = summary.cachedInputTokens > 0 ? ` (${summary.cachedInputTokens} cached)` : '';
  console.log(chalk.cyan(`  [openai-agent] Usage: ${summary.inputTokens} input${cached} / ${summary.outputTokens} output tokens`));
  const cost = estimateOpenAiCostUsd(model, summary.inputTokens, summary.outputTokens, summary.cachedInputTokens);
  if (cost !== null) console.log(chalk.cyan(`  [openai-agent] Cost: ~$${cost.toFixed(4)} USD`));
};

const logFinalOutput = (finalOutput: string): void => {
  if (!finalOutput) return;
  console.log(chalk.bold('\n  Summary:'));
  for (const line of finalOutput.split('\n')) {
    if (line.trim()) console.log(chalk.cyan(`    ${line}`));
  }
};

const logCompletion = (
  run: OaiStreamedRun,
  summary: OpenAiUsageSummary,
  model: string
): void => {
  console.log(chalk.green(`  [openai-agent] Agent completed in ${run.currentTurn} turn(s).`));
  logUsageSummary(summary, model);
  if (summary.compacted) console.log(chalk.cyan('  [openai-agent] Context compaction triggered during run'));
  console.log(chalk.green('\n✔ OpenAI agent implementation complete'));
  logFinalOutput(typeof run.finalOutput === 'string' ? run.finalOutput.trim() : '');
};

const computeWorkload = (
  fileChangeStatus: Map<string, string>, repoFiles: string[], repoName: string, failures: ValidationFailure[]
): { total: number; unvisited: string[]; failureCount: number } => {
  const touched = new Set(fileChangeStatus.keys());
  const unvisited = repoFiles.map(f => stripRepoPrefix(f, repoName)).filter(f => !touched.has(f) && !isGlobPattern(f));
  const failureCount = new Set(failures.map(f => `${f.path}:${f.error}`)).size;
  return { total: unvisited.length + failureCount, unvisited, failureCount };
};

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

type OaiContinuationPromptParams = {
  unvisited: string[];
  failureCount: number;
  failures: ValidationFailure[];
  totalPlanned: number;
  passNumber: number;
  taskBriefParams: BuildPlanContextParams;
};

const buildContinuationPrompt = (p: OaiContinuationPromptParams): string => {
  const completed = p.totalPlanned - p.unvisited.length;
  const sections = buildIncompleteWorkSections(p.unvisited, p.failureCount, p.failures);
  return [
    `Progress: ${completed}/${p.totalPlanned} files modified (pass ${p.passNumber})`,
    buildTaskBrief(p.taskBriefParams),
    `\nContinue implementing the remaining plan steps. The following work is still incomplete:\n\n${sections.join('\n\n')}`,
    `\nFor each file listed above, read the full file first with read_file, then apply edit_file to complete the required changes. After addressing all listed files, search for any remaining migration patterns and continue editing until zero matches remain. Do not output any text or plan before calling your first tool.`,
  ].join('\n');
};

const computeStallThreshold = (concreteFileCount: number, configOverride?: number): number =>
  configOverride ?? Math.max(STALL_THRESHOLD, Math.ceil(concreteFileCount / 5));

const logStalledWorkload = (unvisited: string[], failureCount: number, threshold: number): void => {
  const parts: string[] = [];
  if (failureCount > 0) parts.push(`${failureCount} unresolved edit validation failure(s)`);
  if (unvisited.length > 0) parts.push(`${unvisited.length} planned file(s) not touched: ${unvisited.join(', ')}`);
  console.log(chalk.yellow(`\n  [openai-agent] Workload not decreasing after ${threshold} passes — stopping`));
  console.log(chalk.yellow(`  [openai-agent] Remaining: ${parts.join('; ')}`));
};

const appendContinuationMessage = (state: unknown, prompt: string): void => {
  const s = state as Record<string, unknown> | undefined;
  if (!s?._generatedItems) return;
  (s._generatedItems as Array<Record<string, unknown>>).push({
    rawItem: { role: 'user', content: prompt }, type: 'message',
  });
};

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

const logOaiIdleDiagnostic = (run: OaiStreamedRun, passNumber: number): void => {
  if (run.currentTurn > 1) return;
  const text = typeof run.finalOutput === 'string' ? run.finalOutput.slice(0, 200) : '';
  console.log(chalk.yellow(`  [openai-agent] Pass ${passNumber + 1} produced no tool calls (idle). AI response: ${text || '(none)'}`));
};

const runContinuationPass = async (
  passNumber: number, currentRun: OaiStreamedRun, prompt: string, config: StreamRunConfig, loop: StreamLoopState
): Promise<OaiStreamedRun> => {
  appendContinuationMessage(currentRun.state, prompt);
  loop.consecutiveRateLimitAttempts = 0;
  const label = `Pass ${passNumber} `;
  const initial = await startContinuationRun(currentRun.state, prompt, config);
  const run = await runStreamWithRetry(initial, config, loop, label);
  throwOnRunError(run, label);
  console.log(chalk.green(`  [openai-agent] Pass ${passNumber + 1} completed in ${run.currentTurn} turn(s).`));
  logOaiIdleDiagnostic(run, passNumber);
  return run;
};

const logPassStart = (passNumber: number, unvisited: string[], failureCount: number): void => {
  const reasons: string[] = [];
  if (failureCount > 0) reasons.push(`${failureCount} edit validation failure(s)`);
  if (unvisited.length > 0) reasons.push(`${unvisited.length} planned file(s) not touched`);
  console.log(chalk.yellow(`\n  [openai-agent] Pass ${passNumber}: ${reasons.join(', ')} — continuing`));
};

const updateStallCounter = (total: number, previous: number, stalled: number): number =>
  total < previous ? 0 : stalled + 1;

type ContinuationLoopParams = {
  run: OaiStreamedRun;
  config: StreamRunConfig;
  loop: StreamLoopState;
  repoFiles: string[];
  repoName: string;
  failures: ValidationFailure[];
  taskBriefParams: BuildPlanContextParams;
  stallThresholdOverride?: number;
};

type ContinuationState = {
  prev: number;
  stalled: number;
  passNum: number;
  cur: OaiStreamedRun;
  lastPassTurns?: number;
  idleCount: number;
  threshold: number;
};

const handleOaiIdlePass = (state: ContinuationState): boolean => {
  state.idleCount++;
  if (state.idleCount < MAX_CONSECUTIVE_IDLE_PASSES) return false;
  console.log(chalk.yellow(`\n  [openai-agent] Stopping after ${MAX_CONSECUTIVE_IDLE_PASSES} consecutive idle passes`));
  return true;
};

const handleOaiActivePass = (
  wl: { total: number; unvisited: string[]; failureCount: number }, state: ContinuationState
): boolean => {
  state.idleCount = 0;
  state.stalled = updateStallCounter(wl.total, state.prev, state.stalled);
  state.prev = wl.total;
  if (state.stalled < state.threshold) return false;
  logStalledWorkload(wl.unvisited, wl.failureCount, state.threshold);
  return true;
};

const shouldStopContinuation = (
  wl: { total: number; unvisited: string[]; failureCount: number }, state: ContinuationState
): boolean => {
  if (wl.total === 0) return true;
  const isIdle = state.lastPassTurns !== undefined && state.lastPassTurns <= 1;
  return isIdle ? handleOaiIdlePass(state) : handleOaiActivePass(wl, state);
};

const hasReachedOaiHardCap = (passNum: number): boolean => {
  if (passNum < MAX_CONTINUATION_PASSES) return false;
  console.log(chalk.yellow(`\n  [openai-agent] Reached hard cap of ${MAX_CONTINUATION_PASSES} continuation passes — stopping`));
  return true;
};

const initOaiContinuationState = (p: ContinuationLoopParams, fileCount: number): ContinuationState => ({
  prev: Infinity, stalled: 0, passNum: 0, cur: p.run, idleCount: 0,
  threshold: computeStallThreshold(fileCount, p.stallThresholdOverride),
});

const buildIterationPrompt = (
  p: ContinuationLoopParams, s: ContinuationState, wl: ReturnType<typeof computeWorkload>, fileCount: number
): string => buildContinuationPrompt({
  unvisited: wl.unvisited, failureCount: wl.failureCount, failures: p.failures,
  totalPlanned: fileCount, passNumber: s.passNum,
  taskBriefParams: p.taskBriefParams,
});

const runContinuationLoop = async (p: ContinuationLoopParams): Promise<void> => {
  const fileCount = p.repoFiles.filter(f => !isGlobPattern(f)).length;
  const s = initOaiContinuationState(p, fileCount);
  while (!hasReachedOaiHardCap(s.passNum)) {
    const wl = computeWorkload(p.loop.fileChangeStatus, p.repoFiles, p.repoName, p.failures);
    if (shouldStopContinuation(wl, s)) break;
    s.passNum++;
    logPassStart(s.passNum, wl.unvisited, wl.failureCount);
    s.cur = await runContinuationPass(s.passNum, s.cur, buildIterationPrompt(p, s, wl, fileCount), p.config, p.loop);
    s.lastPassTurns = s.cur.currentTurn;
  }
};

const collectSummaryPaths = (map: Map<string, string>, status: string): string[] =>
  [...map.entries()].filter(([, s]) => s === status).map(([p]) => p).sort((a, b) => a.localeCompare(b));

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

const buildPriorStagePreamble = (summary?: string): string =>
  summary
    ? `<prior-stage-context>\n${summary}\n</prior-stage-context>\n\nNote: The above is background context from a previous workflow stage.\nYour current stage's instructions take precedence over any conflicting details above.\n\n`
    : '';

const buildInitialPrompt = (taskBriefParams: BuildPlanContextParams, contextMd: string | null): string =>
  [
    contextMd ? contextMd.trimEnd() : '',
    buildTaskBrief(taskBriefParams),
    'Implement ALL plan steps completely. Do not output any text at any point — every response must be a tool call. Start editing files immediately after minimal exploration. After ALL edits are complete, run each command listed under "Verification commands:" exactly as written, in order. Do not modify or pipe the commands. Output text only as the final summary after all work is done.',
  ].filter(Boolean).join('\n\n');

const resolveCompactionThreshold = (stepCount: number): number => {
  if (stepCount <= 5) return 10;
  if (stepCount <= 10) return 20;
  return 30;
};

const buildSystemPromptFromParams = (p: GenerateAndVerifyParams, repoDir: string): string =>
  buildSystemPrompt({ repoDir, conventionsSection: p.conventionsSection });

const createAllTools = (mutable: ToolMutableState, vs: VerifyCommandState) => [
  createReadFileTool(), createWriteFileTool(mutable), createEditFileTool(mutable),
  createDeleteFileTool(mutable), createSearchFilesTool(), createFindFilesTool(),
  createVerifyCommandTool(vs),
];

const resolveModel = (
  configService: ConfigService, modelRouting: string | undefined, plan?: ResolutionPlan
): { model: string; logMessage: string } => {
  const fallback = configService.get<string>('ai.model') || DEFAULT_OPENAI_MODEL;
  const fallbackPlan: ResolutionPlan = plan ?? {
    action: 'feature', summary: '', steps: [], estimatedComplexity: 'medium',
  };
  const result = resolveModelRouting({
    routing: (modelRouting ?? 'auto') as 'auto' | 'default' | 'mechanical',
    fallbackDefaultModel: fallback,
    defaultMechanicalModel: DEFAULT_OPENAI_MECHANICAL_MODEL,
    configService, plan: fallbackPlan, adapterLabel: OPENAI_AGENT_LABEL,
  });
  return { model: result.model, logMessage: result.logMessage };
};

const initOpenAiClient = (apiKey: string): { client: OpenAI; provider: OpenAIProvider } => {
  setTracingExportApiKey(apiKey);
  const client = new OpenAI({ apiKey });
  return { client, provider: new OpenAIProvider({ openAIClient: client }) };
};

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

const buildOaiTaskBriefParams = (params: GenerateAndVerifyParams, repoDir: string): BuildPlanContextParams => ({
  ticketKey: params.ticket.ticketKey, repoDir, repoName: params.repoName,
  repoFiles: params.repoFiles, trackedFilePaths: params.trackedFilePaths,
  verificationScripts: params.verificationScripts, planSteps: params.planArtifact.plan.steps,
  planSummary: params.planArtifact.plan.summary, planAction: params.planArtifact.plan.action,
  planRisks: formatPlanRisks(params.planArtifact.plan.risks), contextFiles: params.contextFiles,
  figmaContextSection: params.figmaContextSection,
  phases: params.planArtifact.plan.phases ?? undefined,
});

export class OpenAIAgentAdapter implements ImplementerBackend {
  constructor(private readonly configService: ConfigService) {}

  async generateAndVerify(
    params: GenerateAndVerifyParams & { options: ImplementerOptions }
  ): Promise<{ sessionId?: string; verificationOutcomes: VerificationOutcome[]; modelsUsed?: string[] }> {
    const repoDir = params.options.repoDir ?? process.cwd();
    const c = await this.buildRunComponents(params, repoDir, params.options);
    return this.executeAgentRun(params, c);
  }

  private buildRunResult(
    c: Awaited<ReturnType<OpenAIAgentAdapter['buildRunComponents']>>,
    verificationScripts: VerificationScript[],
  ): { sessionId?: string; verificationOutcomes: VerificationOutcome[]; modelsUsed?: string[] } {
    logFileSummary(c.mutable.fileChangeStatus, verificationScripts, buildAllowedCommands(verificationScripts));
    const verificationOutcomes = resolveSkippedSteps(verificationScripts, c.vs.verificationOutcomes);
    printVerificationReport(verificationOutcomes);
    return { sessionId: undefined, verificationOutcomes, modelsUsed: [c.model] };
  }

  private async executeAgentRun(
    params: GenerateAndVerifyParams & { options: ImplementerOptions },
    c: Awaited<ReturnType<OpenAIAgentAdapter['buildRunComponents']>>
  ): Promise<{ sessionId?: string; verificationOutcomes: VerificationOutcome[] }> {
    const run = await runStreamWithRetry(await this.startInitialRun(c), c.config, c.loop, '');
    throwOnRunError(run, '');
    logCompletion(run, c.loop.usageSummary, c.model);
    const repoDir = params.options.repoDir ?? process.cwd();
    await runContinuationLoop({
      run, config: c.config, loop: c.loop, repoFiles: params.repoFiles, repoName: params.repoName,
      failures: c.mutable.validationFailures, taskBriefParams: buildOaiTaskBriefParams(params, repoDir),
    });
    return this.buildRunResult(c, params.verificationScripts);
  }

  private startInitialRun(
    c: { agent: OaiAgent; prompt: string; config: StreamRunConfig; context: OpenAiImplementerContext }
  ) {
    return c.config.runner.run(c.agent, c.prompt, {
      stream: true, context: c.context, maxTurns: c.config.maxTurns, session: c.config.compaction,
    });
  }

  private initProvider(options: ImplementerOptions, plan?: ResolutionPlan) {
    const apiKey = this.configService.get<string>('ai.openaiApiKey');
    if (!apiKey) throw new ConfigurationError('OpenAI agent backend requires `ai.openaiApiKey` to be configured.');
    const { client, provider } = initOpenAiClient(apiKey);
    const { model, logMessage } = resolveModel(this.configService, options.modelRouting, plan);
    console.log(chalk.cyan(`  ${logMessage}`));
    return { apiKey, client, provider, model };
  }

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

  private buildContext(
    repoDir: string, additionalDirs: string[], scripts: VerificationScript[]
  ): OpenAiImplementerContext {
    return {
      repoDir, readRoots: toWorkspaceRoots(repoDir, additionalDirs),
      allowedVerificationCommands: buildAllowedCommands(scripts),
    };
  }

  private async buildAgentAndPrompt(
    params: GenerateAndVerifyParams, repoDir: string, model: string,
    mutable: ToolMutableState, vs: VerifyCommandState, options: ImplementerOptions
  ) {
    const agent = await this.createAgent(params, repoDir, model, mutable, vs, options);
    const contextMd = await loadAiContextConfig(
      path.join(os.homedir(), '.openai', 'AGENTS.md'), 'AGENTS.md', 'openai', true
    );
    const prompt = options.initialPromptOverride
      ?? buildInitialPrompt(buildOaiTaskBriefParams(params, repoDir), contextMd);
    return { agent, prompt };
  }

  private buildAgentSystemPrompt(params: GenerateAndVerifyParams, repoDir: string): string {
    const base = buildSystemPromptFromParams(params, repoDir);
    const compliance = buildUiDesignComplianceSystemPromptSection({
      uiDesignScreenshots: params.uiDesignScreenshotPaths,
    });
    return compliance ? `${base}\n\n${compliance}` : base;
  }

  private async createAgent(
    params: GenerateAndVerifyParams, repoDir: string, model: string,
    mutable: ToolMutableState, vs: VerifyCommandState, options: ImplementerOptions
  ): Promise<OaiAgent> {
    const sysPrompt = this.buildAgentSystemPrompt(params, repoDir);
    const preamble = buildPriorStagePreamble(options.priorStageSummary);
    const skillFragment = await this.buildSkillFragment(params);
    if (options.resumeProviderSessionId) {
      console.log(chalk.yellow(
        '  [openai-agent] Session resumption is not yet supported for the OpenAI agent backend. Starting fresh.'
      ));
    }
    return buildAgent(model, `${preamble}${sysPrompt}${skillFragment}`, createAllTools(mutable, vs));
  }

  private async buildSkillFragment(params: GenerateAndVerifyParams): Promise<string> {
    const skillPart = params.skillNames?.length ? await buildSkillPromptFragment(params.skillNames, OPENAI_AGENT_LABEL, chalk.cyan) : '';
    const figmaPart = params.figmaContextSection ? `\n\n${params.figmaContextSection}` : '';
    return `${skillPart}${figmaPart}`;
  }

  private buildLoopState(mutable: ToolMutableState): StreamLoopState {
    return {
      usageSummary: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, compacted: false },
      fileChangeStatus: mutable.fileChangeStatus,
      lastObservedInputTokens: 0, consecutiveRateLimitAttempts: 0, eventsInSegment: 0,
    };
  }
}
