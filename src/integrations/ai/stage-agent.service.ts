import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Agent, OpenAIProvider, Runner, tool } from '@openai/agents';
import type { StreamedRunResult } from '@openai/agents';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import dayjs from 'dayjs';
import { loadAnthropicAgentSdk } from './adapters/load-anthropic-agent-sdk';
import { loadAiContextConfig } from './adapters/load-ai-context-config';
import {
  CodeReview,
  parseJsonResponse,
  ResolutionPlan,
  sanitizeCodeReviewTrace,
} from './ai.service';
import { AIError } from '../../shared/utils/errors';

const execAsync = promisify(exec);
const MAX_BUFFER_IN_BYTES = 1024 * 1024 * 4;
// These are last-resort defaults only. Stage-level model config and `ai.model`
// both win before the service falls back to provider-specific read-only models.
const READ_ONLY_OPENAI_MODEL = 'gpt-5.4-mini';
const READ_ONLY_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_STAGE_TOOLS = ['Read', 'Glob', 'Grep', 'Bash'] as const;
const ALLOWED_READ_ONLY_COMMAND_PREFIXES = [
  'pwd',
  'ls',
  'find ',
  'rg ',
  'sed -n ',
  'cat ',
  'wc -l ',
  'git status',
  'git diff',
];

type AgentStageName = 'plan' | 'review' | 'generate';

type OpenAiStageContext = {
  repoDir: string;
};

const resolveStagePromptRepoExample = (repositories?: string[]): string => {
  const firstRepository = repositories?.find(
    (repository) => typeof repository === 'string' && repository.trim(),
  );
  return firstRepository?.trim() || 'current-repo';
};

const isReadOnlyCommand = (command: string): boolean =>
  ALLOWED_READ_ONLY_COMMAND_PREFIXES.some(
    (prefix) => command === prefix || command.startsWith(prefix),
  );

@Injectable()
export class StageAgentService {
  constructor(private readonly configService: ConfigService) {}

  isEnabledForStage(stage: AgentStageName): boolean {
    return (
      this.configService.get<boolean>(`stages.${stage}.agent`, false) === true
    );
  }

  async generatePlan(params: {
    action: 'fix' | 'feature' | 'investigate';
    issueContent: string;
    ticketKey?: string;
    affectedRepositories?: string[];
  }): Promise<ResolutionPlan> {
    const repoExample = resolveStagePromptRepoExample(
      params.affectedRepositories,
    );
    const prompt = `
Action: ${params.action}
Issue Content:
${params.issueContent}

Context:
${JSON.stringify(
  {
    ticketKey: params.ticketKey,
    summary: params.ticketKey,
    affectedRepositories: params.affectedRepositories,
  },
  null,
  2,
)}

Create a detailed resolution plan with:
1. A brief summary of the issue and proposed solution
2. Specific, actionable steps to ${params.action} the issue
3. Estimated complexity (low/medium/high)
4. Files that will be affected — prefix EVERY path with its repository name
5. Potential risks or considerations
6. Repositories that will be affected (if known)
7. Task-specific verification only when needed

Return ONLY a valid JSON object with these fields:
{
  "action": "${params.action}",
  "summary": "...",
  "steps": ["step 1", "step 2"],
  "estimatedComplexity": "low|medium|high",
  "filesAffected": ["${repoExample}/src/path/to/file.ts"],
  "repositoriesAffected": ["${repoExample}"],
  "risks": ["risk 1"],
  "verification": {
    "targeted": [
      {
        "id": "manual-review",
        "run": "npm run test:manual -- test-issue-review",
        "policy": "enforced",
        "reason": "Explain what this check covers"
      }
    ],
    "waivers": [
      {
        "id": "e2e",
        "reason": "Explain why this repo-level baseline check is waived"
      }
    ]
  }
}`;

    const systemPrompt = `You are an expert software engineer creating detailed resolution plans.
You may inspect repository files with read-only tools before answering.
Return your response as a JSON object matching the ResolutionPlan interface.`;

    const response = await this.runStagePrompt({
      stage: 'plan',
      prompt,
      systemPrompt,
    });

    try {
      const plan = parseJsonResponse<ResolutionPlan>(response);
      const provider = this.resolveStageProvider('plan');
      const model = this.resolveStageModel('plan');
      const prefixMap: Record<string, string> = {
        anthropic: 'claude-',
        google: 'gemini-',
        deepseek: 'deepseek-',
        openai: 'gpt-',
      };
      const prefix = prefixMap[provider] ?? '';
      const source = model.startsWith(prefix)
        ? model.slice(prefix.length)
        : model;

      plan.provider = provider;
      plan.source = source;
      plan.timestamp = dayjs().toISOString();
      return plan;
    } catch (error) {
      throw new AIError('Failed to parse resolution plan from agent response', {
        response,
        error,
      });
    }
  }

