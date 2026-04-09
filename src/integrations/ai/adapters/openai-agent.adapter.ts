import { ConfigService } from '@nestjs/config';
import { Agent, OpenAIProvider, Runner, tool } from '@openai/agents';
import type { StreamedRunResult } from '@openai/agents';
import chalk from 'chalk';
import * as fs from 'fs/promises';
import { exec } from 'child_process';
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
  formatImplementProgressSignal,
  type ImplementProgressVerificationSnapshot,
} from '../../../shared/utils/implement-verification';
import { loadAiContextConfig } from './load-ai-context-config';

const execAsync = promisify(exec);
const DEFAULT_MODEL = 'gpt-4.1';
const MAX_BUFFER_IN_BYTES = 1024 * 1024 * 10;

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

const buildSystemPrompt = ({
  ticketKey,
  repoDir,
  repoName,
  repoFiles,
  trackedFilePaths,
  verificationScripts,
  sceneContext,
}: {
  ticketKey: string;
  repoDir: string;
  repoName: string;
  repoFiles: string[];
  trackedFilePaths: string[];
  verificationScripts: VerificationScript[];
  sceneContext: string;
}): string => {
  const fileList = formatRepoFileList(repoFiles, repoName);
  const trackedFileList = formatRepoFileList(trackedFilePaths, repoName);
  const verificationList =
    verificationScripts.length > 0
      ? verificationScripts.map((script) => `  - ${script.command}`).join('\n')
      : '  (none configured)';

  return `You are an expert software engineer implementing code changes inside a repository.

Repository directory: ${repoDir}
Ticket key: ${ticketKey}

Files to implement:
${fileList}

Tracked files:
${trackedFileList}

Verification commands:
${verificationList}

Available tools:
- read_file(path): read a file from the primary repository or configured read-only sibling repositories
- write_file(path, content): write a full file into the primary repository only
- delete_file(path): delete a file from the primary repository only
- verify_command(command): run a verification command only if it is on the whitelist

Rules:
- Read existing file contents before modifying them.
- Use write_file to replace the full contents of a file.
- Use delete_file only when a file should be removed.
- verify_command is the only way to execute a shell command, and it will reject any command outside the verification whitelist.
- Never invent or call any other shell command tool.
- Writes must stay scoped to the primary repository (${repoDir}).
- Reads may target ${repoDir} and any configured read-only sibling repositories.
- Treat the returned progress signal as a heuristic: continue when it says 'continue', focus on the latest edited files when it says 'revisit', and stop only when it says 'complete'.
- When all verification commands pass (exit 0), stop and provide a concise post-edit summary of new, updated, and deleted files.

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

const formatProgressMessage = (event: unknown): string | null => {
  if (
    !event ||
    typeof event !== 'object' ||
    !('type' in event) ||
    (event as { type?: string }).type !== 'run_item_stream_event'
  ) {
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
  const item = runEvent.item;

  if (!item?.type) {
    return null;
  }

  if (item.type === 'function_call') {
    return `  [openai-agent] Tool requested: ${item.name ?? 'unknown'}`;
  }

  if (item.type === 'function_call_result') {
    return `  [openai-agent] Tool completed: ${item.name ?? 'unknown'}`;
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
    return text
      ? `  [openai-agent] Reasoning: ${text.trim().slice(0, 160)}`
      : '  [openai-agent] Reasoning updated';
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
    const maxTurns = Math.max(20, absoluteMaxAttempts * 4);

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
        console.log(
          chalk.cyan(
            `  [openai-agent] ${formatImplementProgressSignal(progress)}`,
          ),
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
        console.log(
          chalk.cyan(
            `  [openai-agent] ${formatImplementProgressSignal(progress)}`,
          ),
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
            chalk.cyan(
              `  [openai-agent] ${formatImplementProgressSignal(progress)}`,
            ),
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
            chalk.cyan(
              `  [openai-agent] ${formatImplementProgressSignal(progress)}`,
            ),
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
      }),
      model,
      tools: [readFileTool, writeFileTool, deleteFileTool, verifyCommandTool],
      toolUseBehavior: 'run_llm_again',
      resetToolChoice: true,
    });

    const promptSections = [
      openAiContext ? openAiContext.trimEnd() : '',
      `Ticket key: ${params.ticket.ticketKey}`,
      sceneContext,
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

    try {
      for await (const event of streamedRun) {
        const formattedMessage = formatProgressMessage(event);
        if (formattedMessage) {
          console.log(chalk.cyan(formattedMessage));
        }
      }
    } catch (error) {
      throw new Error(
        `OpenAI agent run failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }

    if (streamedRun.error) {
      const streamError =
        streamedRun.error instanceof Error
          ? streamedRun.error.message
          : typeof streamedRun.error === 'string'
            ? streamedRun.error
            : (() => {
                try {
                  return JSON.stringify(streamedRun.error) ?? 'unknown error';
                } catch {
                  return 'unknown error';
                }
              })();
      throw new Error(`OpenAI agent run failed: ${streamError}`);
    }

    const finalOutput =
      typeof streamedRun.finalOutput === 'string'
        ? streamedRun.finalOutput.trim()
        : '';

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
