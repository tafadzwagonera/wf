// src/integrations/ai/adapters/anthropic-agent.adapter.ts
import { ConfigService } from '@nestjs/config';
import {
  type CanUseTool,
  type SDKResultMessage,
  type Settings,
  type SettingSource,
} from '@anthropic-ai/claude-agent-sdk';
import chalk from 'chalk';
import * as path from 'path';
import type {
  TicketArtifact,
  PlanArtifact,
  ImplementerOptions,
  ImplementerBackend,
  VerificationScript,
} from '../../../agents/interfaces';
import { loadAnthropicAgentSdk } from './load-anthropic-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  resolveModelRouting,
  normalizeCommand,
  buildAllowedCommands,
  stripRepoPrefix,
  isGlobPattern,
  loadClaudeContext,
  discoverChangedFiles,
  buildPlanContext,
} from './shared-routing';

const CLAUDE_CODE_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'TodoWrite', 'Task', 'Agent'] as const;
const DEFAULT_MECHANICAL_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_AGENT_LABEL = 'claude-agent-sdk';
const FALLBACK_VERIFICATION_LABEL = 'verification command';

type ActivityState = {
  lastVerificationCommand?: string;
};

const buildCanUseTool = (allowedCommands: Set<string>, activityState: ActivityState): CanUseTool => {
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
      console.log(chalk.red(`  [${ANTHROPIC_AGENT_LABEL}] Verification denied: ${command}`));
      return {
        behavior: 'deny',
        message: `Bash command "${command}" is not in the verification whitelist. Allowed commands: ${[...allowedCommands].join(', ') || '(none configured)'}.`,
        interrupt: true,
      };
    }

    activityState.lastVerificationCommand = command;
    console.log(chalk.cyan(`  [${ANTHROPIC_AGENT_LABEL}] Verification running: ${command}`));
    return { behavior: 'allow' };
  };
};

const resolveRepoPath = (repoDir: string, rawPath: string): string =>
  path.isAbsolute(rawPath) ? rawPath : path.resolve(repoDir, rawPath);

/**
 * Format a streamed progress event for console output.
 *
 * @param message - The SDK progress message to format
 * @param label - Backend label for the log prefix (defaults to `'claude-agent-sdk'`)
 * @returns A human-readable log line, or null when the message is not progress
 */
export const formatProgressMessage = (message: SDKMessage, label: string = ANTHROPIC_AGENT_LABEL): string | null => {
  if (message.type === 'system' && message.subtype === 'task_progress') {
    const summary = message.summary?.trim() || message.description.trim();
    const lastToolLabel = message.last_tool_name ? ` · last tool: ${message.last_tool_name}` : '';
    return `  [${label}] Task progress: ${summary}${lastToolLabel}`;
  }

  if (message.type === 'tool_progress') {
    const elapsedSeconds = message.elapsed_time_seconds.toFixed(1);
    const taskLabel = message.task_id ? ` · task: ${message.task_id}` : '';
    return `  [${label}] Tool progress: ${message.tool_name} (${elapsedSeconds}s)${taskLabel}`;
  }

  if (message.type === 'system' && message.subtype === 'api_retry') {
    const errorLabel = message.error_status ? `HTTP ${message.error_status}` : 'connection error';
    return `  [${label}] API retry: attempt ${message.attempt}/${message.max_retries} after ${errorLabel} (${message.retry_delay_ms}ms backoff)`;
  }

  if (message.type === 'system' && message.subtype === 'status') {
    if (!message.status) return null;
    return `  [${label}] Status: ${message.status}`;
  }

  if (message.type === 'rate_limit_event') {
    return `  [${label}] Rate limit: updated`;
  }

  if (message.type === 'system' && message.subtype === 'compact_boundary') {
    const meta = message.compact_metadata;
    return `  [${label}] Context compacted (${meta.trigger}, ${meta.pre_tokens} tokens before)`;
  }

  if (message.type === 'system' && message.subtype === 'session_state_changed') {
    return `  [${label}] Session state: ${message.state}`;
  }

  return null;
};

