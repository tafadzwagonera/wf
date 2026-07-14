import { ConfigService } from '@nestjs/config';
import chalk from 'chalk';
import * as path from 'path';
import type {
  TicketArtifact,
  PlanArtifact,
  ImplementerOptions,
  ImplementerBackend,
  VerificationScript,
} from '../../../agents/interfaces';
import {
  resolveModelRouting,
  stripRepoPrefix,
  isGlobPattern,
  loadClaudeContext,
  discoverChangedFiles,
} from './shared-routing';
import { buildSystemPrompt, formatProgressMessage, formatActivityMessages } from './anthropic-agent.adapter';
import { assertClaudeCliAvailable, buildCliArgs, spawnCli, type ClaudeCliMessage } from './claude-cli-runner';

const DEFAULT_MECHANICAL_MODEL = 'claude-haiku-4-5-20251001';
const CLI_ADAPTER_LABEL = 'claude-cli';
const IMPLEMENT_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Skill'];

type ActivityState = {
  lastVerificationCommand?: string;
};

/**
 * Claude CLI headless mode (`claude -p`) implementer backend.
 * Spawns the Claude CLI as a subprocess with `--permission-mode acceptEdits`
 * and streams NDJSON progress messages.
 */
export class ClaudeCliAdapter implements ImplementerBackend {
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
  }): Promise<{ sessionId?: string }> {
    const { options, verificationScripts, ticketContext, repoFiles, repoName } = params;

    const repoDir = options.repoDir ?? process.cwd();
    const additionalRepoDirs = options.additionalRepoDirs ?? [];

    assertClaudeCliAvailable();

    const fallbackDefaultModel = this.configService.get<string>('ai.model') || 'claude-sonnet-4-6';
    const routing = options.modelRouting ?? 'auto';
    const modelRoutingResult = resolveModelRouting({
      routing,
      fallbackDefaultModel,
      defaultMechanicalModel: DEFAULT_MECHANICAL_MODEL,
      configService: this.configService,
      plan: params.planArtifact.plan,
      adapterLabel: CLI_ADAPTER_LABEL,
    });
    const model = modelRoutingResult.model;
    console.log(chalk.cyan(`  ${modelRoutingResult.logMessage}`));

    const claudeContext = await loadClaudeContext(repoDir);
    const systemPrompt = buildSystemPrompt({
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
    });

    const priorStagePreamble = params.options.priorStageSummary
      ? `<prior-stage-context>\n${params.options.priorStageSummary}\n</prior-stage-context>\n\nNote: The above is background context from a previous workflow stage.\nYour current stage's instructions take precedence over any conflicting details above.`
      : '';
    const appendSystemPrompt = [
      priorStagePreamble,
      claudeContext ? `Repo AI context:\n${claudeContext}` : '',
      systemPrompt,
    ]
      .filter(Boolean)
      .join('\n\n');

    const implementPrompt
      = 'Implement the changes described in your instructions now. Use Read to inspect existing files, then Write or Edit to apply changes, then Bash for each verification step. Do not output any text or plan before making your first tool call.';
    const cliArgs = buildCliArgs({
      prompt: implementPrompt,
      appendSystemPrompt,
      model,
      cwd: repoDir,
      tools: IMPLEMENT_TOOLS,
      permissionMode: 'acceptEdits',
      addDirs: additionalRepoDirs.length > 0 ? additionalRepoDirs : undefined,
      sessionId: params.options.resumeProviderSessionId,
    });

    console.log(chalk.bold.cyan(`\n  [${CLI_ADAPTER_LABEL}] Running CLI agent in ${repoDir}...`));

    const touchedFiles = new Set<string>();
    const activityState: ActivityState = {};
    let sessionId: string | undefined = params.options.resumeProviderSessionId;

    for await (const message of spawnCli(cliArgs, repoDir, implementPrompt)) {
      this.logCliMessage(message, repoDir, activityState, touchedFiles);

      if (message.session_id) {
        sessionId = message.session_id;
      }

      if (message.files) {
        for (const { filename } of message.files) {
          const absolutePath = path.isAbsolute(filename) ? filename : path.resolve(repoDir, filename);
          touchedFiles.add(path.relative(repoDir, absolutePath));
        }
      }

      if (message.type === 'result') {
        if (message.is_error) {
          throw new Error(`Claude CLI failed: ${message.result ?? 'unknown error'}`);
        }

        const summary = message.result?.trim();
        if (summary) {
          console.log(chalk.bold('\n  Summary:'));
          summary.split('\n').forEach(line => {
            if (line.trim()) {
              console.log(chalk.cyan(`    ${line}`));
            }
          });
        }

        if (message.num_turns) {
          console.log(chalk.green(`  [${CLI_ADAPTER_LABEL}] Completed in ${message.num_turns} turn(s).`));
        }
        if (message.total_cost_usd && message.total_cost_usd > 0) {
          console.log(chalk.cyan(`  [${CLI_ADAPTER_LABEL}] Cost: $${message.total_cost_usd.toFixed(4)} USD`));
        }
        if (sessionId) {
          console.log(chalk.cyan(`  [${CLI_ADAPTER_LABEL}] Provider session: ${sessionId}`));
        }
      }
    }

    await discoverChangedFiles(repoDir, touchedFiles);

    // Continuation loop for untouched files
    let previousWorkload = Infinity;
    let stalledPasses = 0;
    let passNumber = 0;

    while (sessionId) {
      const currentUnvisited = repoFiles
        .map(f => stripRepoPrefix(f, repoName))
        .filter(f => !touchedFiles.has(f) && !isGlobPattern(f));
      const currentWorkload = currentUnvisited.length;

      if (currentWorkload === 0) break;

      if (currentWorkload < previousWorkload) {
        stalledPasses = 0;
      } else {
        stalledPasses++;
      }
      previousWorkload = currentWorkload;

      if (stalledPasses >= 2) {
        console.log(chalk.yellow(`\n  [${CLI_ADAPTER_LABEL}] Workload not decreasing after 2 passes — stopping`));
        console.log(
          chalk.yellow(
            `  [${CLI_ADAPTER_LABEL}] Remaining: ${currentUnvisited.length} planned file(s) not touched: ${currentUnvisited.join(', ')}`
          )
        );
        break;
      }

      passNumber++;
      console.log(
        chalk.yellow(
          `\n  [${CLI_ADAPTER_LABEL}] Pass ${passNumber}: ${currentUnvisited.length} planned file(s) not touched — continuing`
        )
      );

      const unvisitedLines = currentUnvisited.map(f => `- ${f}`).join('\n');
      const continuationPrompt = `Continue implementing the remaining plan steps. The following planned files are still unmodified:\n\n${unvisitedLines}\n\nFor each file listed above, read the full file first with Read, then apply Edit to complete the required changes. After addressing all listed files, use Grep to search for any remaining migration patterns and continue editing until zero matches remain. Do not output any text or plan before making your first tool call.`;

      const continueArgs = buildCliArgs({
        prompt: continuationPrompt,
        appendSystemPrompt,
        model: modelRoutingResult.defaultModel,
        cwd: repoDir,
        sessionId,
        tools: IMPLEMENT_TOOLS,
        permissionMode: 'acceptEdits',
        addDirs: additionalRepoDirs.length > 0 ? additionalRepoDirs : undefined,
      });

      for await (const message of spawnCli(continueArgs, repoDir, continuationPrompt)) {
        this.logCliMessage(message, repoDir, activityState, touchedFiles);

        if (message.session_id) {
          sessionId = message.session_id;
        }

        if (message.files) {
          for (const { filename } of message.files) {
            const absolutePath = path.isAbsolute(filename) ? filename : path.resolve(repoDir, filename);
            touchedFiles.add(path.relative(repoDir, absolutePath));
          }
        }

        if (message.type === 'result') {
          if (message.is_error) {
            console.log(chalk.yellow(`  [${CLI_ADAPTER_LABEL}] Pass ${passNumber} completed with errors — continuing`));
          } else {
            console.log(
              chalk.green(
                `  [${CLI_ADAPTER_LABEL}] Pass ${passNumber} completed in ${message.num_turns ?? '?'} turn(s).`
              )
            );
          }
          if (message.total_cost_usd && message.total_cost_usd > 0) {
            console.log(
              chalk.cyan(`  [${CLI_ADAPTER_LABEL}] Pass ${passNumber} cost: $${message.total_cost_usd.toFixed(4)} USD`)
            );
          }
        }
      }

      await discoverChangedFiles(repoDir, touchedFiles);
    }

    if (touchedFiles.size > 0) {
      console.log(chalk.bold('\n  File summary:'));
      [...touchedFiles].sort().forEach(f => console.log(chalk.cyan(`    - updated: ${f}`)));
    } else {
      console.log(chalk.gray('\n  File summary: no file changes were made.'));
    }

    return { sessionId };
  }

  private logCliMessage(
    message: ClaudeCliMessage,
    repoDir: string,
    activityState: ActivityState,
    touchedFiles?: Set<string>
  ): void {
    // Skill tool invocations surface via task_progress with last_tool_name
    if (message.type === 'system' && message.subtype === 'task_progress' && message.last_tool_name === 'Skill') {
      const raw = message.summary ?? message.description;
      const summary = (typeof raw === 'string' ? raw : '').trim();
      if (summary) {
        console.log(chalk.gray(`  [${CLI_ADAPTER_LABEL}] Skill: ${summary}`));
      }
      return;
    }

    // SDK-compatible progress events (rate_limit_event, system:status, etc.)
    const progressLine = formatProgressMessage(message as never);
    if (progressLine) {
      const label = progressLine.replace(/\[claude-agent-sdk\]/, `[${CLI_ADAPTER_LABEL}]`);
      const isWarning
        = (message.type === 'system' && message.subtype === 'api_retry')
          || (message.type === 'system' && message.subtype === 'status');
      console.log(isWarning ? chalk.yellow(label) : chalk.cyan(label));
      return;
    }

    // SDK-compatible activity events (files_persisted, tool_use_summary)
    const activityLines = formatActivityMessages(message as never, repoDir, activityState);
    if (activityLines.length > 0) {
      for (const line of activityLines) {
        const label = line.replace(/\[claude-agent-sdk\]/, `[${CLI_ADAPTER_LABEL}]`);
        console.log(chalk.cyan(label));
      }
      return;
    }

    // CLI-specific: parse assistant messages for tool_use activity
    if (message.type === 'assistant') {
      this.logCliAssistantMessage(message, repoDir, activityState, touchedFiles);
      return;
    }

    // CLI-specific: parse user messages for tool_result (verification output)
    if (message.type === 'user') {
      this.logCliToolResult(message, activityState);
    }
  }

  private logCliAssistantMessage(
    message: ClaudeCliMessage,
    repoDir: string,
    activityState: ActivityState,
    touchedFiles?: Set<string>
  ): void {
    const innerMessage = message.message as
      | {
        content?: Array<{
          type: string;
          name?: string;
          input?: Record<string, unknown>;
        }>;
      }
      | undefined;
    const contentBlocks = innerMessage?.content;
    if (!Array.isArray(contentBlocks)) return;

    for (const block of contentBlocks) {
      if (block.type !== 'tool_use' || !block.name) continue;

      const toolName = block.name;
      const input = block.input ?? {};

      if (toolName === 'Write' || toolName === 'Edit') {
        const filePath = typeof input['file_path'] === 'string' ? input['file_path'] : '';
        if (filePath) {
          const relativePath = path.isAbsolute(filePath) ? path.relative(repoDir, filePath) : filePath;
          console.log(
            chalk.cyan(`  [${CLI_ADAPTER_LABEL}] File ${toolName === 'Write' ? 'created' : 'updated'}: ${relativePath}`)
          );
          touchedFiles?.add(relativePath);
        }
        continue;
      }

      if (toolName === 'Bash') {
        const command = typeof input['command'] === 'string' ? input['command'].trim() : '';
        if (command) {
          activityState.lastVerificationCommand = command;
          console.log(chalk.cyan(`  [${CLI_ADAPTER_LABEL}] Verification running: ${command}`));
        }
        continue;
      }

      if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
        let target = '';
        if (typeof input['file_path'] === 'string') target = input['file_path'];
        else if (typeof input['pattern'] === 'string') target = input['pattern'];
        if (target) {
          const shortTarget = target.length > 60 ? `${target.slice(0, 57)}...` : target;
          console.log(chalk.gray(`  [${CLI_ADAPTER_LABEL}] ${toolName}: ${shortTarget}`));
        }
        continue;
      }

      if (toolName === 'Skill') {
        const skillName = typeof input['skill'] === 'string' ? input['skill'] : '';
        if (skillName) {
          console.log(chalk.gray(`  [${CLI_ADAPTER_LABEL}] Skill: ${skillName}`));
        }
        continue;
      }
    }
  }

  private logCliToolResult(message: ClaudeCliMessage, activityState: ActivityState): void {
    const innerMessage = message.message as
      | {
        content?: Array<{
          type: string;
          content?: string;
          is_error?: boolean;
          tool_use_id?: string;
        }>;
      }
      | undefined;
    const contentBlocks = innerMessage?.content;
    if (!Array.isArray(contentBlocks)) return;

    for (const block of contentBlocks) {
      if (block.type !== 'tool_result') continue;

      const content = typeof block.content === 'string' ? block.content : '';
      if (!content || !activityState.lastVerificationCommand) continue;

      const hasFailure = /(failed|failure|exit code [1-9]\d*|non-zero exit|error\b|errors\b)/i.test(content);
      const hasSuccess = /(passed|success|succeeded|completed successfully|exit code 0)/i.test(content);

      if (block.is_error || hasFailure) {
        console.log(
          chalk.red(`  [${CLI_ADAPTER_LABEL}] Verification failed: ${activityState.lastVerificationCommand}`)
        );
        activityState.lastVerificationCommand = undefined;
        continue;
      }

      if (hasSuccess) {
        console.log(
          chalk.green(`  [${CLI_ADAPTER_LABEL}] Verification passed: ${activityState.lastVerificationCommand}`)
        );
        activityState.lastVerificationCommand = undefined;
      }
    }
  }
}