  async reviewCode(diff: string, guidelines: string[]): Promise<CodeReview> {
    const prompt = `
Code Changes:
\`\`\`
${diff.substring(0, 5000)} ${diff.length > 5000 ? '...(truncated)' : ''}
\`\`\`

Review Guidelines:
${guidelines.map((g, i) => `${i + 1}. ${g}`).join('\n')}

Provide a code review with:
1. A brief summary of the changes
2. Any issues found
3. A trace provenance label: evidence-based, best-effort, or unavailable
4. A tree-like call stack that walks the changed code path
5. A JSON-like state transition object for the changed code path
6. Suggestions for improvement
7. Whether the code is approved

Return ONLY a valid JSON object:
{
  "summary": "...",
  "issues": [
    {
      "severity": "error|warning|info",
      "message": "...",
      "file": "optional",
      "line": 12
    }
  ],
  "traceProvenance": "evidence-based|best-effort|unavailable",
  "callStack": ["step 1", "step 2"],
  "stateTransition": {
    "from": "state-a",
    "to": "state-b",
    "steps": [{ "state": "state-a", "next": "state-b" }]
  },
  "suggestions": ["suggestion 1"],
  "approved": true
}`;

    const systemPrompt = `You are an expert code reviewer providing constructive feedback.
You may inspect repository files with read-only tools before answering.
Focus on code quality, bugs, security, and the changed execution path.
Ignore JSON or markdown files under .wf/ and platform artifact directories.`;

    const response = await this.runStagePrompt({
      stage: 'review',
      prompt,
      systemPrompt,
    });

    try {
      const parsed = parseJsonResponse<CodeReview>(response);
      return {
        ...sanitizeCodeReviewTrace(parsed, diff),
        executionMode: 'agent',
      };
    } catch (error) {
      throw new AIError('Failed to parse code review from agent response', {
        response,
        error,
      });
    }
  }

  async generateFromPrompt(prompt: string): Promise<string> {
    const systemPrompt = `You are an expert technical writer and repository analyst.
You may inspect repository files with read-only tools before answering.
Return only the requested ticket markdown and preserve the required heading structure exactly.`;

    return this.runStagePrompt({
      stage: 'generate',
      prompt,
      systemPrompt,
    });
  }

  private resolveStageProvider(stage: AgentStageName): 'anthropic' | 'openai' {
    const provider =
      this.configService.get<string>(`stages.${stage}.provider`) ??
      this.configService.get<string>('ai.provider', 'anthropic');
    if (provider !== 'anthropic' && provider !== 'openai') {
      throw new Error(
        `${stage} stage agent backend is unsupported for provider "${provider}". Configure ${stage}.provider as anthropic or openai, or disable stages.${stage}.agent.`,
      );
    }
    return provider;
  }

  private resolveStageModel(stage: AgentStageName): string {
    return (
      this.configService.get<string>(`stages.${stage}.model`) ??
      this.configService.get<string>('ai.model') ??
      (this.resolveStageProvider(stage) === 'openai'
        ? READ_ONLY_OPENAI_MODEL
        : READ_ONLY_ANTHROPIC_MODEL)
    );
  }

  private async runStagePrompt(params: {
    stage: AgentStageName;
    prompt: string;
    systemPrompt: string;
  }): Promise<string> {
    const provider = this.resolveStageProvider(params.stage);
    if (provider === 'anthropic') {
      return this.runAnthropicStagePrompt(params);
    }

    return this.runOpenAiStagePrompt(params);
  }

