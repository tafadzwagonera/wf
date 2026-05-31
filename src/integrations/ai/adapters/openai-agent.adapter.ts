import { ConfigService } from '@nestjs/config';
import {
  Agent,
  MaxTurnsExceededError,
  ModelBehaviorError,
  OpenAIProvider,
  Runner,
  SystemError,
  ToolCallError,
  ToolTimeoutError,
  UserError,
  tool,
} from '@openai/agents';
import type { StreamedRunResult } from '@openai/agents';
import { OpenAIResponsesCompactionSession } from '@openai/agents-openai';
import chalk from 'chalk';
import * as fs from 'fs/promises';
import { exec } from 'child_process';
import { glob } from 'glob';
import OpenAI from 'openai';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { z } from 'zod';
import type {
  TicketArtifact,
  PlanArtifact,
  ImplementerOptions,
  IImplementerBackend,
  VerificationScript,
} from '../../../agents/interfaces';
import {
  buildMutationProgressSignal,
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
  formatRepoFileList,
  stripRepoPrefix,
} from './shared-routing';

const execAsync = promisify(exec);
const DEFAULT_MODEL = 'gpt-4.1';
const MAX_BUFFER_IN_BYTES = 1024 * 1024 * 10;
const MAX_GREP_LINE_LENGTH = 500;
const MAX_READ_LINES = 300;

const DEFAULT_MECHANICAL_MODEL = 'gpt-4.1-mini';
const OPENAI_AGENT_LABEL = 'openai-agent';
const MAX_VERIFICATION_OUTPUT_LINES = 200;
const COMPACTION_INPUT_TOKEN_CEILING = 80_000;

const shellEscape = (value: string): string =>
  `'${value.replace(/'/g, "'\\''")}'`;

/**
 * Truncates command output to the last N lines to limit context growth.
 * Prepends a note when lines are dropped so the model knows output was trimmed.
 *
 * @param output - Raw command output
 * @param maxLines - Maximum lines to keep from the tail
 * @returns Truncated output string
 */
const truncateOutput = (output: string, maxLines: number): string => {
  const lines = output.split('\n');
  if (lines.length <= maxLines) return output;
  const kept = lines.slice(-maxLines);
  return `[... ${lines.length - maxLines} lines truncated — showing last ${maxLines} lines ...]\n${kept.join('\n')}`;
};

type WorkspaceRoot = {
  name: string;
  root: string;
};

type OpenAiImplementerContext = {
  repoDir: string;
  readRoots: WorkspaceRoot[];
  allowedVerificationCommands: Set<string>;
};

