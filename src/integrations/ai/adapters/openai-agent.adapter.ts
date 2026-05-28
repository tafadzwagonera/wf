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
import chalk from 'chalk';
import * as fs from 'fs/promises';
import { exec } from 'child_process';
import { glob } from 'glob';
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

const execAsync = promisify(exec);
const DEFAULT_MODEL = 'gpt-4.1';
const MAX_BUFFER_IN_BYTES = 1024 * 1024 * 10;
const MAX_GREP_LINE_LENGTH = 500;

const shellEscape = (value: string): string =>
  `'${value.replace(/'/g, "'\\''")}'`;

type WorkspaceRoot = {
  name: string;
  root: string;
};

type OpenAiImplementerContext = {
  repoDir: string;
  readRoots: WorkspaceRoot[];
  allowedVerificationCommands: Set<string>;
};

const normalizeCommand = (command: unknown): string =>
  typeof command === 'string' ? command.trim() : '';

const buildAllowedCommands = (
  verificationScripts: VerificationScript[],
): Set<string> =>
  new Set(
    verificationScripts
      .map((script) => script.command.trim())
      .filter((command) => command.length > 0),
  );

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
      requestUsageEntries?: Array<{ endpoint?: string }>;
    };
  } | null;

  const usage = response?.usage;
  if (!usage) {
    return null;
  }

  const compacted =
    usage.requestUsageEntries?.some(
      (entry) => entry.endpoint === 'responses.compact',
    ) ?? false;

  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
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

  return {
    label: 'Unknown error',
    detail: error instanceof Error ? error.message : 'unknown error',
    recoverable: false,
  };
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
- read_file(path): read a file from the primary repository or configured read-only sibling repositories
- write_file(path, content): write a full file into the primary repository only
- edit_file(path, old_string, new_string): surgically replace a unique string in a file
- delete_file(path): delete a file from the primary repository only
- search_files(pattern, path?, file_glob?, max_results?): search file contents by regex
- find_files(pattern, path?, max_results?): find files by glob pattern
- verify_command(command): run a verification command only if it is on the whitelist

Rules:
- Prefer edit_file over write_file when making targeted changes to existing files.
- Use find_files to discover file paths instead of guessing.
- Use search_files to understand code patterns before making changes.
- Read existing file contents before modifying them.
- Use write_file to replace the full contents of a file.
- Use delete_file only when a file should be removed.
- verify_command is the only way to execute a shell command, and it will reject any command outside the verification whitelist.
- Never invent or call any other shell command tool.
- Writes must stay scoped to the primary repository (${repoDir}).
- Reads may target ${repoDir} and any configured read-only sibling repositories.
- You MUST implement ALL plan steps listed above. Do not stop after completing only the core infrastructure — continue through every step until all tasks are done.
- Treat the returned progress signal as a heuristic: continue when it says 'continue', focus on the latest edited files when it says 'revisit', and stop only when it says 'complete'.
- Use verification commands as intermediate checkpoints, not as stop signals. Run verification periodically to catch regressions, then continue implementing remaining plan steps.
- Only stop when ALL plan steps have been implemented AND all verification commands pass (exit 0) — or when you determine no file changes are required. Then output ONLY the following summary, filled in with actual results. Do not add preamble or planning text.

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

const formatRepoFileList = (repoFiles: string[], repoName: string): string => {
  if (repoFiles.length === 0) {
    return '  (none listed)';
  }

  return repoFiles
    .map((filePath) => {
      const relativePath =
        repoName && filePath.startsWith(`${repoName}/`)
          ? filePath.slice(repoName.length + 1)
          : filePath;
      return `  - ${relativePath}`;
    })
    .join('\n');
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
    let previousVerificationSnapshot:
      | ImplementProgressVerificationSnapshot
      | undefined;
    const apiKey = this.configService.get<string>('ai.openaiApiKey');

    if (!apiKey) {
      throw new Error(
        'OpenAI agent backend requires `ai.openaiApiKey` to be configured.',
      );
    }

    const modelProvider = new OpenAIProvider({
      apiKey,
    });
    const absoluteMaxAttempts =
      this.configService.get<number>(
        'stages.implement.afterImplement.absoluteMaxAttempts',
      ) ?? 5;
    const planStepCount = params.planArtifact.plan.steps.length;
    const targetFileCount = repoFiles.length;
    const maxTurns = Math.min(
      200,
      Math.max(
        20,
        absoluteMaxAttempts * 4,
        planStepCount * 10,
        targetFileCount * 3,
      ),
    );

    const model =
      this.configService.get<string>('stages.implement.model') ||
      this.configService.get<string>('ai.model') ||
      DEFAULT_MODEL;
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
      description: 'Read a file from the repository workspace.',
      parameters: z.object({
        path: z.string().min(1),
      }),
      async execute(input, runContext) {
        const toolContext = getToolContext(runContext);
        const absolutePath = resolveReadablePath(input.path, toolContext);
        const content = await fs.readFile(absolutePath, 'utf-8');
        const relativePath = path.relative(toolContext.repoDir, absolutePath);
        return JSON.stringify(
          {
            path: relativePath,
            content,
          },
          null,
          2,
        );
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
              stdout: stdout.trim(),
              stderr: stderr.trim(),
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
              stdout,
              stderr,
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
      `Implement ALL ${params.planArtifact.plan.steps.length} plan steps completely. Use find_files and search_files to explore the codebase, read_file to inspect files before editing, then use edit_file for targeted changes or write_file for new/full rewrites. Run verify_command as intermediate checkpoints but do not stop until every plan step is done. Do not output any text or plan before calling your first tool.`,
    ].filter(Boolean);
    const prompt = promptSections.join('\n\n');

    const runner = new Runner({
      modelProvider,
    });

    const streamedRun: StreamedRunResult<
      OpenAiImplementerContext,
      typeof agent
    > = await runner.run(agent, prompt, {
      stream: true,
      context,
      maxTurns,
    });

    const usageSummary: OpenAiUsageSummary = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      compacted: false,
    };

    try {
      for await (const event of streamedRun) {
        const usage = extractUsageFromEvent(event);
        if (usage) {
          usageSummary.inputTokens += usage.inputTokens;
          usageSummary.outputTokens += usage.outputTokens;
          usageSummary.totalTokens += usage.totalTokens;
          if (usage.compacted) {
            usageSummary.compacted = true;
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
    } catch (error) {
      const classified = classifyAgentError(error);
      console.log(
        chalk.red(`  [openai-agent] ${classified.label}: ${classified.detail}`),
      );
      throw new Error(
        `OpenAI agent run failed (${classified.label}): ${classified.detail}`,
      );
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
      console.log(
        chalk.cyan(
          `  [openai-agent] Usage: ${usageSummary.inputTokens} input / ${usageSummary.outputTokens} output tokens`,
        ),
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