const extractVerificationCommand = (summary: string, fallbackCommand?: string): string => {
  const backtickMatch = summary.match(/`([^`]+)`/);
  if (backtickMatch?.[1]) {
    return backtickMatch[1].trim();
  }

  const quoteMatch = summary.match(/["']([^"']+)["']/);
  if (quoteMatch?.[1]) {
    return quoteMatch[1].trim();
  }

  const ranMatch = summary.match(/(?:ran|run|executed)\s+([a-z0-9:_./@=-]+(?:\s+[a-z0-9:_./@=-]+)*)/i);
  if (ranMatch?.[1]) {
    return ranMatch[1].trim().replace(/[.]+$/, '');
  }

  return fallbackCommand ?? FALLBACK_VERIFICATION_LABEL;
};

const extractVerificationOutcome = (summary: string): 'passed' | 'failed' | null => {
  if (/(failed|failure|exit code [1-9]\d*|non-zero exit|error\b|errors\b)/i.test(summary)) {
    return 'failed';
  }

  if (/(passed|success|succeeded|completed successfully|exit code 0)/i.test(summary)) {
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
  activityState: ActivityState
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

    const command = extractVerificationCommand(message.summary, activityState.lastVerificationCommand);
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

  console.log(isWarning ? chalk.yellow(formattedMessage) : chalk.cyan(formattedMessage));
  return true;
};

export const buildSystemPrompt = ({
  ticketKey,
  repoDir,
  repoName,
  repoFiles,
  contextFiles,
  trackedFilePaths,
  verificationScripts,
  ticketContext,
  planSteps,
  planSummary,
  planRisks,
  planAction,
}: {
  ticketKey: string;
  repoDir: string;
  repoName: string;
  repoFiles: string[];
  contextFiles?: string[];
  trackedFilePaths: string[];
  verificationScripts: VerificationScript[];
  ticketContext: string;
  planSteps: string[];
  planSummary?: string;
  planRisks?: string[];
  planAction?: 'fix' | 'feature' | 'investigate';
}): string => {
  const planContext = buildPlanContext({
    ticketKey,
    repoDir,
    repoName,
    repoFiles,
    contextFiles,
    trackedFilePaths,
    verificationScripts,
    planSteps,
    planSummary,
    planRisks,
    planAction,
  });

  return `${planContext}

Available tools:
- Read(file_path, offset?, limit?): read a file with optional line range
- Write(file_path, content): write a full file into the primary repository only
- Edit(file_path, old_string, new_string): surgically replace a unique string in a file
- Glob(pattern, path?): find files by glob pattern
- Grep(pattern, path?, glob?): search file contents by regex
- Bash(command): run a verification command only if it is on the whitelist

Rules:
- NEVER output free-form text, commentary, or planning at any point during the run. Every response you produce MUST contain at least one tool call. The ONLY exception is the final summary (using the exact template below) which you output after ALL work is done and ALL verification passes. If you feel the urge to describe what you will do next, call a tool instead. Text output without a tool call terminates the run immediately.
- ALWAYS use Edit instead of Write for existing files. Write should only be used for creating new files. Using Write on existing files wastes context on unchanged lines.
- Use Grep to find relevant line numbers, then Read with offset/limit to read only the section you need. Avoid reading entire large files.
- For mechanical migrations (e.g. replacing Logger with PinoLogger across many files): use Grep to find all call sites, then apply Edit to each file without re-reading the full file — the search results show enough context.
- Use Glob to discover file paths instead of guessing.
- Bash is the only way to execute a shell command, and it will reject any command outside the verification whitelist.
- Never invent or call any other shell command tool.
- Never duplicate a function. To add a parameter, modify the existing function signature. To change behavior, edit the existing function body. This applies to constructors, methods, and standalone functions alike.
- Writes must stay scoped to the primary repository (${repoDir}).
- Reads may target ${repoDir} and any configured read-only sibling repositories.
- You MUST implement ALL plan steps listed above. Do not stop after completing only the core infrastructure — continue through every step until all tasks are done.
- Treat the returned progress signal as a heuristic only — never use a 'complete' verdict as a reason to stop. The verdict reflects a single verification command, not overall plan completion.
- Use verification commands as intermediate checkpoints to catch regressions. After each passing verification, check whether ALL plan steps are done. If any migration or refactoring work remains, continue working.
- After verification passes, run Grep to count remaining instances of the patterns you are migrating (e.g. 'new Logger('). If the search returns ANY matches, you MUST continue editing those files — do NOT output a summary or any text. Producing a summary that says "remaining work needed" or "follow-up required" is a failure. Keep calling Edit until the search returns zero matches.
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