const toWorkspaceRoots = (
  repoDir: string,
  additionalRepoDirs: string[],
): WorkspaceRoot[] => {
  const roots = [
    { name: path.basename(path.resolve(repoDir)), root: path.resolve(repoDir) },
    ...additionalRepoDirs.map((root) => ({
      name: path.basename(path.resolve(root)),
      root: path.resolve(root),
    })),
  ];

  const uniqueRoots: WorkspaceRoot[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const key = `${root.name}:${root.root}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueRoots.push(root);
  }

  return uniqueRoots;
};

const isWithinRoot = (absolutePath: string, root: string): boolean => {
  const relativePath = path.relative(root, absolutePath);
  return relativePath.length > 0 && !relativePath.startsWith('..');
};

const resolveRepoPrefixedPath = (
  requestedPath: string,
  roots: WorkspaceRoot[],
  defaultRoot: string,
): string => {
  const trimmedPath = requestedPath.trim();
  if (!trimmedPath) {
    throw new Error('File path is required.');
  }

  if (path.isAbsolute(trimmedPath)) {
    return path.resolve(trimmedPath);
  }

  const normalizedSegments = trimmedPath.split(/[\\/]/).filter(Boolean);
  const [prefix, ...rest] = normalizedSegments;
  const matchedRoot = roots.find((root) => root.name === prefix);
  if (matchedRoot && rest.length > 0) {
    return path.resolve(matchedRoot.root, rest.join(path.sep));
  }

  return path.resolve(defaultRoot, trimmedPath);
};

const resolveReadablePath = (
  requestedPath: string,
  context: OpenAiImplementerContext,
): string => {
  const absolutePath = resolveRepoPrefixedPath(
    requestedPath,
    context.readRoots,
    context.repoDir,
  );
  const isAllowed = context.readRoots.some((root) =>
    isWithinRoot(absolutePath, root.root),
  );

  if (!isAllowed) {
    throw new Error(
      `Read path is outside the allowed workspace roots: ${requestedPath}`,
    );
  }

  return absolutePath;
};

const resolveWritablePath = (
  requestedPath: string,
  context: OpenAiImplementerContext,
): string => {
  const absolutePath = resolveRepoPrefixedPath(
    requestedPath,
    context.readRoots,
    context.repoDir,
  );
  const primaryRoot = context.readRoots[0]?.root ?? context.repoDir;
  if (
    !isWithinRoot(absolutePath, primaryRoot) &&
    absolutePath !== primaryRoot
  ) {
    throw new Error(
      `Write path is outside the primary repository: ${requestedPath}`,
    );
  }

  return absolutePath;
};

const getToolContext = (
  runContext: { context?: unknown } | undefined,
): OpenAiImplementerContext => {
  const toolContext = runContext?.context as
    | OpenAiImplementerContext
    | undefined;
  if (!toolContext) {
    throw new Error('OpenAI agent tool context is missing.');
  }

  return toolContext;
};

export type OpenAiUsageSummary = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  compacted: boolean;
};

/**
 * Extracts token usage from a raw_model_stream_event with data.type === 'response_done'.
 *
 * @param event - A stream event from the OpenAI agent SDK
 * @returns Usage summary or null if the event is not a response_done event
 */
export const extractUsageFromEvent = (
  event: unknown,
): OpenAiUsageSummary | null => {
  if (
    !event ||
    typeof event !== 'object' ||
    !('type' in event) ||
    (event as { type?: string }).type !== 'raw_model_stream_event'
  ) {
    return null;
  }

  const raw = event as { data?: { type?: string; response?: unknown } };
  if (raw.data?.type !== 'response_done') {
    return null;
  }

  const response = raw.data.response as {
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      inputTokensDetails?: { cachedTokens?: number };
      requestUsageEntries?: Array<{ endpoint?: string }>;
    };
  } | null;

  const usage = response?.usage;
  if (!usage) {
    return null;
  }

  const cachedInputTokens = usage.inputTokensDetails?.cachedTokens ?? 0;
  const compacted =
    usage.requestUsageEntries?.some(
      (entry) => entry.endpoint === 'responses.compact',
    ) ?? false;

  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    cachedInputTokens,
    compacted,
  };
};

/**
 * Classifies an error from the OpenAI agent SDK into a structured label.
 *
 * @param error - The error thrown during an agent run
 * @returns Structured classification with label, detail, and recoverability
 */
export const classifyAgentError = (
  error: unknown,
): { label: string; detail: string; recoverable: boolean } => {
  if (error instanceof MaxTurnsExceededError) {
    return {
      label: 'Max turns exceeded',
      detail: error.message,
      recoverable: false,
    };
  }

  if (error instanceof ToolTimeoutError) {
    return {
      label: 'Tool timeout',
      detail: error.message,
      recoverable: true,
    };
  }

  if (error instanceof ToolCallError) {
    return {
      label: 'Tool call error',
      detail: error.message,
      recoverable: true,
    };
  }

  if (error instanceof ModelBehaviorError) {
    return {
      label: 'Model behavior error',
      detail: error.message,
      recoverable: false,
    };
  }

  if (error instanceof UserError) {
    return { label: 'User error', detail: error.message, recoverable: false };
  }

  if (error instanceof SystemError) {
    return {
      label: 'System error',
      detail: error.message,
      recoverable: false,
    };
  }

  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: number }).status;
    if (status === 429) {
      return {
        label: 'Rate limited',
        detail:
          error instanceof Error ? error.message : 'Too many requests (429)',
        recoverable: true,
      };
    }
    if (status === 401 || status === 403) {
      return {
        label: 'Authentication error',
        detail:
          error instanceof Error
            ? error.message
            : `Authentication failed (${status})`,
        recoverable: false,
      };
    }
  }

  if (error instanceof Error && /rate limit/i.test(error.message)) {
    return {
      label: 'Rate limited',
      detail: error.message,
      recoverable: true,
    };
  }

  return {
    label: 'Unknown error',
    detail: error instanceof Error ? error.message : 'unknown error',
    recoverable: false,
  };
};

/**
 * Extracts the retry delay from a rate-limit error message.
 * OpenAI mid-stream errors include "Please try again in Xs" or "in Xms".
 * Returns the delay in milliseconds, or a default of 30 000 ms.
 */
export const parseRetryDelayMs = (error: unknown): number => {
  const DEFAULT_DELAY_MS = 30_000;
  if (!(error instanceof Error)) return DEFAULT_DELAY_MS;
  const match = error.message.match(
    /try again in (\d+(?:\.\d+)?)\s*(ms|s|seconds?)?/i,
  );
  if (!match) return DEFAULT_DELAY_MS;
  const value = parseFloat(match[1]);
  if (Number.isNaN(value) || value <= 0) return DEFAULT_DELAY_MS;
  const unit = (match[2] ?? 's').toLowerCase();
  return unit === 'ms' ? Math.ceil(value) : Math.ceil(value * 1000);
};

type OpenAiModelPricing = {
  inputPerMToken: number;
  cachedInputPerMToken: number;
  outputPerMToken: number;
};

const OPENAI_PRICING: Record<string, OpenAiModelPricing> = {
  'gpt-4.1': {
    inputPerMToken: 2.0,
    cachedInputPerMToken: 0.5,
    outputPerMToken: 8.0,
  },
  'gpt-4.1-mini': {
    inputPerMToken: 0.4,
    cachedInputPerMToken: 0.1,
    outputPerMToken: 1.6,
  },
  'gpt-4.1-nano': {
    inputPerMToken: 0.1,
    cachedInputPerMToken: 0.025,
    outputPerMToken: 0.4,
  },
  'o4-mini': {
    inputPerMToken: 1.1,
    cachedInputPerMToken: 0.275,
    outputPerMToken: 4.4,
  },
  'gpt-4o': {
    inputPerMToken: 2.5,
    cachedInputPerMToken: 1.25,
    outputPerMToken: 10.0,
  },
  'gpt-4o-mini': {
    inputPerMToken: 0.15,
    cachedInputPerMToken: 0.075,
    outputPerMToken: 0.6,
  },
};

/**
 * Estimates the USD cost of an OpenAI API run from token counts and model name.
 * Returns null if the model is not in the pricing table.
 *
 * @param model - The OpenAI model identifier
 * @param inputTokens - Total input tokens (includes cached)
 * @param outputTokens - Total output tokens
 * @param cachedInputTokens - Cached input tokens (subset of inputTokens)
 * @returns Estimated cost in USD, or null if model pricing is unknown
 */
export const estimateOpenAiCostUsd = (
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
): number | null => {
  const pricing = OPENAI_PRICING[model];
  if (!pricing) return null;

  const uncachedInputTokens = inputTokens - cachedInputTokens;
  const inputCost = (uncachedInputTokens / 1_000_000) * pricing.inputPerMToken;
  const cachedCost =
    (cachedInputTokens / 1_000_000) * pricing.cachedInputPerMToken;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMToken;

  return inputCost + cachedCost + outputCost;
};

/**
 * Validates a TypeScript file's content for structural correctness after an edit.
 * Catches duplicate constructors and duplicate named imports that the model commonly produces.
 *
 * @param filePath - The file path (used to decide whether to validate and for diagnostics)
 * @param content - The full file content after the proposed edit
 * @returns An error message string if invalid, or null if valid
 */
export const validateTypeScriptEdit = (
  filePath: string,
  content: string,
): string | null => {
  if (!/\.tsx?$/.test(filePath)) {
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ts = require('typescript') as typeof import('typescript');

  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
  );

  const parseDiagnostics = (
    sourceFile as unknown as { parseDiagnostics?: unknown[] }
  ).parseDiagnostics;
  if (parseDiagnostics && parseDiagnostics.length > 0) {
    return `syntax error in ${filePath}: ${(parseDiagnostics[0] as { messageText?: string }).messageText ?? 'parse error'}`;
  }

  const visit = (node: import('typescript').Node): string | null => {
    if (ts.isClassDeclaration(node)) {
      const className = node.name?.text ?? '<anonymous>';
      const constructorsWithBody = node.members.filter(
        (member) =>
          ts.isConstructorDeclaration(member) && member.body !== undefined,
      );
      if (constructorsWithBody.length > 1) {
        return `Class "${className}" has ${constructorsWithBody.length} constructor declarations with bodies — merge parameters into a single constructor`;
      }
    }

    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings) {
      if (ts.isNamedImports(node.importClause.namedBindings)) {
        const seen = new Map<string, string>();
        const moduleSpecifier =
          (node.moduleSpecifier as { text?: string }).text ?? '';
        for (const element of node.importClause.namedBindings.elements) {
          const name = element.name.text;
          const key = `${name}::${moduleSpecifier}`;
          if (seen.has(key)) {
            return `Duplicate import "${name}" from "${moduleSpecifier}"`;
          }
          seen.set(key, name);
        }
      }
    }

    return ts.forEachChild(node, visit) ?? null;
  };

  return visit(sourceFile);
};

const buildSystemPrompt = ({
  ticketKey,
  repoDir,
  repoName,
  repoFiles,
  trackedFilePaths,
  verificationScripts,
  sceneContext,
  planSteps,
}: {
  ticketKey: string;
  repoDir: string;
  repoName: string;
  repoFiles: string[];
  trackedFilePaths: string[];
  verificationScripts: VerificationScript[];
  sceneContext: string;
  planSteps: string[];
}): string => {
  const fileList = formatRepoFileList(repoFiles, repoName);
  const trackedFileList = formatRepoFileList(trackedFilePaths, repoName);
  const verificationList =
    verificationScripts.length > 0
      ? verificationScripts.map((script) => `  - ${script.command}`).join('\n')
      : '  (none configured)';
  const planStepList =
    planSteps.length > 0
      ? planSteps.map((step, i) => `  ${i + 1}. ${step}`).join('\n')
      : '  (none listed)';

  return `You are an expert software engineer implementing code changes inside a repository.

Repository directory: ${repoDir}
Ticket key: ${ticketKey}

Plan steps:
${planStepList}

Files to implement:
${fileList}

Tracked files:
${trackedFileList}

Verification commands:
${verificationList}

Available tools:
- read_file(path, offset?, limit?): read a file with optional line range (default: first ${MAX_READ_LINES} lines)
- write_file(path, content): write a full file into the primary repository only
- edit_file(path, old_string, new_string): surgically replace a unique string in a file
- delete_file(path): delete a file from the primary repository only
- search_files(pattern, path?, file_glob?, max_results?): search file contents by regex
- find_files(pattern, path?, max_results?): find files by glob pattern
- verify_command(command): run a verification command only if it is on the whitelist

Rules:
- ALWAYS use edit_file instead of write_file for existing files. write_file should only be used for creating new files. Using write_file on existing files wastes context on unchanged lines.
- Use search_files to find relevant line numbers, then read_file with offset/limit to read only the section you need. Avoid reading entire large files.
- For mechanical migrations (e.g. replacing Logger with PinoLogger across many files): use search_files to find all call sites, then apply edit_file to each file without re-reading the full file — the search results show enough context.
- Use find_files to discover file paths instead of guessing.
- Use delete_file only when a file should be removed.
- verify_command is the only way to execute a shell command, and it will reject any command outside the verification whitelist.
- Never invent or call any other shell command tool.
- Never duplicate a function. To add a parameter, modify the existing function signature. To change behavior, edit the existing function body. This applies to constructors, methods, and standalone functions alike.
- Writes must stay scoped to the primary repository (${repoDir}).
- Reads may target ${repoDir} and any configured read-only sibling repositories.
- You MUST implement ALL plan steps listed above. Do not stop after completing only the core infrastructure — continue through every step until all tasks are done.
- Treat the returned progress signal as a heuristic only — never use a 'complete' verdict as a reason to stop. The verdict reflects a single verification command, not overall plan completion.
- Use verification commands as intermediate checkpoints to catch regressions. After each passing verification, check whether ALL plan steps are done. If any migration or refactoring work remains, continue working.
- After verification passes, run search_files to count remaining instances of the patterns you are migrating (e.g. 'new Logger('). If the search returns ANY matches, you MUST continue editing those files — do NOT output a summary or any text. Producing a summary that says "remaining work needed" or "follow-up required" is a failure. Keep calling edit_file until the search returns zero matches.
- Only stop when the migration search confirms zero remaining instances AND all verification commands pass (exit 0) — or when you determine no file changes are required. Then output ONLY the following summary, filled in with actual results. Do not add preamble or planning text.

### What I changed
<Bullet list of actual edits made. If nothing was changed, write: "No file content changes were required.">

### Verification run
<Bullet list of commands run with ✅ (pass) or ❌ (fail). Omit if no commands ran.>

### Files
- **Updated:** <comma-separated list or "none">
- **New:** <comma-separated list or "none">
- **Deleted:** <comma-separated list or "none">

### Assumptions / risk note
<Any assumptions made or risks identified. Write "None." if there are none.>

Task context:
${sceneContext}`;
};

export const formatProgressMessage = (
  event: unknown,
): { message: string; isWarning?: boolean } | null => {
  if (!event || typeof event !== 'object' || !('type' in event)) {
    return null;
  }

  const eventType = (event as { type?: string }).type;

  if (eventType === 'raw_model_stream_event') {
    const raw = event as { data?: { type?: string; response?: unknown } };
    if (raw.data?.type === 'response_done') {
      const usage = extractUsageFromEvent(event);
      if (usage?.compacted) {
        return {
          message: '  [openai-agent] Context compacted',
          isWarning: true,
        };
      }
      if (usage && usage.totalTokens > 0) {
        return {
          message: `  [openai-agent] Response: ${usage.inputTokens} in / ${usage.outputTokens} out tokens`,
        };
      }
    }
    // output_text_delta and response_started are too noisy
    return null;
  }

  if (eventType === 'agent_updated_stream_event') {
    const agentEvent = event as { agent?: { name?: string } };
    return {
      message: `  [openai-agent] Agent updated: ${agentEvent.agent?.name ?? 'unknown'}`,
    };
  }

  if (eventType !== 'run_item_stream_event') {
    return null;
  }

  const runEvent = event as {
    name?: string;
    item?: {
      type?: string;
      name?: string;
      status?: string;
      content?: Array<{ text?: string }>;
      rawItem?: { content?: Array<{ text?: string }> };
    };
  };
  const { name: eventName, item } = runEvent;

  if (eventName === 'message_output_created') {
    return { message: '  [openai-agent] Message output started' };
  }

  if (eventName === 'handoff_requested') {
    return { message: '  [openai-agent] Handoff requested' };
  }

  if (eventName === 'handoff_occurred') {
    return { message: '  [openai-agent] Handoff occurred' };
  }

  if (eventName === 'tool_search_called') {
    return { message: '  [openai-agent] Tool search called' };
  }

  if (eventName === 'tool_search_output_created') {
    return { message: '  [openai-agent] Tool search completed' };
  }

  if (eventName === 'tool_approval_requested') {
    return {
      message: `  [openai-agent] Tool approval requested: ${item?.name ?? 'unknown'}`,
    };
  }

  if (!item?.type) {
    return null;
  }

  if (item.type === 'function_call') {
    return {
      message: `  [openai-agent] Tool requested: ${item.name ?? 'unknown'}`,
    };
  }

  if (item.type === 'function_call_result') {
    return {
      message: `  [openai-agent] Tool completed: ${item.name ?? 'unknown'}`,
    };
  }

  if (item.type === 'reasoning') {
    const text =
      item.content
        ?.map((part) => part.text)
        .filter(Boolean)
        .join(' ') ||
      item.rawItem?.content
        ?.map((part) => part.text)
        .filter(Boolean)
        .join(' ') ||
      '';
    return {
      message: text
        ? `  [openai-agent] Reasoning: ${text.trim().slice(0, 160)}`
        : '  [openai-agent] Reasoning updated',
    };
  }

  return null;
};

const formatSummarySection = (
  title: string,
  filePaths: string[],
  label: string,
): string[] => {
  if (filePaths.length === 0) {
    return [];
  }

  return [
    `  ${title}:`,
    ...filePaths.map((filePath) => `    - ${label}: ${filePath}`),
  ];
};

/**
 * OpenAI Agents SDK-backed implementer backend.
 * The SDK drives the edit loop while this adapter owns the filesystem and
 * verification boundaries.
 */
export class OpenAIAgentAdapter implements IImplementerBackend {
  constructor(private configService: ConfigService) {}

  /**
   * Generates code changes and verifies them using a host-controlled tool set.
   *
   * @param params - Implementation inputs, repository context, and verification whitelist
   * @returns Nothing when the agent completes successfully
   */
  async generateAndVerify(params: {
    ticket: TicketArtifact;
    planArtifact: PlanArtifact;
    options: ImplementerOptions;
    verificationScripts: VerificationScript[];
    sceneContext: string;
    repoFiles: string[];
    repoName: string;
    trackedFilePaths: string[];
  }): Promise<void> {
    const { options, verificationScripts, sceneContext, repoFiles, repoName } =
      params;
    const repoDir = options.repoDir ?? process.cwd();
    const readRoots = toWorkspaceRoots(
      repoDir,
      options.additionalRepoDirs ?? [],
    );
    const allowedCommands = buildAllowedCommands(verificationScripts);
    const verificationCommandOrder =
      buildVerificationCommandOrder(verificationScripts);
    const fileChangeStatus = new Map<
      string,
      'created' | 'updated' | 'deleted'
    >();
    const changedFilesSinceLastVerification = new Set<string>();
    const validationFailures: Array<{
      path: string;
      error: string;
      line?: number;
    }> = [];
    let previousVerificationSnapshot:
      | ImplementProgressVerificationSnapshot
      | undefined;
    const apiKey = this.configService.get<string>('ai.openaiApiKey');

    if (!apiKey) {
      throw new Error(
        'OpenAI agent backend requires `ai.openaiApiKey` to be configured.',
      );
    }

    const openaiClient = new OpenAI({ apiKey });
    const modelProvider = new OpenAIProvider({
      openAIClient: openaiClient,
    });
    const planStepCount = params.planArtifact.plan.steps.length;
    const maxTurns = 500;

    const primaryModel =
      this.configService.get<string>('stages.implement.model') ||
      this.configService.get<string>('ai.model') ||
      DEFAULT_MODEL;
    const routing = options.modelRouting ?? 'auto';
    const modelRoutingResult = resolveModelRouting({
      routing,
      primaryModel,
      defaultMechanicalModel: DEFAULT_MECHANICAL_MODEL,
      configService: this.configService,
      plan: params.planArtifact.plan,
      adapterLabel: OPENAI_AGENT_LABEL,
    });
    const model = modelRoutingResult.model;
    console.log(chalk.cyan(`  ${modelRoutingResult.logMessage}`));

    const openAiContext = await loadAiContextConfig(
      path.join(os.homedir(), '.openai', 'OPENAI.md'),
      '.openai/OPENAI.md',
      'openai',
      true,
    );
    const context: OpenAiImplementerContext = {
      repoDir,
      readRoots,
      allowedVerificationCommands: allowedCommands,
    };

    const readFileTool = tool({
      name: 'read_file',
      description:
        'Read a file from the repository workspace. Use offset/limit to read specific line ranges for large files.',
      parameters: z.object({
        path: z.string().min(1),
        offset: z.number().default(0),
        limit: z.number().default(0),
      }),
      async execute(input, runContext) {
        const toolContext = getToolContext(runContext);
        const absolutePath = resolveReadablePath(input.path, toolContext);
        const content = await fs.readFile(absolutePath, 'utf-8');
        const relativePath = path.relative(toolContext.repoDir, absolutePath);
        const allLines = content.split('\n');
        const totalLines = allLines.length;
        const requestedOffset = input.offset > 0 ? input.offset : 0;
        const requestedLimit = input.limit > 0 ? input.limit : MAX_READ_LINES;
        const selectedLines = allLines.slice(
          requestedOffset,
          requestedOffset + requestedLimit,
        );
        const truncated = totalLines > requestedOffset + requestedLimit;
        const numberedContent = selectedLines
          .map((line, i) => `${requestedOffset + i + 1}: ${line}`)
          .join('\n');
        return JSON.stringify({
          path: relativePath,
          totalLines,
          offset: requestedOffset,
          linesReturned: selectedLines.length,
          truncated,
          content: numberedContent,
          ...(truncated && {
            hint: `File has ${totalLines} lines. Use offset=${requestedOffset + requestedLimit} to read the next section.`,
          }),
        });
      },
    });

    const writeFileTool = tool({
      name: 'write_file',
      description: 'Write a full file into the primary repository workspace.',
      parameters: z.object({
        path: z.string().min(1),
        content: z.string(),
      }),
      async execute(input, runContext) {
        const toolContext = getToolContext(runContext);
        const absolutePath = resolveWritablePath(input.path, toolContext);
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        const existedBefore = await fs
          .access(absolutePath)
          .then(() => true)
          .catch(() => false);
        await fs.writeFile(absolutePath, input.content, 'utf-8');
        const relativePath = path.relative(toolContext.repoDir, absolutePath);
        const status = existedBefore ? 'updated' : 'created';
        fileChangeStatus.set(relativePath, status);
        changedFilesSinceLastVerification.add(relativePath);
        const progress = buildMutationProgressSignal({
          change: status,
          path: relativePath,
          changedFilesSinceLastVerification: [
            ...changedFilesSinceLastVerification,
          ],
        });
        console.log(
          chalk.cyan(`  [openai-agent] File ${status}: ${relativePath}`),
        );
        return JSON.stringify(
          { path: relativePath, status, progress },
          null,
          2,
        );
      },
    });

    const deleteFileTool = tool({
      name: 'delete_file',
      description: 'Delete a file from the primary repository workspace.',
      parameters: z.object({
        path: z.string().min(1),
      }),
      async execute(input, runContext) {
        const toolContext = getToolContext(runContext);
        const absolutePath = resolveWritablePath(input.path, toolContext);
        const existedBefore = await fs
          .access(absolutePath)
          .then(() => true)
          .catch(() => false);
        if (!existedBefore) {
          return JSON.stringify(
            {
              path: path.relative(toolContext.repoDir, absolutePath),
              status: 'missing',
              message: 'File does not exist.',
            },
            null,
            2,
          );
        }

        await fs.unlink(absolutePath);
        const relativePath = path.relative(toolContext.repoDir, absolutePath);
        fileChangeStatus.set(relativePath, 'deleted');
        changedFilesSinceLastVerification.add(relativePath);
        const progress = buildMutationProgressSignal({
          change: 'deleted',
          path: relativePath,
          changedFilesSinceLastVerification: [
            ...changedFilesSinceLastVerification,
          ],
        });
        console.log(
          chalk.cyan(`  [openai-agent] File deleted: ${relativePath}`),
        );
        return JSON.stringify(
          { path: relativePath, status: 'deleted', progress },
          null,
          2,
        );
      },
    });

    const verifyCommandTool = tool({
      name: 'verify_command',
      description:
        'Run an exact verification command only when it appears in the whitelist.',
      parameters: z.object({
        command: z.string().min(1),
      }),
      async execute(input, runContext) {
        const toolContext = getToolContext(runContext);
        const command = normalizeCommand(input.command);
        const allowedCommandsList = [
          ...toolContext.allowedVerificationCommands,
        ];

        if (!command) {
          return JSON.stringify(
            {
              command,
              allowed: false,
              message: 'Verification command missing a command string.',
              allowedCommands: allowedCommandsList,
            },
            null,
            2,
          );
        }

        if (!toolContext.allowedVerificationCommands.has(command)) {
          const message = `Command "${command}" is not in the verification whitelist. Allowed commands: ${allowedCommandsList.join(', ') || '(none configured)'}.`;
          console.log(
            chalk.red(`  [openai-agent] Verification denied: ${command}`),
          );
          return JSON.stringify(
            {
              command,
              allowed: false,
              message,
              allowedCommands: allowedCommandsList,
            },
            null,
            2,
          );
        }

        console.log(
          chalk.cyan(`  [openai-agent] Verification running: ${command}`),
        );
        const commandIndex = verificationCommandOrder.get(command) ?? -1;
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd: toolContext.repoDir,
            maxBuffer: MAX_BUFFER_IN_BYTES,
          });
          const currentSnapshot: ImplementProgressVerificationSnapshot = {
            command,
            commandIndex,
            exitCode: 0,
            diagnosticLineCount: countDiagnosticLines(stdout, stderr),
            errorClasses: extractVerificationErrorClasses(stdout, stderr),
          };
          const progress = buildVerificationProgressSignal({
            currentSnapshot,
            previousSnapshot: previousVerificationSnapshot,
            changedFilesSinceLastVerification: [
              ...changedFilesSinceLastVerification,
            ],
          });
          previousVerificationSnapshot = currentSnapshot;
          changedFilesSinceLastVerification.clear();
          console.log(
            chalk.cyan(`  [openai-agent] Verification passed: ${command}`),
          );
          return JSON.stringify(
            {
              command,
              allowed: true,
              exitCode: 0,
              stdout: truncateOutput(
                stdout.trim(),
                MAX_VERIFICATION_OUTPUT_LINES,
              ),
              stderr: truncateOutput(
                stderr.trim(),
                MAX_VERIFICATION_OUTPUT_LINES,
              ),
              progress,
            },
            null,
            2,
          );
        } catch (error: any) {
          const stdout = error.stdout?.trim?.() ?? '';
          const stderr = error.stderr?.trim?.() ?? error.message ?? '';
          const currentSnapshot: ImplementProgressVerificationSnapshot = {
            command,
            commandIndex,
            exitCode: error.code ?? 1,
            diagnosticLineCount: countDiagnosticLines(stdout, stderr),
            errorClasses: extractVerificationErrorClasses(stdout, stderr),
          };
          const progress = buildVerificationProgressSignal({
            currentSnapshot,
            previousSnapshot: previousVerificationSnapshot,
            changedFilesSinceLastVerification: [
              ...changedFilesSinceLastVerification,
            ],
          });
          previousVerificationSnapshot = currentSnapshot;
          changedFilesSinceLastVerification.clear();
          console.log(
            chalk.red(`  [openai-agent] Verification failed: ${command}`),
          );
          return JSON.stringify(
            {
              command,
              allowed: true,
              exitCode: error.code ?? 1,
              stdout: truncateOutput(stdout, MAX_VERIFICATION_OUTPUT_LINES),
              stderr: truncateOutput(stderr, MAX_VERIFICATION_OUTPUT_LINES),
              progress,
            },
            null,
            2,
          );
        }
      },
    });

    const searchFilesTool = tool({
      name: 'search_files',
      description:
        'Search file contents by regex pattern across the workspace.',
      parameters: z.object({
        pattern: z.string().min(1),
        path: z.string().default(''),
        file_glob: z.string().default(''),
        max_results: z.number().default(50),
      }),
      async execute(input, runContext) {
        const toolContext = getToolContext(runContext);
        const searchRoot = input.path
          ? resolveReadablePath(input.path, toolContext)
          : toolContext.repoDir;
        const globArg = input.file_glob
          ? `--include=${shellEscape(input.file_glob)}`
          : '';
        try {
          const { stdout } = await execAsync(
            `grep -rn ${globArg} -m ${input.max_results} -E ${shellEscape(input.pattern)} ${shellEscape(searchRoot)}`,
            { maxBuffer: MAX_BUFFER_IN_BYTES },
          );
          const matches = stdout
            .split('\n')
            .filter(Boolean)
            .slice(0, input.max_results)
            .map((line) => {
              const firstColon = line.indexOf(':');
              const secondColon = line.indexOf(':', firstColon + 1);
              if (firstColon === -1 || secondColon === -1) {
                return { file: line, line: 0, content: '' };
              }
              const file = path.relative(
                toolContext.repoDir,
                line.slice(0, firstColon),
              );
              const lineNum = parseInt(
                line.slice(firstColon + 1, secondColon),
                10,
              );
              const content = line
                .slice(secondColon + 1)
                .slice(0, MAX_GREP_LINE_LENGTH);
              return { file, line: lineNum, content };
            });
          console.log(
            chalk.cyan(
              `  [openai-agent] Search: ${matches.length} match(es) for "${input.pattern}"`,
            ),
          );
          return JSON.stringify({
            pattern: input.pattern,
            matches,
            truncated: matches.length >= input.max_results,
          });
        } catch (error: any) {
          // grep exit code 1 = no matches
          if (error.code === 1) {
            return JSON.stringify({
              pattern: input.pattern,
              matches: [],
              truncated: false,
            });
          }
          return JSON.stringify({
            pattern: input.pattern,
            matches: [],
            truncated: false,
            error: error.message ?? 'Search failed',
          });
        }
      },
    });

    const findFilesTool = tool({
      name: 'find_files',
      description: 'Find files by glob pattern across the workspace.',
      parameters: z.object({
        pattern: z.string().min(1),
        path: z.string().default(''),
        max_results: z.number().default(200),
      }),
      async execute(input, runContext) {
        const toolContext = getToolContext(runContext);
        const searchRoot = input.path
          ? resolveReadablePath(input.path, toolContext)
          : toolContext.repoDir;
        const matches = await glob(input.pattern, {
          cwd: searchRoot,
          nodir: true,
        });
        const truncated = matches.length > input.max_results;
        const files = matches.slice(0, input.max_results);
        console.log(
          chalk.cyan(
            `  [openai-agent] Find: ${files.length} file(s) for "${input.pattern}"`,
          ),
        );
        return JSON.stringify({ pattern: input.pattern, files, truncated });
      },
    });

    const editFileTool = tool({
      name: 'edit_file',
      description:
        'Replace a unique string in a file. old_string must appear exactly once.',
      parameters: z.object({
        path: z.string().min(1),
        old_string: z.string().min(1),
        new_string: z.string(),
      }),
      async execute(input, runContext) {
        const toolContext = getToolContext(runContext);
        const absolutePath = resolveWritablePath(input.path, toolContext);
        const content = await fs.readFile(absolutePath, 'utf-8');
        const occurrences = content.split(input.old_string).length - 1;
        if (occurrences === 0) {
          return JSON.stringify({ error: 'old_string not found in file' });
        }
        if (occurrences > 1) {
          return JSON.stringify({
            error: `old_string is ambiguous (${occurrences} occurrences); provide more surrounding context`,
          });
        }
        const updated = content.replace(input.old_string, input.new_string);
        const validationError = validateTypeScriptEdit(absolutePath, updated);
        if (validationError) {
          const matchIndex = content.indexOf(input.old_string);
          const line =
            matchIndex >= 0
              ? content.substring(0, matchIndex).split('\n').length
              : undefined;
          const relativePath = path.relative(toolContext.repoDir, absolutePath);
          validationFailures.push({
            path: relativePath,
            error: validationError,
            line,
          });
          console.log(
            chalk.yellow(
              `  [openai-agent] Edit validation failed: ${input.path}${line ? `:${line}` : ''}`,
            ),
          );
          // Return the existing code around the edit site so the model can
          // self-correct without a separate read_file round-trip.
          if (line) {
            const allLines = content.split('\n');
            const contextStart = Math.max(0, line - 6);
            const contextEnd = Math.min(allLines.length, line + 15);
            const existingCode = allLines
              .slice(contextStart, contextEnd)
              .map((l, i) => `${contextStart + i + 1}: ${l}`)
              .join('\n');
            return JSON.stringify({
              error: validationError,
              hint: 'Merge your changes into the existing declaration instead of adding a duplicate. The existing code around the edit site is shown below.',
              existing_code: existingCode,
            });
          }
          return JSON.stringify({ error: validationError });
        }
        await fs.writeFile(absolutePath, updated, 'utf-8');
        const relativePath = path.relative(toolContext.repoDir, absolutePath);
        fileChangeStatus.set(relativePath, 'updated');
        changedFilesSinceLastVerification.add(relativePath);
        const progress = buildMutationProgressSignal({
          change: 'updated',
          path: relativePath,
          changedFilesSinceLastVerification: [
            ...changedFilesSinceLastVerification,
          ],
        });
        console.log(
          chalk.cyan(`  [openai-agent] File edited: ${relativePath}`),
        );
        return JSON.stringify(
          { path: relativePath, status: 'updated', progress },
          null,
          2,
        );
      },
    });

    const agent = new Agent<OpenAiImplementerContext>({
      name: 'wf issue:implement openai backend',
      handoffDescription:
        'Implements the selected ticket by editing workspace files and validating them with whitelisted verification commands.',
      instructions: buildSystemPrompt({
        ticketKey: params.ticket.ticketKey,
        repoDir,
        repoName,
        repoFiles,
        trackedFilePaths: params.trackedFilePaths,
        verificationScripts,
        sceneContext,
        planSteps: params.planArtifact.plan.steps,
      }),
      model,
      tools: [
        readFileTool,
        writeFileTool,
        editFileTool,
        deleteFileTool,
        searchFilesTool,
        findFilesTool,
        verifyCommandTool,
      ],
      toolUseBehavior: 'run_llm_again',
      resetToolChoice: true,
    });

    const promptSections = [
      openAiContext ? openAiContext.trimEnd() : '',
      `Ticket key: ${params.ticket.ticketKey}`,
      `Implement ALL ${params.planArtifact.plan.steps.length} plan steps completely. Do not output any text or plan before calling your first tool.`,
    ].filter(Boolean);
    const prompt = promptSections.join('\n\n');

    const runner = new Runner({
      modelProvider,
    });

    const compactionItemThreshold =
      planStepCount <= 5 ? 10 : planStepCount <= 10 ? 20 : 30;

    // Track the last response_done input token count for the compaction
    // trigger. Updated on every response_done event; reset to 0 after
    // compaction fires so the trigger doesn't re-fire on stale values.
    let lastObservedInputTokens = 0;

    const compactionSession = new OpenAIResponsesCompactionSession({
      client: openaiClient,
      model,
      compactionMode: 'auto',
      shouldTriggerCompaction: ({ compactionCandidateItems }) => {
        if (compactionCandidateItems.length >= compactionItemThreshold) {
          return true;
        }
        return lastObservedInputTokens > COMPACTION_INPUT_TOKEN_CEILING;
      },
    });

    const usageSummary: OpenAiUsageSummary = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      compacted: false,
    };

    const MAX_CONSECUTIVE_RATE_LIMIT_RETRIES = 5;
    let streamedRun: StreamedRunResult<OpenAiImplementerContext, typeof agent> =
      await runner.run(agent, prompt, {
        stream: true,
        context,
        maxTurns,
        session: compactionSession,
      });

    let consecutiveRateLimitAttempts = 0;
    let eventsProcessedInSegment = 0;

    while (true) {
      try {
        eventsProcessedInSegment = 0;
        for await (const event of streamedRun) {
          eventsProcessedInSegment++;
          const usage = extractUsageFromEvent(event);
          if (usage) {
            usageSummary.inputTokens += usage.inputTokens;
            usageSummary.outputTokens += usage.outputTokens;
            usageSummary.totalTokens += usage.totalTokens;
            usageSummary.cachedInputTokens += usage.cachedInputTokens;
            lastObservedInputTokens = usage.inputTokens;
            if (usage.compacted) {
              usageSummary.compacted = true;
              lastObservedInputTokens = 0;
            }
          }
          const formatted = formatProgressMessage(event);
          if (formatted) {
            console.log(
              formatted.isWarning
                ? chalk.yellow(formatted.message)
                : chalk.cyan(formatted.message),
            );
          }
        }
        break;
      } catch (error) {
        const classified = classifyAgentError(error);
        if (!classified.recoverable || classified.label !== 'Rate limited') {
          console.log(
            chalk.red(
              `  [openai-agent] ${classified.label}: ${classified.detail}`,
            ),
          );
          throw new Error(
            `OpenAI agent run failed (${classified.label}): ${classified.detail}`,
          );
        }
        if (eventsProcessedInSegment > 0) {
          consecutiveRateLimitAttempts = 0;
        }
        consecutiveRateLimitAttempts++;
        if (consecutiveRateLimitAttempts > MAX_CONSECUTIVE_RATE_LIMIT_RETRIES) {
          console.log(
            chalk.red(
              `  [openai-agent] ${classified.label}: ${classified.detail}`,
            ),
          );
          throw new Error(
            `OpenAI agent run failed (${classified.label}): ${classified.detail}`,
          );
        }
        const delayMs = parseRetryDelayMs(error);
        console.log(
          chalk.yellow(
            `  [openai-agent] Rate limited — retrying in ${Math.ceil(delayMs / 1000)}s (attempt ${consecutiveRateLimitAttempts}/${MAX_CONSECUTIVE_RATE_LIMIT_RETRIES})`,
          ),
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        streamedRun = await runner.run(agent, streamedRun.state, {
          stream: true,
          context,
          maxTurns,
          session: compactionSession,
        });
      }
    }

    if (streamedRun.error) {
      const classified = classifyAgentError(streamedRun.error);
      console.log(
        chalk.red(`  [openai-agent] ${classified.label}: ${classified.detail}`),
      );
      throw new Error(
        `OpenAI agent run failed (${classified.label}): ${classified.detail}`,
      );
    }

    const finalOutput =
      typeof streamedRun.finalOutput === 'string'
        ? streamedRun.finalOutput.trim()
        : '';

    console.log(
      chalk.green(
        `  [openai-agent] Agent completed in ${streamedRun.currentTurn} turn(s).`,
      ),
    );
    if (usageSummary.totalTokens > 0) {
      const cachedLabel =
        usageSummary.cachedInputTokens > 0
          ? ` (${usageSummary.cachedInputTokens} cached)`
          : '';
      console.log(
        chalk.cyan(
          `  [openai-agent] Usage: ${usageSummary.inputTokens} input${cachedLabel} / ${usageSummary.outputTokens} output tokens`,
        ),
      );
      const costUsd = estimateOpenAiCostUsd(
        model,
        usageSummary.inputTokens,
        usageSummary.outputTokens,
        usageSummary.cachedInputTokens,
      );
      if (costUsd !== null) {
        console.log(
          chalk.cyan(`  [openai-agent] Cost: ~$${costUsd.toFixed(4)} USD`),
        );
      }
    }
    if (usageSummary.compacted) {
      console.log(
        chalk.cyan('  [openai-agent] Context compaction triggered during run'),
      );
    }
    console.log(chalk.green('\n✓ OpenAI agent implementation complete'));
    if (finalOutput) {
      console.log(chalk.bold('\n  Summary:'));
      finalOutput.split('\n').forEach((line) => {
        if (line.trim()) {
          console.log(chalk.cyan(`    ${line}`));
        }
      });
    }

    // Incomplete-work loop: resume the same agent with a continuation prompt
    // so it retains full context of what it already did. Stops when all work
    // is done or the workload stops decreasing for 2 consecutive passes.
    let previousWorkload = Infinity;
    let stalledPasses = 0;
    let passNumber = 0;

    while (true) {
      const touchedFiles = new Set(fileChangeStatus.keys());
      const currentUnvisited = repoFiles
        .map((f) => stripRepoPrefix(f, repoName))
        .filter((f) => !touchedFiles.has(f));
      const uniqueFailureCount = new Set(
        validationFailures.map((f) => `${f.path}:${f.error}`),
      ).size;
      const currentWorkload = currentUnvisited.length + uniqueFailureCount;

      if (currentWorkload === 0) {
        break;
      }

      if (currentWorkload < previousWorkload) {
        stalledPasses = 0;
      } else {
        stalledPasses++;
      }
      previousWorkload = currentWorkload;

      if (stalledPasses >= 2) {
        const remaining: string[] = [];
        if (uniqueFailureCount > 0) {
          remaining.push(
            `${uniqueFailureCount} unresolved edit validation failure(s)`,
          );
        }
        if (currentUnvisited.length > 0) {
          remaining.push(
            `${currentUnvisited.length} planned file(s) not touched: ${currentUnvisited.join(', ')}`,
          );
        }
        console.log(
          chalk.yellow(
            `\n  [openai-agent] Workload not decreasing after 2 passes — stopping`,
          ),
        );
        console.log(
          chalk.yellow(`  [openai-agent] Remaining: ${remaining.join('; ')}`),
        );
        break;
      }

      passNumber++;

      const reasons: string[] = [];
      if (uniqueFailureCount > 0) {
        reasons.push(`${uniqueFailureCount} edit validation failure(s)`);
      }
      if (currentUnvisited.length > 0) {
        reasons.push(`${currentUnvisited.length} planned file(s) not touched`);
      }

      console.log(
        chalk.yellow(
          `\n  [openai-agent] Pass ${passNumber}: ${reasons.join(', ')} — continuing`,
        ),
      );

      const incompleteWorkSections: string[] = [];

      if (uniqueFailureCount > 0) {
        const uniqueFailures = new Map<
          string,
          (typeof validationFailures)[0]
        >();
        for (const failure of validationFailures) {
          const key = `${failure.path}:${failure.error}`;
          if (!uniqueFailures.has(key)) {
            uniqueFailures.set(key, failure);
          }
        }
        const failureLines = [...uniqueFailures.values()]
          .map((f) => `- ${f.path}${f.line ? `:${f.line}` : ''} — ${f.error}`)
          .join('\n');
        incompleteWorkSections.push(
          `Structural edit failures (read each file, then merge changes correctly):\n${failureLines}`,
        );
      }

      if (currentUnvisited.length > 0) {
        const unvisitedLines = currentUnvisited.map((f) => `- ${f}`).join('\n');
        incompleteWorkSections.push(
          `Planned files not yet modified:\n${unvisitedLines}`,
        );
      }

      const continuationPrompt = `Continue implementing the remaining plan steps. The following work is still incomplete:\n\n${incompleteWorkSections.join('\n\n')}\n\nFor each file listed above, read the full file first with read_file, then apply edit_file to complete the required changes. After addressing all listed files, search for any remaining migration patterns and continue editing until zero matches remain. Do not output any text or plan before calling your first tool.`;

      // Build continuation input from prior state when available, falling
      // back to a plain string prompt when state is absent (e.g. in tests).
      const state = streamedRun.state;
      const hasState = state?._originalInput != null;

      const continuationInput: any = hasState
        ? [
            ...(typeof state._originalInput === 'string'
              ? [{ role: 'user', content: state._originalInput }]
              : state._originalInput),
            ...state._generatedItems.map(
              (item: { rawItem: unknown }) => item.rawItem,
            ),
            { role: 'user', content: continuationPrompt },
          ]
        : continuationPrompt;

      consecutiveRateLimitAttempts = 0;
      eventsProcessedInSegment = 0;
      streamedRun = await runner.run(agent, continuationInput, {
        stream: true,
        context,
        maxTurns,
        session: compactionSession,
      });

      while (true) {
        try {
          eventsProcessedInSegment = 0;
          for await (const event of streamedRun) {
            eventsProcessedInSegment++;
            const usage = extractUsageFromEvent(event);
            if (usage) {
              usageSummary.inputTokens += usage.inputTokens;
              usageSummary.outputTokens += usage.outputTokens;
              usageSummary.totalTokens += usage.totalTokens;
              usageSummary.cachedInputTokens += usage.cachedInputTokens;
              lastObservedInputTokens = usage.inputTokens;
              if (usage.compacted) {
                usageSummary.compacted = true;
                lastObservedInputTokens = 0;
              }
            }
            const formatted = formatProgressMessage(event);
            if (formatted) {
              console.log(
                formatted.isWarning
                  ? chalk.yellow(formatted.message)
                  : chalk.cyan(formatted.message),
              );
            }
          }
          break;
        } catch (error) {
          const classified = classifyAgentError(error);
          if (!classified.recoverable || classified.label !== 'Rate limited') {
            console.log(
              chalk.red(
                `  [openai-agent] Pass ${passNumber} ${classified.label}: ${classified.detail}`,
              ),
            );
            throw new Error(
              `OpenAI agent pass ${passNumber + 1} failed (${classified.label}): ${classified.detail}`,
            );
          }
          if (eventsProcessedInSegment > 0) {
            consecutiveRateLimitAttempts = 0;
          }
          consecutiveRateLimitAttempts++;
          if (
            consecutiveRateLimitAttempts > MAX_CONSECUTIVE_RATE_LIMIT_RETRIES
          ) {
            console.log(
              chalk.red(
                `  [openai-agent] Pass ${passNumber} ${classified.label}: ${classified.detail}`,
              ),
            );
            throw new Error(
              `OpenAI agent pass ${passNumber + 1} failed (${classified.label}): ${classified.detail}`,
            );
          }
          const delayMs = parseRetryDelayMs(error);
          console.log(
            chalk.yellow(
              `  [openai-agent] Pass ${passNumber} rate limited — retrying in ${Math.ceil(delayMs / 1000)}s (attempt ${consecutiveRateLimitAttempts}/${MAX_CONSECUTIVE_RATE_LIMIT_RETRIES})`,
            ),
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          streamedRun = await runner.run(agent, streamedRun.state, {
            stream: true,
            context,
            maxTurns,
            session: compactionSession,
          });
        }
      }

      if (streamedRun.error) {
        const classified = classifyAgentError(streamedRun.error);
        console.log(
          chalk.red(
            `  [openai-agent] Pass ${passNumber} ${classified.label}: ${classified.detail}`,
          ),
        );
        throw new Error(
          `OpenAI agent pass ${passNumber + 1} failed (${classified.label}): ${classified.detail}`,
        );
      }

      console.log(
        chalk.green(
          `  [openai-agent] Pass ${passNumber + 1} completed in ${streamedRun.currentTurn} turn(s).`,
        ),
      );
    }

    const fileSummaryLines = [
      ...formatSummarySection(
        'New files',
        this.collectSummaryPaths(fileChangeStatus, 'created'),
        'created',
      ),
      ...formatSummarySection(
        'Updated files',
        this.collectSummaryPaths(fileChangeStatus, 'updated'),
        'updated',
      ),
      ...formatSummarySection(
        'Deleted files',
        this.collectSummaryPaths(fileChangeStatus, 'deleted'),
        'deleted',
      ),
    ];
    if (fileSummaryLines.length > 0) {
      console.log(chalk.bold('\n  File summary:'));
      fileSummaryLines.forEach((line) => console.log(chalk.cyan(line)));
    } else {
      console.log(chalk.gray('\n  File summary: no file changes were made.'));
    }

    if (verificationScripts.length > 0) {
      console.log(
        chalk.gray(
          `  Verification whitelist respected: ${[...allowedCommands].join(', ') || '(none)'}`,
        ),
      );
    }
  }

  /**
   * Collects file paths from the recorded file-change map by status.
   *
   * @param fileChangeStatus - Status map recorded by the write and delete tools
   * @param desiredStatus - Desired summary bucket
   * @returns Repo-relative file paths that match the requested status
   */
  private collectSummaryPaths(
    fileChangeStatus: Map<string, 'created' | 'updated' | 'deleted'>,
    desiredStatus: 'created' | 'updated' | 'deleted',
  ): string[] {
    return [...fileChangeStatus.entries()]
      .filter(([, status]) => status === desiredStatus)
      .map(([filePath]) => filePath)
      .sort();
  }
}
