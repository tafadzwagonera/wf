// src/integrations/ai/adapters/anthropic-agent.adapter.ts
import { ConfigService } from '@nestjs/config';
import {
  type CanUseTool,
  type SDKResultMessage,
  type Settings,
  type SettingSource,
} from '@anthropic-ai/claude-agent-sdk';
import chalk from 'chalk';
import { exec } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import type {
  TicketArtifact,
  PlanArtifact,
  ImplementerOptions,
  IImplementerBackend,
  VerificationScript,
} from '../../../agents/interfaces';
import { loadAnthropicAgentSdk } from './load-anthropic-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  resolveModelRouting,
  normalizeCommand,
  buildAllowedCommands,
  formatRepoFileList,
  stripRepoPrefix,
  isGlobPattern,
} from './shared-routing';

const CLAUDE_CODE_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
  'TodoWrite',
  'Task',
  'Agent',
] as const;
const DEFAULT_MECHANICAL_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_AGENT_LABEL = 'claude-agent-sdk';
const FALLBACK_VERIFICATION_LABEL = 'verification command';

type ActivityState = {
  lastVerificationCommand?: string;
};

const buildCanUseTool = (
  allowedCommands: Set<string>,
  activityState: ActivityState,
): CanUseTool => {
  return async (toolName, input) => {
    if (toolName !== 'Bash') {
      return { behavior: 'allow' };
    }

    const command = normalizeCommand(input['command']);
    if (!command) {
      return {
        behavior: 'deny',
        message: 'Bash command missing a command string.',
        interrupt: true,
      };
    }

    if (!allowedCommands.has(command)) {
      console.log(
        chalk.red(
          `  [${ANTHROPIC_AGENT_LABEL}] Verification denied: ${command}`,
        ),
      );
      return {
        behavior: 'deny',
        message: `Bash command "${command}" is not in the verification whitelist. Allowed commands: ${[...allowedCommands].join(', ') || '(none configured)'}.`,
        interrupt: true,
      };
    }

    activityState.lastVerificationCommand = command;
    console.log(
      chalk.cyan(
        `  [${ANTHROPIC_AGENT_LABEL}] Verification running: ${command}`,
      ),
    );
    return { behavior: 'allow' };
  };
};

const execAsync = promisify(exec);

const resolveRepoPath = (repoDir: string, rawPath: string): string =>
  path.isAbsolute(rawPath) ? rawPath : path.resolve(repoDir, rawPath);

/**
 * Discovers files changed on disk since the last commit using git.
 * Falls back to the provided set if git is unavailable.
 *
 * @param repoDir - Repository root directory
 * @param existing - Existing set of touched files to merge into
 * @returns Merged set of relative file paths
 */
const discoverChangedFiles = async (
  repoDir: string,
  existing: Set<string>,
): Promise<Set<string>> => {
  try {
    const { stdout } = await execAsync(
      'git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null',
      { cwd: repoDir },
    );
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) {
        existing.add(trimmed);
      }
    }
  } catch (error) {
    console.log(
      chalk.gray(
        `  [${ANTHROPIC_AGENT_LABEL}] git file discovery unavailable: ${error instanceof Error ? error.message : 'unknown error'}`,
      ),
    );
  }
  return existing;
};

const readOptionalFile = async (filePath: string): Promise<string | null> => {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
};

const warnMissingClaudeFile = (filePath: string): void => {
  console.log(chalk.yellow(`⚠️ Missing CLAUDE.md file at ${filePath}`));
};

/**
 * Format a streamed progress event for console output.
 *
 * @param message - The SDK progress message to format
 * @returns A human-readable log line, or null when the message is not progress
 */