Risks and guardrails:
${planRisks && planRisks.length > 0 ? planRisks.map((r, i) => `  ${i + 1}. ${r}`).join('\n') : '  (none identified)'}

Ticket context:
${ticketContext}`;
};

/**
 * Claude Agent SDK-backed implementer backend.
 * The SDK drives the edit loop directly with built-in Read / Write / Edit / Bash
 * tools while this adapter constrains the working directory, filesystem access,
 * and Bash verification commands.
 */
export class AnthropicAgentAdapter implements ImplementerBackend {
  constructor(private configService: ConfigService) {}

  async generateAndVerify(params: {
    ticket: TicketArtifact;
    planArtifact: PlanArtifact;
    options: ImplementerOptions;
    verificationScripts: VerificationScript[];
    ticketContext: string;
    repoFiles: string[];
    contextFiles?: string[];
    repoName: string;
    trackedFilePaths: string[];
  }): Promise<void> {
    const { options, verificationScripts, ticketContext, repoFiles, repoName } = params;

    const repoDir = options.repoDir ?? process.cwd();
    const additionalRepoDirs = options.additionalRepoDirs ?? [];
    const allowedCommands = buildAllowedCommands(verificationScripts);
    const activityState: ActivityState = {};
    const apiKey = this.configService.get<string>('ai.anthropicApiKey');
    const claudeContext = await loadClaudeContext(repoDir);

    if (!apiKey) {
      throw new Error('Anthropic Agent SDK backend requires `ai.anthropicApiKey` to be configured.');
    }

    const fallbackDefaultModel = this.configService.get<string>('ai.model') || 'claude-sonnet-4-6';
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
        claudeMdExcludes: [path.join(repoDir, 'CLAUDE.md'), path.join(repoDir, '.claude', 'CLAUDE.md')],
        autoCompactWindow: 20000,
      } satisfies Settings,
      systemPrompt: {
        type: 'preset' as const,
        preset: 'claude_code' as const,
        append: [
          claudeContext ? `\n\nRepo AI context:\n${claudeContext}` : '',
          `\n\n${buildSystemPrompt({
            ticketKey: params.ticket.ticketKey,
            repoDir,
            repoName,
            repoFiles,
            contextFiles: params.contextFiles,
            trackedFilePaths: params.trackedFilePaths,
            verificationScripts,
            ticketContext,
            planSteps: params.planArtifact.plan.steps,
            planSummary: params.planArtifact.plan.summary,
            planRisks: params.planArtifact.plan.risks,
            planAction: params.planArtifact.plan.action,
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
          allowRead: [resolveRepoPath(repoDir, '.'), ...additionalRepoDirs.map(dir => resolveRepoPath(repoDir, dir))],
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

    console.log(chalk.bold.cyan(`\n  [claude-agent-sdk] Running agent loop in ${repoDir}...`));

    try {
      for await (const message of session) {
        if (logProgressMessage(message)) {
          continue;
        }

        if (message.type === 'system' && message.subtype === 'files_persisted') {
          for (const { filename } of message.files) {
            const absolutePath = resolveRepoPath(repoDir, filename);
            touchedFiles.add(path.relative(repoDir, absolutePath));
          }
        }

        const activityMessages = formatActivityMessages(message, repoDir, activityState);
        activityMessages.forEach(activityMessage => console.log(chalk.cyan(activityMessage)));

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
        'errors' in finalResult && finalResult.errors.length > 0 ? finalResult.errors.join('; ') : 'unknown error';
      throw new Error(`Claude Agent SDK failed (${finalResult.subtype}): ${errorSummary}`);
    }

    console.log(chalk.green(`  [claude-agent-sdk] Agent completed in ${finalResult.num_turns} turn(s).`));

    const usage = finalResult.usage;
    if (usage) {
      const cachedLabel = usage.cache_read_input_tokens != null ? ` (${usage.cache_read_input_tokens} cached)` : '';
      console.log(
        chalk.cyan(
          `  [${ANTHROPIC_AGENT_LABEL}] Usage: ${usage.input_tokens} input${cachedLabel} / ${usage.output_tokens} output tokens`
        )
      );
    }
    if (finalResult.total_cost_usd > 0) {
      console.log(chalk.cyan(`  [${ANTHROPIC_AGENT_LABEL}] Cost: $${finalResult.total_cost_usd.toFixed(4)} USD`));
    }

    const summary = finalResult.result.trim();
    if (summary) {
      console.log(chalk.bold('\n  Summary:'));
      summary.split('\n').forEach(line => {
        if (line.trim()) {
          console.log(chalk.cyan(`    ${line}`));
        }
      });
    }

    if (touchedFiles.size > 0) {
      console.log(chalk.bold('\n  File summary:'));
      [...touchedFiles].sort().forEach(f => console.log(chalk.cyan(`    - updated: ${f}`)));
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
        .map(f => stripRepoPrefix(f, repoName))
        .filter(f => !touchedFiles.has(f) && !isGlobPattern(f));
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
        console.log(chalk.yellow(`\n  [${ANTHROPIC_AGENT_LABEL}] Workload not decreasing after 2 passes — stopping`));
        console.log(
          chalk.yellow(
            `  [${ANTHROPIC_AGENT_LABEL}] Remaining: ${currentUnvisited.length} planned file(s) not touched: ${currentUnvisited.join(', ')}`
          )
        );
        break;
      }

      passNumber++;
      const iterationModel = modelRoutingResult.defaultModel;

      console.log(
        chalk.yellow(
          `\n  [${ANTHROPIC_AGENT_LABEL}] Pass ${passNumber}: ${currentUnvisited.length} planned file(s) not touched — continuing`
        )
      );

      const unvisitedLines = currentUnvisited.map(f => `- ${f}`).join('\n');
      const continuationPrompt = `Continue implementing the remaining plan steps. The following planned files are still unmodified:\n\n${unvisitedLines}\n\nFor each file listed above, read the full file first with Read, then apply Edit to complete the required changes. After addressing all listed files, use Grep to search for any remaining migration patterns and continue editing until zero matches remain. Do not output any text or plan before making your first tool call.`;

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

          if (message.type === 'system' && message.subtype === 'files_persisted') {
            for (const { filename } of message.files) {
              const absolutePath = resolveRepoPath(repoDir, filename);
              touchedFiles.add(path.relative(repoDir, absolutePath));
            }
          }

          const activityMessages = formatActivityMessages(message, repoDir, activityState);
          activityMessages.forEach(activityMessage => console.log(chalk.cyan(activityMessage)));

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
        throw new Error(`Claude Agent SDK pass ${passNumber + 1} finished without returning a result.`);
      }

      if (iterationResult.subtype !== 'success') {
        const errorSummary =
          'errors' in iterationResult && iterationResult.errors.length > 0
            ? iterationResult.errors.join('; ')
            : 'unknown error';
        throw new Error(`Claude Agent SDK pass ${passNumber + 1} failed (${iterationResult.subtype}): ${errorSummary}`);
      }
      if (iterationResult.is_error) {
        console.log(
          chalk.yellow(
            `  [${ANTHROPIC_AGENT_LABEL}] Pass ${passNumber + 1} completed with errors — continuing to next pass`
          )
        );
      }

      console.log(
        chalk.green(
          `  [${ANTHROPIC_AGENT_LABEL}] Pass ${passNumber + 1} completed in ${iterationResult.num_turns} turn(s).`
        )
      );
      if (iterationResult.total_cost_usd > 0) {
        console.log(
          chalk.cyan(
            `  [${ANTHROPIC_AGENT_LABEL}] Pass ${passNumber + 1} cost: $${iterationResult.total_cost_usd.toFixed(4)} USD`
          )
        );
      }

      sessionId = iterationResult.session_id;
    }
  }
}
