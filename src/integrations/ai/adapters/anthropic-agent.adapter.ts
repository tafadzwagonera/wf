// src/integrations/ai/adapters/anthropic-agent.adapter.ts
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type {
  TicketArtifact,
  PlanArtifact,
  ImplementerOptions,
  IImplementerBackend,
  VerificationScript,
} from '../../../agents/interfaces';

const execAsync = promisify(exec);

/**
 * Experimental Anthropic Agent SDK adapter for the implementer stage.
 * The model drives its own inner loop via read_file, write_file, and run_command
 * tools, iterating until verification passes.
 *
 * Read scope:  repoDir + all additionalRepoDirs
 * Write scope: repoDir only
 * Commands:    verification whitelist, cwd = repoDir
 */
export class AnthropicAgentAdapter implements IImplementerBackend {
  private client: Anthropic;

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('ai.anthropicApiKey');
    this.client = new Anthropic({ apiKey: apiKey || undefined });
  }

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
    const allReadRoots = [repoDir, ...additionalRepoDirs];
    const allowedCommands = new Set(verificationScripts.map((s) => s.command));

    const model =
      this.configService.get<string>('stages.implement.model') ||
      this.configService.get<string>('ai.model') ||
      'claude-sonnet-4-6';
    const absoluteMaxAttempts =
      this.configService.get<number>(
        'stages.implement.afterImplement.absoluteMaxAttempts',
      ) ?? 5;

    // ── Tool definitions ──────────────────────────────────────────────────

    const tools: Anthropic.Tool[] = [
      {
        name: 'read_file',
        description:
          'Read the contents of a file. Allowed paths: repoDir and any additionalRepoDirs.',
        input_schema: {
          type: 'object' as const,
          properties: {
            path: {
              type: 'string',
              description: 'Absolute or repoDir-relative path to the file',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'write_file',
        description:
          'Write content to a file. Allowed paths: repoDir only (writes are not permitted in additionalRepoDirs).',
        input_schema: {
          type: 'object' as const,
          properties: {
            path: {
              type: 'string',
              description: 'Absolute or repoDir-relative path to the file',
            },
            content: {
              type: 'string',
              description: 'Full file content to write',
            },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'run_command',
        description:
          'Run a verification command from the configured whitelist. cwd = repoDir.',
        input_schema: {
          type: 'object' as const,
          properties: {
            command: {
              type: 'string',
              description: `Exact command to run. Allowed: ${[...allowedCommands].join(', ') || '(none configured)'}`,
            },
          },
          required: ['command'],
        },
      },
    ];

    // ── Tool execution ────────────────────────────────────────────────────

    const resolveReadPath = (rawPath: string): string => {
      const abs = path.isAbsolute(rawPath)
        ? rawPath
        : path.resolve(repoDir, rawPath);
      const inAnyRoot = allReadRoots.some(
        (root) => !path.relative(root, abs).startsWith('..'),
      );
      if (!inAnyRoot) {
        throw new Error(
          `read_file path-escape: "${rawPath}" is outside all known repo roots.`,
        );
      }
      return abs;
    };

    const resolveWritePath = (rawPath: string): string => {
      const abs = path.isAbsolute(rawPath)
        ? rawPath
        : path.resolve(repoDir, rawPath);
      if (path.relative(repoDir, abs).startsWith('..')) {
        throw new Error(
          `write_file write-boundary: "${rawPath}" is outside repoDir "${repoDir}".`,
        );
      }
      return abs;
    };

    const executeTool = async (
      toolName: string,
      toolInput: Record<string, unknown>,
    ): Promise<string> => {
      if (toolName === 'read_file') {
        const rawPath = toolInput['path'] as string;
        const abs = resolveReadPath(rawPath);
        if (!fs.existsSync(abs)) {
          return `(file not found: ${rawPath})`;
        }
        return fs.readFileSync(abs, 'utf-8');
      }

      if (toolName === 'write_file') {
        const rawPath = toolInput['path'] as string;
        const content = toolInput['content'] as string;
        const abs = resolveWritePath(rawPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf-8');
        console.log(chalk.green(`    ✓ [agent] wrote: ${rawPath}`));
        return `OK: wrote ${rawPath}`;
      }

      if (toolName === 'run_command') {
        const command = toolInput['command'] as string;
        if (!allowedCommands.has(command)) {
          throw new Error(
            `run_command blocked: "${command}" is not in the verification whitelist.`,
          );
        }
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd: repoDir,
            maxBuffer: 1024 * 1024 * 10,
          });
          return (
            [stdout.trim(), stderr.trim()].filter(Boolean).join('\n') || 'OK'
          );
        } catch (err: any) {
          return [
            `Exit code: ${err.code ?? 1}`,
            err.stdout?.trim?.() ?? '',
            err.stderr?.trim?.() ?? err.message ?? '',
          ]
            .filter(Boolean)
            .join('\n');
        }
      }

      return `Unknown tool: ${toolName}`;
    };

    // ── System prompt ─────────────────────────────────────────────────────

    const fileList = repoFiles
      .map((f) => {
        const rel =
          repoName && f.startsWith(`${repoName}/`)
            ? f.slice(repoName.length + 1)
            : f;
        return `  - ${rel}`;
      })
      .join('\n');

    const verificationList = verificationScripts
      .map((s) => `  - ${s.command}`)
      .join('\n');

    const systemPrompt = `You are an expert software engineer implementing code changes inside a repository.

Repository directory: ${repoDir}
Files to implement:
${fileList || '  (none listed)'}

Verification commands (run these to check your work):
${verificationList || '  (none configured)'}

Rules:
- Use read_file to inspect existing file contents before modifying them
- Use write_file to write complete updated file contents
- Use run_command to run verification commands
- Writes are allowed only within the primary repository (${repoDir})
- Reads are allowed from: ${allReadRoots.join(', ')}
- When all verification commands pass (exit 0), stop and do not make further changes
- Return ONLY the complete file content when writing — no explanation, no markdown fences`;

    const userPrompt = sceneContext;

    // ── Agent loop ────────────────────────────────────────────────────────

    let messages: Anthropic.MessageParam[] = [
      { role: 'user', content: userPrompt },
    ];

    console.log(
      chalk.bold.cyan(
        `\n  [experimental agent] Running agent loop (max ${absoluteMaxAttempts} turns)...`,
      ),
    );

    for (let turn = 0; turn < absoluteMaxAttempts; turn++) {
      const response = await this.client.messages.create({
        model,
        max_tokens: 8192,
        system: systemPrompt,
        tools,
        messages,
      });

      if (response.stop_reason === 'end_turn') {
        console.log(
          chalk.green(
            `  [experimental agent] Agent completed in ${turn + 1} turn(s).`,
          ),
        );
        break;
      }

      if (response.stop_reason !== 'tool_use') {
        console.log(
          chalk.yellow(
            `  [experimental agent] Unexpected stop_reason: ${response.stop_reason}. Ending loop.`,
          ),
        );
        break;
      }

      // Collect tool results
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        console.log(
          chalk.gray(
            `    [agent] tool: ${block.name}(${JSON.stringify(block.input).slice(0, 80)}...)`,
          ),
        );
        let result: string;
        try {
          result = await executeTool(
            block.name,
            block.input as Record<string, unknown>,
          );
        } catch (err) {
          result = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
          console.log(chalk.red(`    [agent] ${result}`));
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result,
        });
      }

      messages = [
        ...messages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: toolResults },
      ];
    }

    // Branch was already created by ImplementerAgent.execute() before this is called.
  }
}