export const formatProgressMessage = (message: SDKMessage): string | null => {
  if (message.type === 'system' && message.subtype === 'task_progress') {
    const summary = message.summary?.trim() || message.description.trim();
    const lastToolLabel = message.last_tool_name
      ? ` · last tool: ${message.last_tool_name}`
      : '';
    return `  [${ANTHROPIC_AGENT_LABEL}] Task progress: ${summary}${lastToolLabel}`;
  }

  if (message.type === 'tool_progress') {
    const elapsedSeconds = message.elapsed_time_seconds.toFixed(1);
    const taskLabel = message.task_id ? ` · task: ${message.task_id}` : '';
    return `  [${ANTHROPIC_AGENT_LABEL}] Tool progress: ${message.tool_name} (${elapsedSeconds}s)${taskLabel}`;
  }

  if (message.type === 'system' && message.subtype === 'api_retry') {
    const errorLabel = message.error_status
      ? `HTTP ${message.error_status}`
      : 'connection error';
    return `  [${ANTHROPIC_AGENT_LABEL}] API retry: attempt ${message.attempt}/${message.max_retries} after ${errorLabel} (${message.retry_delay_ms}ms backoff)`;
  }

  if (message.type === 'system' && message.subtype === 'status') {
    if (!message.status) return null;
    return `  [${ANTHROPIC_AGENT_LABEL}] Status: ${message.status}`;
  }

  if (message.type === 'rate_limit_event') {
    return `  [${ANTHROPIC_AGENT_LABEL}] Rate limit: updated`;
  }

  if (message.type === 'system' && message.subtype === 'compact_boundary') {
    const meta = message.compact_metadata;
    return `  [${ANTHROPIC_AGENT_LABEL}] Context compacted (${meta.trigger}, ${meta.pre_tokens} tokens before)`;
  }

  if (
    message.type === 'system' &&
    message.subtype === 'session_state_changed'
  ) {
    return `  [${ANTHROPIC_AGENT_LABEL}] Session state: ${message.state}`;
  }

  return null;
};

const extractVerificationCommand = (
  summary: string,
  fallbackCommand?: string,
): string => {
  const backtickMatch = summary.match(/`([^`]+)`/);
  if (backtickMatch?.[1]) {
    return backtickMatch[1].trim();
  }

  const quoteMatch = summary.match(/["']([^"']+)["']/);
  if (quoteMatch?.[1]) {
    return quoteMatch[1].trim();
  }

  const ranMatch = summary.match(
    /(?:ran|run|executed)\s+([a-z0-9:_./@=-]+(?:\s+[a-z0-9:_./@=-]+)*)/i,
  );
  if (ranMatch?.[1]) {
    return ranMatch[1].trim().replace(/[.]+$/, '');
  }

  return fallbackCommand ?? FALLBACK_VERIFICATION_LABEL;
};

const extractVerificationOutcome = (
  summary: string,
): 'passed' | 'failed' | null => {
  if (
    /(failed|failure|exit code [1-9]\d*|non-zero exit|error\b|errors\b)/i.test(
      summary,
    )
  ) {
    return 'failed';
  }

  if (
    /(passed|success|succeeded|completed successfully|exit code 0)/i.test(
      summary,
    )
  ) {
    return 'passed';
  }

  return null;
};

/**
 * Derive stable file and verification activity logs from streamed SDK messages.
 *
 * @param message - The SDK message to inspect
 * @param repoDir - The primary repository root for relative path rendering
 * @param activityState - Mutable activity state shared across the stream
 * @returns Explicit terminal log lines for file or verification activity
 */
export const formatActivityMessages = (
  message: SDKMessage,
  repoDir: string,
  activityState: ActivityState,
): string[] => {
  if (message.type === 'system' && message.subtype === 'files_persisted') {
    return message.files.map(({ filename }) => {
      const absolutePath = resolveRepoPath(repoDir, filename);
      const relativePath = path.relative(repoDir, absolutePath);
      return `  [${ANTHROPIC_AGENT_LABEL}] File updated: ${relativePath}`;
    });
  }

  if (message.type === 'tool_use_summary') {
    const outcome = extractVerificationOutcome(message.summary);
    if (!outcome) {
      return [];
    }

    const command = extractVerificationCommand(
      message.summary,
      activityState.lastVerificationCommand,
    );
    activityState.lastVerificationCommand = command;
    return [`  [${ANTHROPIC_AGENT_LABEL}] Verification ${outcome}: ${command}`];
  }

  return [];
};

/**
 * Print a streamed progress event when the SDK emits one.
 *
 * @param message - The SDK message to inspect
 * @returns True when the message was handled as progress
 */
const logProgressMessage = (message: SDKMessage): boolean => {
  const formattedMessage = formatProgressMessage(message);
  if (!formattedMessage) {
    return false;
  }

  const isWarning =
    (message.type === 'system' && message.subtype === 'api_retry') ||
    (message.type === 'system' && message.subtype === 'status');

  console.log(
    isWarning ? chalk.yellow(formattedMessage) : chalk.cyan(formattedMessage),
  );
  return true;
};

const loadClaudeContext = async (repoDir: string): Promise<string> => {
  const globalClaudePath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  const repoClaudePath = path.join(repoDir, 'CLAUDE.md');
  const [rootClaude, dotClaude] = await Promise.all([
    readOptionalFile(globalClaudePath),
    readOptionalFile(repoClaudePath),
  ]);

  if (rootClaude === null) {
    warnMissingClaudeFile(globalClaudePath);
  }

  if (dotClaude === null) {
    warnMissingClaudeFile(repoClaudePath);
  }

  const sections = [
    rootClaude && `## ~/.claude/CLAUDE.md\n${rootClaude.trimEnd()}`,
    dotClaude && `## CLAUDE.md\n${dotClaude.trimEnd()}`,
  ].filter(Boolean);

  return sections.join('\n\n');
};

