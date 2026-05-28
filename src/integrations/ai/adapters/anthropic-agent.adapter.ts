// src/integrations/ai/adapters/anthropic-agent.adapter.ts
import { ConfigService } from '@nestjs/config';
import {
  type CanUseTool,
  type SDKResultMessage,
  type Settings,
  type SettingSource,
} from '@anthropic-ai/claude-agent-sdk';
import chalk from 'chalk';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type {
  TicketArtifact,
  PlanArtifact,
  ImplementerOptions,
  IImplementerBackend,
  VerificationScript,
  ModelRouting,
} from '../../../agents/interfaces';
import type { ResolutionPlan } from '../ai.service';
import { loadAnthropicAgentSdk } from './load-anthropic-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

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

const MECHANICAL_STEP_PATTERNS = [
  /migrate all/i,
  /replace every/i,
  /update each/i,
  /same pattern across/i,
  /rename all/i,
  /add .+ to every/i,
];

/**
 * Detects whether a plan describes a mechanical (repetitive, pattern-based) task.
 *
 * @param plan - The resolution plan to evaluate
 * @returns True when the plan appears mechanical, with a human-readable reason
 */
export const detectMechanicalTask = (
  plan: ResolutionPlan,
): { isMechanical: boolean; reason: string } => {
  const filesCount = plan.filesAffected?.length ?? 0;
  const stepsCount = plan.steps.length;

  for (const step of plan.steps) {
    const matched = MECHANICAL_STEP_PATTERNS.find((pattern) =>
      pattern.test(step),
    );
    if (matched) {
      return {
        isMechanical: true,
        reason: `pattern: "${matched.source}" in step "${step.slice(0, 60)}"`,
      };
    }
  }

  if (stepsCount > 0 && filesCount > 3 && filesCount / stepsCount > 3) {
    return {
      isMechanical: true,
      reason: `high file-to-step ratio: ${filesCount} files / ${stepsCount} steps`,
    };
  }

  if (plan.estimatedComplexity === 'low' && filesCount >= 20) {
    return {
      isMechanical: true,
      reason: `low complexity with ${filesCount} files`,
    };
  }

  return { isMechanical: false, reason: 'creative task' };
};

type ModelRoutingResult = {
  model: string;
  logMessage: string;
};

/**
 * Resolves the model to use based on routing mode, config, and mechanical detection.
 *
 * @param params - Routing context
 * @returns Selected model and an observability log message
 */
const resolveModelRouting = (params: {
  routing: ModelRouting;
  primaryModel: string;
  configService: ConfigService;
  plan: ResolutionPlan;
}): ModelRoutingResult => {
  const { routing, primaryModel, configService, plan } = params;

  const singleModel = configService.get<string>('stages.implement.model');
  const modelsConfig = configService.get<Record<string, string>>(
    'stages.implement.models',
  );

  if (singleModel && modelsConfig) {
    console.log(
      chalk.yellow(
        `  [${ANTHROPIC_AGENT_LABEL}] Warning: both stages.implement.model and stages.implement.models are set. model takes precedence; models is ignored.`,
      ),
    );
  }

  const mechanicalModel = modelsConfig?.mechanical || DEFAULT_MECHANICAL_MODEL;

  if (routing === 'primary') {
    return {
      model: primaryModel,
      logMessage: `[${ANTHROPIC_AGENT_LABEL}] Model routing: ${primaryModel} (primary — user override)`,
    };
  }

  if (routing === 'mechanical') {
    return {
      model: mechanicalModel,
      logMessage: `[${ANTHROPIC_AGENT_LABEL}] Model routing: ${mechanicalModel} (mechanical — user override)`,
    };
  }

  // auto mode: detect from plan
  const detection = detectMechanicalTask(plan);
  if (detection.isMechanical) {
    return {
      model: mechanicalModel,
      logMessage: `[${ANTHROPIC_AGENT_LABEL}] Model routing: ${mechanicalModel} (auto — mechanical: ${detection.reason})`,
    };
  }

  return {
    model: primaryModel,
    logMessage: `[${ANTHROPIC_AGENT_LABEL}] Model routing: ${primaryModel} (auto — creative: ${detection.reason})`,
  };
};

type ActivityState = {
  lastVerificationCommand?: string;
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

const resolveRepoPath = (repoDir: string, rawPath: string): string =>
  path.isAbsolute(rawPath) ? rawPath : path.resolve(repoDir, rawPath);

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
- Use Read to inspect existing file contents before modifying them
- Use Write or Edit to write complete updated file contents
- Use Bash only for verification commands that appear in the verification whitelist
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

    const primaryModel =
      this.configService.get<string>('stages.implement.model') ||
      this.configService.get<string>('ai.model') ||
      'claude-sonnet-4-6';
    const routing = options.modelRouting ?? 'auto';
    const modelRoutingResult = resolveModelRouting({
      routing,
      primaryModel,
      configService: this.configService,
      plan: params.planArtifact.plan,
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
    } else {
      console.log(chalk.gray('\n  File summary: no file changes were made.'));
    }
  }
}
