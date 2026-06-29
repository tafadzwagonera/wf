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
import { resolveModelRouting, discoverChangedFiles } from './shared-routing';
import { buildSystemPrompt } from './anthropic-agent.adapter';
import { assertCodexCliAvailable, buildCodexCliArgs, spawnCodex, type CodexCliMessage } from './codex-cli-runner';

const DEFAULT_MECHANICAL_MODEL = 'gpt-4.1-mini';
const CODEX_ADAPTER_LABEL = 'codex-cli';
/**
 * Codex CLI headless mode implementer backend.
 * Spawns the Codex CLI as a subprocess and streams progress messages.
 */
export class CodexCliAdapter implements ImplementerBackend {
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

    assertCodexCliAvailable();

    const fallbackDefaultModel = this.configService.get<string>('ai.model') || 'gpt-4.1';
    const routing = options.modelRouting ?? 'auto';
    const modelRoutingResult = resolveModelRouting({
      routing,
      fallbackDefaultModel,
      defaultMechanicalModel: DEFAULT_MECHANICAL_MODEL,
      configService: this.configService,
      plan: params.planArtifact.plan,
      adapterLabel: CODEX_ADAPTER_LABEL,
    });
    const model = modelRoutingResult.model;
    console.log(chalk.cyan(`  ${modelRoutingResult.logMessage}`));

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
      ? `<prior-stage-context>\n${params.options.priorStageSummary}\n</prior-stage-context>\n\nNote: The above is background context from a previous workflow stage.\nYour current stage's instructions take precedence over any conflicting details above.\n\n`
      : '';

    // Codex CLI doesn't have --append-system-prompt, so we prepend to the prompt
    const implementPrompt = `${priorStagePreamble}${systemPrompt}\n\nImplement the changes described above now. Read existing files, apply changes, and run each verification step.`;

    const cliArgs = buildCodexCliArgs({
      prompt: implementPrompt,
      model,
      cwd: repoDir,
      permissionMode: 'full-auto',
    });

    console.log(chalk.bold.cyan(`\n  [${CODEX_ADAPTER_LABEL}] Running Codex CLI agent in ${repoDir}...`));

    const touchedFiles = new Set<string>();
    let sessionId: string | undefined;

    for await (const message of spawnCodex(cliArgs, repoDir, implementPrompt)) {
      this.logCodexMessage(message, repoDir, touchedFiles);

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
          throw new Error(`Codex CLI failed: ${message.result ?? 'unknown error'}`);
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
      }
    }

    await discoverChangedFiles(repoDir, touchedFiles);

    if (touchedFiles.size > 0) {
      console.log(chalk.bold(`\n  Files touched (${touchedFiles.size}):`));
      for (const f of touchedFiles) {
        console.log(chalk.gray(`    ${f}`));
      }
    }

    if (sessionId) {
      console.log(chalk.gray(`  [${CODEX_ADAPTER_LABEL}] Provider session: ${sessionId}`));
    }
  }

  private logCodexMessage(message: CodexCliMessage, repoDir: string, touchedFiles: Set<string>): void {
    if (message.type === 'system' && message.summary) {
      console.log(chalk.gray(`  [${CODEX_ADAPTER_LABEL}] ${message.summary}`));
    }

    if (message.tool_name) {
      console.log(chalk.gray(`  [${CODEX_ADAPTER_LABEL}] Tool: ${message.tool_name}`));
    }

    // Track files from tool_use blocks to catch mutations committed mid-session
    if (message.type === 'assistant') {
      const innerMessage = message.message as
        | { content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }> }
        | undefined;
      const blocks = innerMessage?.content;
      if (!Array.isArray(blocks)) return;

      for (const block of blocks) {
        if (block.type !== 'tool_use' || !block.name) continue;
        const input = block.input ?? {};

        if (block.name === 'write' || block.name === 'edit' || block.name === 'Write' || block.name === 'Edit') {
          const filePath =
            typeof input['file_path'] === 'string'
              ? input['file_path']
              : typeof input['path'] === 'string'
                ? input['path']
                : '';
          if (filePath) {
            const relativePath = path.isAbsolute(filePath) ? path.relative(repoDir, filePath) : filePath;
            touchedFiles.add(relativePath);
            console.log(chalk.cyan(`  [${CODEX_ADAPTER_LABEL}] File updated: ${relativePath}`));
          }
        }
      }
    }
  }
}