const buildSystemPrompt = ({
  repoDir,
  repoName,
  repoFiles,
  trackedFilePaths,
  verificationScripts,
  sceneContext,
}: {
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
Files to implement:
${fileList}

Tracked files:
${trackedFileList}

Verification commands (run these to check your work):
${verificationList}

Rules:
- Always Read existing file contents before modifying them. For edits that touch class constructors, method signatures, decorator lists, or module configuration, read the full file first and merge your changes into the existing structure rather than adding alongside it.
- Use Write or Edit to write complete updated file contents
- Use Bash only for verification commands that appear in the verification whitelist
- Never duplicate a function, constructor, or class member. To add a parameter, modify the existing declaration. To change behavior, edit the existing body.
- Writes are allowed only within the primary repository (${repoDir})
- Reads are allowed from ${repoDir} and any configured read-only sibling repositories
- Treat streamed progress updates as heuristics: continue when they point to forward motion, revisit when the pass looks stuck, and stop only when the agent returns a final result.
- When all verification commands pass (exit 0) — or when you determine no file changes are required — stop and output ONLY the following summary, filled in with actual results. Do not add preamble or planning text.

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

/**
 * Claude Agent SDK-backed implementer backend.
 * The SDK drives the edit loop directly with built-in Read / Write / Edit / Bash
 * tools while this adapter constrains the working directory, filesystem access,
 * and Bash verification commands.
 */
export class AnthropicAgentAdapter implements IImplementerBackend {
  constructor(private configService: ConfigService) {}

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
    const additionalRepoDirs = options.additionalRepoDirs ?? [];
    const allowedCommands = buildAllowedCommands(verificationScripts);
    const activityState: ActivityState = {};
    const apiKey = this.configService.get<string>('ai.anthropicApiKey');
    const claudeContext = await loadClaudeContext(repoDir);

    if (!apiKey) {
      throw new Error(
        'Anthropic Agent SDK backend requires `ai.anthropicApiKey` to be configured.',
      );
    }

    const fallbackDefaultModel =
      this.configService.get<string>('ai.model') || 'claude-sonnet-4-6';
    const routing = options.modelRouting ?? 'auto';
    const modelRoutingResult = resolveModelRouting({
      routing,
      fallbackDefaultModel,
      defaultMechanicalModel: DEFAULT_MECHANICAL_MODEL,
      configService: this.configService,
      plan: params.planArtifact.plan,
      adapterLabel: ANTHROPIC_AGENT_LABEL,
    });
    const model = modelRoutingResult.model;
    console.log(chalk.cyan(`  ${modelRoutingResult.logMessage}`));

    const sdkOptions = {
      cwd: repoDir,
      model,
      tools: [...CLAUDE_CODE_TOOLS],
      allowedTools: [...CLAUDE_CODE_TOOLS],
      permissionMode: 'acceptEdits' as const,
      // Emit periodic task summaries so the CLI can mirror long-running agent
      // progress instead of waiting for the final result only.
      agentProgressSummaries: true,
      settingSources: ['project'] as SettingSource[],
      settings: {
        claudeMdExcludes: [
          path.join(repoDir, 'CLAUDE.md'),
          path.join(repoDir, '.claude', 'CLAUDE.md'),
        ],
        autoCompactWindow: 20000,
      } satisfies Settings,
      systemPrompt: {
        type: 'preset' as const,
        preset: 'claude_code' as const,
        append: [
          claudeContext ? `\n\nRepo AI context:\n${claudeContext}` : '',
          `\n\n${buildSystemPrompt({
            repoDir,
            repoName,
            repoFiles,
            trackedFilePaths: params.trackedFilePaths,
            verificationScripts,
            sceneContext,
          })}`,
        ].join(''),
      },
      canUseTool: buildCanUseTool(allowedCommands, activityState),
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: apiKey,
      },
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: true,
        filesystem: {
          allowRead: [
            resolveRepoPath(repoDir, '.'),
            ...additionalRepoDirs.map((dir) => resolveRepoPath(repoDir, dir)),
          ],
          allowWrite: [resolveRepoPath(repoDir, '.')],
        },
      },
    };

    const { query } = await loadAnthropicAgentSdk();
    const session = query({
      prompt:
        'Implement the changes described in your instructions now. Use Read to inspect existing files, then Write or Edit to apply changes, then Bash for each verification step. Do not output any text or plan before making your first tool call.',
      options: sdkOptions,
    });

    let finalResult: SDKResultMessage | undefined;
    const touchedFiles = new Set<string>();

    console.log(
      chalk.bold.cyan(
        `\n  [claude-agent-sdk] Running agent loop in ${repoDir}...`,
      ),
    );

    try {
      for await (const message of session) {
        if (logProgressMessage(message)) {
          continue;
        }

        if (
          message.type === 'system' &&
          message.subtype === 'files_persisted'
        ) {
          for (const { filename } of message.files) {
            const absolutePath = resolveRepoPath(repoDir, filename);
            touchedFiles.add(path.relative(repoDir, absolutePath));
          }
        }

        const activityMessages = formatActivityMessages(
          message,
          repoDir,
          activityState,
        );
        activityMessages.forEach((activityMessage) =>
          console.log(chalk.cyan(activityMessage)),
        );

        if (message.type !== 'result') {
          continue;
        }

        finalResult = message;
        break;
      }
    } finally {
      session.close();
    }

    // Supplement files_persisted tracking with git-based discovery since
    // the SDK may not emit files_persisted for all writes in acceptEdits mode.
    await discoverChangedFiles(repoDir, touchedFiles);

    if (!finalResult) {
      throw new Error('Claude Agent SDK finished without returning a result.');
    }

    if (finalResult.subtype !== 'success' || finalResult.is_error) {
      const errorSummary =
        'errors' in finalResult && finalResult.errors.length > 0
          ? finalResult.errors.join('; ')
          : 'unknown error';
      throw new Error(
        `Claude Agent SDK failed (${finalResult.subtype}): ${errorSummary}`,
      );
    }

    console.log(
      chalk.green(
        `  [claude-agent-sdk] Agent completed in ${finalResult.num_turns} turn(s).`,
      ),
    );

    const usage = finalResult.usage;
    if (usage) {
      const cachedLabel =
        usage.cache_read_input_tokens != null
          ? ` (${usage.cache_read_input_tokens} cached)`
          : '';
      console.log(
        chalk.cyan(
          `  [${ANTHROPIC_AGENT_LABEL}] Usage: ${usage.input_tokens} input${cachedLabel} / ${usage.output_tokens} output tokens`,
        ),
      );
    }
    if (finalResult.total_cost_usd > 0) {
      console.log(
        chalk.cyan(
          `  [${ANTHROPIC_AGENT_LABEL}] Cost: $${finalResult.total_cost_usd.toFixed(4)} USD`,
        ),
      );
    }

    const summary = finalResult.result.trim();
    if (summary) {
      console.log(chalk.bold('\n  Summary:'));
      summary.split('\n').forEach((line) => {
        if (line.trim()) {
          console.log(chalk.cyan(`    ${line}`));
        }
      });
    }

    if (touchedFiles.size > 0) {
      console.log(chalk.bold('\n  File summary:'));
      [...touchedFiles]
        .sort()
        .forEach((f) => console.log(chalk.cyan(`    - updated: ${f}`)));
    } else {
      console.log(chalk.gray('\n  File summary: no file changes were made.'));
    }

    // Incomplete-work loop: resume the same session so the agent retains
    // full context of what it already did. Stops when all work is done or
    // the workload stops decreasing for 2 consecutive passes.
    let previousWorkload = Infinity;
    let stalledPasses = 0;
    let passNumber = 0;
    let sessionId = finalResult.session_id;

    while (true) {
      const currentUnvisited = repoFiles
        .map((f) => stripRepoPrefix(f, repoName))
        .filter((f) => !touchedFiles.has(f) && !isGlobPattern(f));
      const currentWorkload = currentUnvisited.length;

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
        console.log(
          chalk.yellow(
            `\n  [${ANTHROPIC_AGENT_LABEL}] Workload not decreasing after 2 passes — stopping`,
          ),
        );
        console.log(
          chalk.yellow(
            `  [${ANTHROPIC_AGENT_LABEL}] Remaining: ${currentUnvisited.length} planned file(s) not touched: ${currentUnvisited.join(', ')}`,
          ),
        );
        break;
      }

      passNumber++;
      const iterationModel = modelRoutingResult.defaultModel;

      console.log(
        chalk.yellow(
          `\n  [${ANTHROPIC_AGENT_LABEL}] Pass ${passNumber}: ${currentUnvisited.length} planned file(s) not touched — continuing`,
        ),
      );

      const unvisitedLines = currentUnvisited.map((f) => `- ${f}`).join('\n');
      const continuationPrompt = `Continue implementing the remaining plan steps. The following planned files are still unmodified:\n\n${unvisitedLines}\n\nFor each file listed above, read the full file first, then apply the required changes. After addressing all listed files, verify your work. Do not output any text or plan before making your first tool call.`;

      // Resume the same session so the agent retains conversation context.
      const iterationSession = query({
        prompt: continuationPrompt,
        options: {
          ...sdkOptions,
          model: iterationModel,
          resume: sessionId,
        },
      });

      let iterationResult: SDKResultMessage | undefined;

      try {
        for await (const message of iterationSession) {
          if (logProgressMessage(message)) {
            continue;
          }

          if (
            message.type === 'system' &&
            message.subtype === 'files_persisted'
          ) {
            for (const { filename } of message.files) {
              const absolutePath = resolveRepoPath(repoDir, filename);
              touchedFiles.add(path.relative(repoDir, absolutePath));
            }
          }

          const activityMessages = formatActivityMessages(
            message,
            repoDir,
            activityState,
          );
          activityMessages.forEach((activityMessage) =>
            console.log(chalk.cyan(activityMessage)),
          );

          if (message.type !== 'result') {
            continue;
          }

          iterationResult = message;
          break;
        }
      } finally {
        iterationSession.close();
      }

      await discoverChangedFiles(repoDir, touchedFiles);

      if (!iterationResult) {
        throw new Error(
          `Claude Agent SDK pass ${passNumber + 1} finished without returning a result.`,
        );
      }

      if (iterationResult.subtype !== 'success') {
        const errorSummary =
          'errors' in iterationResult && iterationResult.errors.length > 0
            ? iterationResult.errors.join('; ')
            : 'unknown error';
        throw new Error(
          `Claude Agent SDK pass ${passNumber + 1} failed (${iterationResult.subtype}): ${errorSummary}`,
        );
      }
      if (iterationResult.is_error) {
        console.log(
          chalk.yellow(
            `  [${ANTHROPIC_AGENT_LABEL}] Pass ${passNumber + 1} completed with errors — continuing to next pass`,
          ),
        );
      }

      console.log(
        chalk.green(
          `  [${ANTHROPIC_AGENT_LABEL}] Pass ${passNumber + 1} completed in ${iterationResult.num_turns} turn(s).`,
        ),
      );
      if (iterationResult.total_cost_usd > 0) {
        console.log(
          chalk.cyan(
            `  [${ANTHROPIC_AGENT_LABEL}] Pass ${passNumber + 1} cost: $${iterationResult.total_cost_usd.toFixed(4)} USD`,
          ),
        );
      }

      sessionId = iterationResult.session_id;
    }
  }
}