  private async runAnthropicStagePrompt(params: {
    stage: AgentStageName;
    prompt: string;
    systemPrompt: string;
  }): Promise<string> {
    const apiKey = this.configService.get<string>('ai.anthropicApiKey');
    if (!apiKey) {
      throw new Error(
        'Anthropic agent backend requires `ai.anthropicApiKey` to be configured.',
      );
    }

    const model = this.resolveStageModel(params.stage);
    const anthropicContext = await loadAiContextConfig(
      path.join(os.homedir(), '.claude', 'CLAUDE.md'),
      'CLAUDE.md',
      'anthropic',
      true,
    );
    const { query } = await loadAnthropicAgentSdk();
    const session = query({
      prompt: params.prompt,
      options: {
        cwd: process.cwd(),
        model,
        tools: [...ANTHROPIC_STAGE_TOOLS],
        allowedTools: [...ANTHROPIC_STAGE_TOOLS],
        permissionMode: 'acceptEdits',
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: [anthropicContext, params.systemPrompt]
            .filter(Boolean)
            .join('\n\n'),
        },
        canUseTool: async (toolName, input) => {
          if (toolName !== 'Bash') {
            return { behavior: 'allow' };
          }

          const command =
            typeof input['command'] === 'string' ? input['command'].trim() : '';
          if (!command || !isReadOnlyCommand(command)) {
            return {
              behavior: 'deny',
              message:
                'Only read-only repository inspection commands are allowed in this agent path.',
              interrupt: true,
            };
          }

          return { behavior: 'allow' };
        },
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
            allowRead: [process.cwd()],
            allowWrite: [],
          },
        },
      },
    });

    try {
      for await (const message of session) {
        if (message.type !== 'result') {
          continue;
        }

        if (message.subtype !== 'success' || message.is_error) {
          const errorSummary =
            'errors' in message && message.errors.length > 0
              ? message.errors.join('; ')
              : 'unknown error';
          throw new Error(
            `Claude Agent SDK failed (${message.subtype}): ${errorSummary}`,
          );
        }

        return message.result.trim();
      }
    } finally {
      session.close();
    }

    throw new Error('Claude Agent SDK finished without returning a result.');
  }

  private async runOpenAiStagePrompt(params: {
    stage: AgentStageName;
    prompt: string;
    systemPrompt: string;
  }): Promise<string> {
    const apiKey = this.configService.get<string>('ai.openaiApiKey');
    if (!apiKey) {
      throw new Error(
        'OpenAI agent backend requires `ai.openaiApiKey` to be configured.',
      );
    }

    const modelProvider = new OpenAIProvider({ apiKey });
    const model = this.resolveStageModel(params.stage);
    const openAiContext = await loadAiContextConfig(
      path.join(os.homedir(), '.openai', 'OPENAI.md'),
      '.openai/OPENAI.md',
      'openai',
      true,
    );
    const context: OpenAiStageContext = {
      repoDir: process.cwd(),
    };

    const readFileTool = tool({
      name: 'read_file',
      description: 'Read a file from the current repository workspace.',
      parameters: z.object({
        path: z.string().min(1),
      }),
      async execute(input, runContext) {
        const toolContext = runContext?.context as OpenAiStageContext;
        const absolutePath = path.resolve(toolContext.repoDir, input.path);
        const content = await fs.readFile(absolutePath, 'utf-8');
        return JSON.stringify(
          {
            path: path.relative(toolContext.repoDir, absolutePath),
            content,
          },
          null,
          2,
        );
      },
    });

    const listFilesTool = tool({
      name: 'list_files',
      description: 'List files in the current repository workspace.',
      parameters: z.object({
        root: z.string().optional(),
      }),
      async execute(input, runContext) {
        const toolContext = runContext?.context as OpenAiStageContext;
        const relativeRoot = input.root?.trim() || '.';
        const command =
          `rg --files ${relativeRoot === '.' ? '' : relativeRoot}`.trim();
        const { stdout } = await execAsync(command, {
          cwd: toolContext.repoDir,
          maxBuffer: MAX_BUFFER_IN_BYTES,
        });
        return stdout.trim();
      },
    });

    const searchFilesTool = tool({
      name: 'search_files',
      description: 'Search repository files with ripgrep.',
      parameters: z.object({
        pattern: z.string().min(1),
        root: z.string().optional(),
      }),
      async execute(input, runContext) {
        const toolContext = runContext?.context as OpenAiStageContext;
        const relativeRoot = input.root?.trim() || '.';
        const command = `rg -n ${JSON.stringify(input.pattern)} ${relativeRoot}`;
        const { stdout } = await execAsync(command, {
          cwd: toolContext.repoDir,
          maxBuffer: MAX_BUFFER_IN_BYTES,
        });
        return stdout.trim();
      },
    });

    const runCommandTool = tool({
      name: 'run_readonly_command',
      description:
        'Run a read-only repository inspection command such as pwd, ls, rg, git diff, or git status.',
      parameters: z.object({
        command: z.string().min(1),
      }),
      async execute(input, runContext) {
        const toolContext = runContext?.context as OpenAiStageContext;
        const command = input.command.trim();
        if (!isReadOnlyCommand(command)) {
          return JSON.stringify(
            {
              allowed: false,
              message:
                'Only read-only repository inspection commands are allowed in this agent path.',
            },
            null,
            2,
          );
        }

        const { stdout, stderr } = await execAsync(command, {
          cwd: toolContext.repoDir,
          maxBuffer: MAX_BUFFER_IN_BYTES,
        });
        return JSON.stringify(
          {
            allowed: true,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
          },
          null,
          2,
        );
      },
    });

    const agent = new Agent<OpenAiStageContext>({
      name: `wf ${params.stage} openai agent backend`,
      handoffDescription:
        'Uses read-only tools to inspect the repository and answer the current stage prompt.',
      instructions: [openAiContext, params.systemPrompt]
        .filter(Boolean)
        .join('\n\n'),
      model,
      tools: [readFileTool, listFilesTool, searchFilesTool, runCommandTool],
      toolUseBehavior: 'run_llm_again',
      resetToolChoice: true,
    });

    const runner = new Runner({
      modelProvider,
    });
    const streamedRun: StreamedRunResult<OpenAiStageContext, typeof agent> =
      await runner.run(agent, params.prompt, {
        stream: true,
        context,
        maxTurns: 16,
      });

    for await (const event of streamedRun) {
      void event;
      // Intentionally consume the stream to completion; the final output is used below.
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

    return typeof streamedRun.finalOutput === 'string'
      ? streamedRun.finalOutput.trim()
      : '';
  }
}
