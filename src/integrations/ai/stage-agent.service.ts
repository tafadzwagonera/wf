import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Agent, OpenAIProvider, Runner, setTracingExportApiKey, tool } from '@openai/agents';
import type { StreamedRunResult } from '@openai/agents';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import dayjs from 'dayjs';
import { formatProgressMessage as formatAnthropicProgressMessage } from './adapters/anthropic-agent.adapter';
import { formatProgressMessage as formatOpenAiProgressMessage } from './adapters/openai-agent.adapter';
import { loadAnthropicAgentSdk } from './adapters/load-anthropic-agent-sdk';
import { loadAiContextConfig } from './adapters/load-ai-context-config';
import { assertClaudeCliAvailable, buildCliArgs, spawnCli, type ClaudeCliMessage } from './adapters/claude-cli-runner';
import { assertCodexCliAvailable, buildCodexCliArgs, spawnCodex } from './adapters/codex-cli-runner';
import type { WfBackendMode } from '../../config/public-config';
import { resolveDefaultStageBackend } from '../../config/stage-backend-defaults';
import {
  CodeReview,
  requireAiResponseContent,
  parseJsonResponse,
  requireReviewResponseContent,
  ResolutionPlan,
  sanitizeCodeReviewTrace,
} from './ai.service';
import { resolutionPlanSchema } from '../../shared/schemas/ai.schema';
import { AIError, isAIErrorLike } from '../../shared/utils/errors';
import type { TestInfraContext } from '../../shared/utils/detect-test-infra';
import { formatTestInfraPromptSection } from '../../shared/utils/detect-test-infra';
import { postProcessCodeReview } from '../../review/code-review-post-processing';
import {
  formatRepoConventionsPromptSection,
  type RepoConventionsContext,
} from '../../shared/utils/detect-repo-conventions';
import { formatPriorTicketsPromptSection, type PriorTicketContext } from '../../shared/utils/detect-prior-tickets';
import {
  formatCrossRepoPatternsPromptSection,
  type CrossRepoContext,
} from '../../shared/utils/detect-cross-repo-patterns';
import {
  formatRecurrenceGapsPromptSection,
  type RecurrenceGapAnalysis,
} from '../../shared/utils/detect-recurrence-gaps';

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

const extractCliDiagnostic = (message: ClaudeCliMessage): string | undefined => {
  if (message.is_error) {
    return message.result ?? message.summary ?? JSON.stringify(message);
  }
  if (message.type === 'rate_limit_event') {
    const info = message.rate_limit_info as { status?: string } | undefined;
    if (info?.status && info.status !== 'allowed') {
      return `Rate limited (status: ${info.status})`;
    }
  }
  return undefined;
};

const CLI_STAGE_LABEL = 'claude-cli';
const CLI_STALL_THRESHOLD = 2;

/**
 * Extracts the last assistant turn's text from a CLI NDJSON message.
 * Only the last assistant turn is relevant — earlier turns may contain
 * JSON-like fragments from intermediate analysis.
 */
const extractAssistantText = (message: ClaudeCliMessage): string | undefined => {
  if (message.type !== 'assistant') return undefined;
  const content = (message as Record<string, unknown>).message;
  if (!content || typeof content !== 'object' || !('content' in content)) return undefined;
  const blocks = (content as { content: unknown[] }).content;
  if (!Array.isArray(blocks)) return undefined;
  let turnText = '';
  for (const block of blocks) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as Record<string, unknown>).type === 'text' &&
      typeof (block as Record<string, unknown>).text === 'string'
    ) {
      turnText += (block as { text: string }).text;
    }
  }
  return turnText || undefined;
};

import type { StageProgressCallback, AgentStageName } from '../../shared/types/agent.types';

export type { StageProgressCallback, AgentStageName } from '../../shared/types/agent.types';

export type AgentChatSession = {
  provider: 'anthropic' | 'openai';
  backend?: 'agent' | 'cli';
  sessionId?: string;
  runState?: unknown;
  agent?: unknown;
  runner?: unknown;
};

type OpenAiStageContext = {
  repoDir: string;
};

const resolveStagePromptRepoExample = (repositories?: string[]): string => {
  const firstRepository = repositories?.find(repository => typeof repository === 'string' && repository.trim());
  return firstRepository?.trim() || 'current-repo';
};

const isReadOnlyCommand = (command: string): boolean =>
  ALLOWED_READ_ONLY_COMMAND_PREFIXES.some(prefix => command === prefix || command.startsWith(prefix));

@Injectable()
export class StageAgentService {
  constructor(private readonly configService: ConfigService) {}

  isEnabledForStage(stage: AgentStageName): boolean {
    const backend = this.resolveStageBackend(stage);
    return backend === 'agent' || backend === 'cli';
  }

  async generatePlan(params: {
    action: 'fix' | 'feature' | 'investigate';
    issueContent: string;
    ticketKey?: string;
    affectedRepositories?: string[];
    testInfra?: TestInfraContext;
    conventions?: RepoConventionsContext;
    priorTickets?: PriorTicketContext;
    crossRepoPatterns?: CrossRepoContext;
    recurrenceGaps?: RecurrenceGapAnalysis | null;
    onProgress?: StageProgressCallback;
    priorStageSummary?: string;
    resumeProviderSessionId?: string;
  }): Promise<{ plan: ResolutionPlan; sessionId?: string }> {
    const repoExample = resolveStagePromptRepoExample(params.affectedRepositories);

    // Build discovery context sections
    const discoveryParts: string[] = [];
    if (params.conventions) {
      const repoName = params.affectedRepositories?.[0] ?? 'repo';
      const section = formatRepoConventionsPromptSection(params.conventions, repoName);
      if (section) discoveryParts.push(section);
    }
    if (params.priorTickets) {
      const section = formatPriorTicketsPromptSection(params.priorTickets);
      if (section) discoveryParts.push(section);
    }
    if (params.crossRepoPatterns) {
      const section = formatCrossRepoPatternsPromptSection(params.crossRepoPatterns);
      if (section) discoveryParts.push(section);
    }
    if (params.recurrenceGaps) {
      const section = formatRecurrenceGapsPromptSection(params.recurrenceGaps);
      if (section) discoveryParts.push(section);
    }
    const discoveryBlock = discoveryParts.length > 0 ? `\n${discoveryParts.join('\n\n')}\n` : '';

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
  2
)}
${discoveryBlock}
Create a detailed resolution plan with:
1. A brief summary of the issue and proposed solution
2. Specific, actionable steps to ${params.action} the issue — when the ticket includes code examples, embed relevant snippets inline (e.g., "Replace \`oldFunction()\` with \`newFunction()\` in src/utils.ts")
   Every rename, move, or refactoring step MUST state both the current name/path AND the
   replacement name/path (e.g., "Rename class \`PaymentService\` to \`PaymentProcessorService\`
   in src/payments/payment.service.ts"). A step that says only "rename X" without the target
   is unusable by the implementer and will be rejected.
3. Estimated complexity (low/medium/high)
4. Files that will be **modified** — use objects with "filePath" and "status". Prefix EVERY
   path with its repository name. Use REAL file paths from the repository — not globs, not
   placeholders. Set status to "found" for existing files or "to-create" for new files.
   IMPORTANT: Do NOT guess or infer file paths from conventions. You MUST use your read-only
   tools (grep, find, or directory listings) to verify each path exists before listing it.
   Hallucinated paths cause the implementer to stall.
5. Files needed for **context only** (read, not edit) — same object shape as affectedFiles.
   E.g., reading package.json to confirm a dependency. All context files must have status
   "found". Verify each path exists with tools before listing it.
6. Potential risks or considerations
7. Repositories that will be affected (if known)

${params.testInfra ? formatTestInfraPromptSection(params.testInfra) : ''}
Minimal-change principles — apply to every plan:
- Propose the smallest effective change. Do not modify files unrelated to the ticket.
- Limit verification to files edited by this plan.
- Each component should be designed to address a single responsibility.
- Prefer changes that are replaceable or deletable without cascading effects on other components.

8. Task-specific verification only when needed:
   - Use "verification.targeted" for focused checks required by this specific plan
   - Use "verification.waivers" only when this plan needs to explicitly waive a repo-level baseline check
   - Omit "verification" entirely when no targeted checks or waivers are needed
   - Verification commands run from the selected repository root
   - Every verification command must exit 0 when it succeeds
   - Commands must be copy-paste-runnable: reference ONLY scripts/binaries listed in the
     "Available test infrastructure" section. Do not invent scripts.
   - CRITICAL: verification commands are validated against the allowlist above. Any command
     that does not match an allowed form will be rejected. When unsure, use: node -e "..."
   - Each verification command MUST be relevant to this plan: it should verify a side effect
     or behavior introduced by the steps above, not just run the whole test suite.
   - For inline assertions, prefer: node -e "const assert = require('node:assert'); ..."
     (when node:test is available) or the installed test framework CLI
   - If you need to prove an expected failure, wrap it in a shell assertion that exits 0

Return ONLY a valid JSON object with these fields:
{
  "action": "${params.action}",
  "summary": "...",
  "steps": ["step 1", "step 2"],
  "estimatedComplexity": "low|medium|high",
  "affectedFiles": [{ "filePath": "${repoExample}/src/path/to/file.ts", "status": "found" }],
  "affectedFilesContext": [{ "filePath": "${repoExample}/package.json", "status": "found" }],
  "affectedRepositories": ["${repoExample}"],
  "risks": ["risk 1"],
  "verification": {
    "targeted": [
      {
        "id": "manual-review",
        "run": "yarn test:manual -- test-issue-review",
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

    const { content: response, sessionId } = await this.runStagePrompt({
      stage: 'plan',
      prompt,
      systemPrompt,
      repoDir: process.cwd(),
      onProgress: params.onProgress,
      priorStageSummary: params.priorStageSummary,
      resumeProviderSessionId: params.resumeProviderSessionId,
    });

    try {
      const plan = parseJsonResponse<ResolutionPlan & { repositoriesAffected?: string[] }>(
        requireAiResponseContent(
          {
            content: response,
            provider: this.resolveStageProvider('plan'),
            model: this.resolveStageModel('plan'),
          },
          'AI provider returned an empty plan response'
        )
      );
      // Backward-compat: AI may still return the old key name during the transition period
      if (!plan.affectedRepositories && plan.repositoriesAffected) {
        plan.affectedRepositories = plan.repositoriesAffected;
      }
      delete plan.repositoriesAffected;
      const provider = this.resolveStageProvider('plan');
      const model = this.resolveStageModel('plan');
      const prefixMap: Record<string, string> = {
        anthropic: 'claude-',
        google: 'gemini-',
        deepseek: 'deepseek-',
        openai: 'gpt-',
      };
      const prefix = prefixMap[provider] ?? '';
      const source = model.startsWith(prefix) ? model.slice(prefix.length) : model;

      plan.provider = provider;
      plan.source = source;
      plan.timestamp = dayjs().toISOString();
      return { plan, sessionId };
    } catch (error) {
      if (isAIErrorLike(error)) {
        throw error;
      }

      throw new AIError('Failed to parse resolution plan from agent response', {
        response,
        error,
      });
    }
  }

  async reviewCode(
    diff: string,
    guidelines: string[],
    repoDir?: string,
    priorStageSummary?: string,
    resumeProviderSessionId?: string
  ): Promise<{ review: CodeReview; sessionId?: string }> {
    const prompt = `
Code Changes:
\`\`\`
${diff}
\`\`\`

Review Guidelines:
${guidelines.map((g, i) => `${i + 1}. ${g}`).join('\n')}

Provide a code review with:
1. A brief summary of the changes
2. Any issues found
3. A trace provenance label: evidence-based, best-effort, or unavailable
4. A nested tree-like call stack that walks the changed code path
5. A frame-aligned state transition tree that captures variable changes between the frames in the call stack
6. A suggestion for each issue when remediation is clear — each suggestion must recommend the smallest effective fix (the minimum change that resolves the issue without introducing unnecessary scope). Write suggestions in plain, human-friendly language: be concise, use everyday phrasing, and avoid jargon-heavy or robotic sentences.
7. Optional trailing suggestions for general follow-up work that is not tied to a single issue — each must also prefer the smallest effective fix and use the same concise, human-friendly tone
8. Whether the code is approved

Return ONLY a valid JSON object:
{
  "summary": "...",
  "issues": [
    {
      "severity": "error|warning|info",
      "message": "...",
      "file": "optional",
      "line": 12,
      "suggestion": "optional issue-specific remediation"
    }
  ],
  "traceProvenance": "evidence-based|best-effort|unavailable",
  "callStack": [
    {
      "frame": "Class.method(...)",
      "children": [
        {
          "frame": "Child.method(...)",
          "children": []
        }
      ]
    }
  ],
  "stateTransition": {
    "from": "state-a",
    "to": "state-b",
    "steps": [
      {
        "frame": "Class.method(...)",
        "captured": {
          "some.dep": "Dep { ... }"
        },
        "changes": {
          "some.dep": {
            "before": "old value",
            "after": "new value"
          }
        }
      }
    ]
  },
  "suggestions": ["general follow-up suggestion 1"],
  "approved": true
}`;

    const systemPrompt = `You are an expert code reviewer providing constructive feedback.
You may inspect repository files with read-only tools before answering.
Focus on code quality, bugs, security, and the changed execution path.
Ignore JSON or markdown files under .wf/ and tracker artifact directories.`;

    const { content: response, sessionId } = await this.runStagePrompt({
      stage: 'review',
      prompt,
      systemPrompt,
      repoDir,
      priorStageSummary,
      resumeProviderSessionId,
    });

    try {
      const parsed = parseJsonResponse<CodeReview>(
        requireReviewResponseContent({
          content: response,
          provider: this.resolveStageProvider('review'),
          model: this.resolveStageModel('review'),
        })
      );
      const processedReview = postProcessCodeReview(sanitizeCodeReviewTrace(parsed, diff), diff);
      return {
        review: {
          ...processedReview.review,
          executionMode: this.resolveStageBackend('review') === 'cli' ? 'cli' : 'agent',
        },
        sessionId,
      };
    } catch (error) {
      if (isAIErrorLike(error)) {
        throw error;
      }

      throw new AIError('Failed to parse code review from agent response', {
        response,
        error,
      });
    }
  }

  async generateFromPrompt(prompt: string, onProgress?: StageProgressCallback): Promise<string> {
    const systemPrompt = `You are an expert technical writer and repository analyst.
You may inspect repository files with read-only tools before answering.
Return only the requested ticket markdown and preserve the required heading structure exactly.`;

    const { content: response } = await this.runStagePrompt({
      stage: 'generate',
      prompt,
      systemPrompt,
      onProgress,
    });

    return requireAiResponseContent(
      {
        content: response,
        provider: this.resolveStageProvider('generate'),
        model: this.resolveStageModel('generate'),
      },
      'AI provider returned an empty generated content response'
    );
  }

  private resolveStageBackend(stage: AgentStageName): WfBackendMode {
    return this.configService.get<WfBackendMode>(`stages.${stage}.backend`, resolveDefaultStageBackend(stage));
  }

  private resolveStageProvider(stage: AgentStageName): 'anthropic' | 'openai' {
    const provider =
      this.configService.get<string>(`stages.${stage}.provider`) ??
      this.configService.get<string>('ai.provider', 'anthropic');
    if (provider !== 'anthropic' && provider !== 'openai') {
      throw new Error(
        `${stage} stage agent backend is unsupported for provider "${provider}". Configure ${stage}.provider as anthropic or openai, or set stages.${stage}.backend to "standard".`
      );
    }
    return provider;
  }

  private resolveStageModel(stage: AgentStageName): string {
    return (
      this.configService.get<string>(`stages.${stage}.model`) ??
      this.configService.get<string>('ai.model') ??
      (this.resolveStageProvider(stage) === 'openai' ? READ_ONLY_OPENAI_MODEL : READ_ONLY_ANTHROPIC_MODEL)
    );
  }

  private async runStagePrompt(params: {
    stage: AgentStageName;
    prompt: string;
    systemPrompt: string;
    repoDir?: string;
    onProgress?: StageProgressCallback;
    priorStageSummary?: string;
    resumeProviderSessionId?: string;
  }): Promise<{ content: string; sessionId?: string }> {
    const backend = this.resolveStageBackend(params.stage);
    if (backend === 'cli') {
      const provider = this.resolveStageProvider(params.stage);
      if (provider === 'openai') {
        return this.runCodexCliStagePrompt(params);
      }
      return this.runCliStagePrompt(params);
    }

    const provider = this.resolveStageProvider(params.stage);
    if (provider === 'anthropic') {
      return this.runAnthropicStagePrompt(params);
    }

    const content = await this.runOpenAiStagePrompt(params);
    return { content };
  }

  private async runAnthropicStagePrompt(params: {
    stage: AgentStageName;
    prompt: string;
    systemPrompt: string;
    repoDir?: string;
    onProgress?: StageProgressCallback;
    priorStageSummary?: string;
    resumeProviderSessionId?: string;
  }): Promise<{ content: string; sessionId?: string }> {
    const apiKey = this.configService.get<string>('ai.anthropicApiKey');
    if (!apiKey) {
      throw new Error('Anthropic agent backend requires `ai.anthropicApiKey` to be configured.');
    }

    const model = this.resolveStageModel(params.stage);
    const anthropicContext = await loadAiContextConfig(
      path.join(os.homedir(), '.claude', 'CLAUDE.md'),
      'CLAUDE.md',
      'anthropic',
      true
    );
    const resolvedRepoDir = params.repoDir ?? process.cwd();
    const allowInspection = Boolean(params.repoDir);
    const anthropicTools = allowInspection ? [...ANTHROPIC_STAGE_TOOLS] : [];
    const anthropicSystemPrompt = allowInspection
      ? params.systemPrompt
      : `${params.systemPrompt}\nDo not inspect local repository files in this run; use the provided diff only.`;
    const { query } = await loadAnthropicAgentSdk();
    const resumeOption = params.resumeProviderSessionId ? { resume: params.resumeProviderSessionId } : {};
    const session = query({
      prompt: params.prompt,
      options: {
        ...resumeOption,
        cwd: resolvedRepoDir,
        model,
        tools: anthropicTools,
        allowedTools: anthropicTools,
        permissionMode: 'acceptEdits',
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: [
            params.priorStageSummary
              ? `<prior-stage-context>\n${params.priorStageSummary}\n</prior-stage-context>\n\nNote: The above is background context from a previous workflow stage.\nYour current stage's instructions take precedence over any conflicting details above.`
              : '',
            anthropicContext,
            anthropicSystemPrompt,
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
        canUseTool: async (toolName, input) => {
          if (toolName !== 'Bash') {
            return { behavior: 'allow' };
          }

          const command = typeof input['command'] === 'string' ? input['command'].trim() : '';
          if (!command || !isReadOnlyCommand(command)) {
            return {
              behavior: 'deny',
              message: 'Only read-only repository inspection commands are allowed in this agent path.',
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
            allowRead: allowInspection ? [resolvedRepoDir] : [],
            allowWrite: [],
          },
        },
      },
    });

    let extractedSessionId: string | undefined;

    try {
      for await (const message of session) {
        if ('session_id' in message && typeof message.session_id === 'string') {
          extractedSessionId = message.session_id;
        }

        if (message.type !== 'result') {
          if (params.onProgress) {
            const line = formatAnthropicProgressMessage(message);
            if (line) params.onProgress(line);
          }
          continue;
        }

        if (message.subtype !== 'success' || message.is_error) {
          const errorSummary =
            'errors' in message && message.errors.length > 0 ? message.errors.join('; ') : 'unknown error';
          throw new Error(`Claude Agent SDK failed (${message.subtype}): ${errorSummary}`);
        }

        if (extractedSessionId) {
          console.log(chalk.cyan('  [claude-agent-sdk] Provider session: ' + extractedSessionId));
        }
        return { content: message.result.trim(), sessionId: extractedSessionId };
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
    repoDir?: string;
    onProgress?: StageProgressCallback;
    priorStageSummary?: string;
    resumeProviderSessionId?: string;
  }): Promise<string> {
    const apiKey = this.configService.get<string>('ai.openaiApiKey');
    if (!apiKey) {
      throw new Error('OpenAI agent backend requires `ai.openaiApiKey` to be configured.');
    }

    setTracingExportApiKey(apiKey);
    const modelProvider = new OpenAIProvider({ apiKey });
    const model = this.resolveStageModel(params.stage);
    const openAiContext = await loadAiContextConfig(
      path.join(os.homedir(), '.openai', 'OPENAI.md'),
      '.openai/OPENAI.md',
      'openai',
      true
    );
    const resolvedRepoDir = params.repoDir ?? process.cwd();
    const allowInspection = Boolean(params.repoDir);

    if (params.resumeProviderSessionId) {
      console.log(
        chalk.yellow(
          '  [openai-agent] Session resumption is not yet supported for the OpenAI agent backend. Starting fresh.'
        )
      );
    }

    const priorStagePreamble = params.priorStageSummary
      ? `<prior-stage-context>\n${params.priorStageSummary}\n</prior-stage-context>\n\nNote: The above is background context from a previous workflow stage.\nYour current stage's instructions take precedence over any conflicting details above.\n\n`
      : '';
    const openAiSystemPrompt = allowInspection
      ? `${priorStagePreamble}${params.systemPrompt}`
      : `${priorStagePreamble}${params.systemPrompt}\nDo not inspect local repository files in this run; use the provided diff only.`;
    const context: OpenAiStageContext = {
      repoDir: resolvedRepoDir,
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
          2
        );
      },
    });

    const listFilesTool = tool({
      name: 'list_files',
      description: 'List files in the current repository workspace.',
      parameters: z.object({
        root: z.string().min(1).describe('Repository subdirectory to list; use "." for the repo root.'),
      }),
      async execute(input, runContext) {
        const toolContext = runContext?.context as OpenAiStageContext;
        const relativeRoot = input.root.trim() || '.';
        const command = `rg --files ${relativeRoot === '.' ? '' : relativeRoot}`.trim();
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
        root: z.string().min(1).describe('Repository subdirectory to search; use "." for the repo root.'),
      }),
      async execute(input, runContext) {
        const toolContext = runContext?.context as OpenAiStageContext;
        const relativeRoot = input.root.trim() || '.';
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
      description: 'Run a read-only repository inspection command such as pwd, ls, rg, git diff, or git status.',
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
              message: 'Only read-only repository inspection commands are allowed in this agent path.',
            },
            null,
            2
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
          2
        );
      },
    });

    const agent = new Agent<OpenAiStageContext>({
      name: `wf ${params.stage} openai agent backend`,
      handoffDescription: 'Uses read-only tools to inspect the repository and answer the current stage prompt.',
      instructions: [openAiContext, openAiSystemPrompt].filter(Boolean).join('\n\n'),
      model,
      tools: allowInspection ? [readFileTool, listFilesTool, searchFilesTool, runCommandTool] : [],
      toolUseBehavior: 'run_llm_again',
      resetToolChoice: true,
    });

    const runner = new Runner({
      modelProvider,
    });
    const streamedRun: StreamedRunResult<OpenAiStageContext, typeof agent> = await runner.run(agent, params.prompt, {
      stream: true,
      context,
      maxTurns: 16,
    });

    for await (const event of streamedRun) {
      if (params.onProgress) {
        const formatted = formatOpenAiProgressMessage(event);
        if (formatted) params.onProgress(formatted.message);
      }
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

    return typeof streamedRun.finalOutput === 'string' ? streamedRun.finalOutput.trim() : '';
  }

  async chatTurn(params: {
    stage: AgentStageName;
    userMessage: string;
    systemPrompt: string;
    repoDir?: string;
    session?: AgentChatSession;
  }): Promise<{ content: string; session: AgentChatSession }> {
    const backend = this.resolveStageBackend(params.stage);
    if (backend === 'cli') {
      return this.cliChatTurn(params);
    }
    const provider = this.resolveStageProvider(params.stage);
    if (provider === 'anthropic') {
      return this.anthropicChatTurn(params);
    }
    const result = await this.openAiChatTurn(params);
    requireAiResponseContent(
      {
        content: result.content,
        provider: 'openai',
        model: this.resolveStageModel(params.stage),
      },
      'AI provider returned an empty chat response'
    );
    return result;
  }

  private async anthropicChatTurn(params: {
    stage: AgentStageName;
    userMessage: string;
    systemPrompt: string;
    repoDir?: string;
    session?: AgentChatSession;
  }): Promise<{ content: string; session: AgentChatSession }> {
    const apiKey = this.configService.get<string>('ai.anthropicApiKey');
    if (!apiKey) {
      throw new Error('Anthropic agent backend requires `ai.anthropicApiKey` to be configured.');
    }

    const model = this.resolveStageModel(params.stage);
    const anthropicContext = await loadAiContextConfig(
      path.join(os.homedir(), '.claude', 'CLAUDE.md'),
      'CLAUDE.md',
      'anthropic',
      true
    );
    const resolvedRepoDir = params.repoDir ?? process.cwd();
    const allowInspection = Boolean(params.repoDir);
    const anthropicTools = allowInspection ? [...ANTHROPIC_STAGE_TOOLS] : [];
    const anthropicSystemPrompt = allowInspection
      ? params.systemPrompt
      : `${params.systemPrompt}\nDo not inspect local repository files in this run; use the provided diff only.`;

    const { query } = await loadAnthropicAgentSdk();

    const resumeOption = params.session?.sessionId ? { resume: params.session.sessionId } : {};

    const session = query({
      prompt: params.userMessage,
      options: {
        cwd: resolvedRepoDir,
        model,
        tools: anthropicTools,
        allowedTools: anthropicTools,
        permissionMode: 'acceptEdits',
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: [anthropicContext, anthropicSystemPrompt].filter(Boolean).join('\n\n'),
        },
        canUseTool: async (toolName: string, input: Record<string, unknown>) => {
          if (toolName !== 'Bash') {
            return { behavior: 'allow' as const };
          }
          const command = typeof input['command'] === 'string' ? input['command'].trim() : '';
          if (!command || !isReadOnlyCommand(command)) {
            return {
              behavior: 'deny' as const,
              message: 'Only read-only repository inspection commands are allowed in this agent path.',
              interrupt: true,
            };
          }
          return { behavior: 'allow' as const };
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
            allowRead: allowInspection ? [resolvedRepoDir] : [],
            allowWrite: [],
          },
        },
        ...resumeOption,
      },
    });

    try {
      let sessionId: string | undefined = params.session?.sessionId;
      for await (const message of session) {
        if (message.type !== 'result') {
          continue;
        }

        if ('session_id' in message && typeof message.session_id === 'string') {
          sessionId = message.session_id;
        }

        if (message.subtype !== 'success' || message.is_error) {
          const errorSummary =
            'errors' in message && message.errors.length > 0 ? message.errors.join('; ') : 'unknown error';
          throw new Error(`Claude Agent SDK failed (${message.subtype}): ${errorSummary}`);
        }

        return {
          content: message.result.trim(),
          session: { provider: 'anthropic' as const, sessionId },
        };
      }
    } finally {
      session.close();
    }

    throw new Error('Claude Agent SDK finished without returning a result.');
  }

  private async openAiChatTurn(params: {
    stage: AgentStageName;
    userMessage: string;
    systemPrompt: string;
    repoDir?: string;
    session?: AgentChatSession;
  }): Promise<{ content: string; session: AgentChatSession }> {
    const apiKey = this.configService.get<string>('ai.openaiApiKey');
    if (!apiKey) {
      throw new Error('OpenAI agent backend requires `ai.openaiApiKey` to be configured.');
    }

    setTracingExportApiKey(apiKey);
    const modelProvider = new OpenAIProvider({ apiKey });
    const model = this.resolveStageModel(params.stage);
    const openAiContext = await loadAiContextConfig(
      path.join(os.homedir(), '.openai', 'OPENAI.md'),
      '.openai/OPENAI.md',
      'openai',
      true
    );
    const resolvedRepoDir = params.repoDir ?? process.cwd();
    const allowInspection = Boolean(params.repoDir);
    const openAiSystemPrompt = allowInspection
      ? params.systemPrompt
      : `${params.systemPrompt}\nDo not inspect local repository files in this run; use the provided diff only.`;
    const context: OpenAiStageContext = { repoDir: resolvedRepoDir };

    const readFileTool = tool({
      name: 'read_file',
      description: 'Read a file from the current repository workspace.',
      parameters: z.object({ path: z.string().min(1) }),
      async execute(input, runContext) {
        const toolContext = runContext?.context as OpenAiStageContext;
        const absolutePath = path.resolve(toolContext.repoDir, input.path);
        const content = await fs.readFile(absolutePath, 'utf-8');
        return JSON.stringify({ path: path.relative(toolContext.repoDir, absolutePath), content }, null, 2);
      },
    });

    const listFilesTool = tool({
      name: 'list_files',
      description: 'List files in the current repository workspace.',
      parameters: z.object({
        root: z.string().min(1).describe('Repository subdirectory to list; use "." for the repo root.'),
      }),
      async execute(input, runContext) {
        const toolContext = runContext?.context as OpenAiStageContext;
        const relativeRoot = input.root.trim() || '.';
        const command = `rg --files ${relativeRoot === '.' ? '' : relativeRoot}`.trim();
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
        root: z.string().min(1).describe('Repository subdirectory to search; use "." for the repo root.'),
      }),
      async execute(input, runContext) {
        const toolContext = runContext?.context as OpenAiStageContext;
        const relativeRoot = input.root.trim() || '.';
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
      description: 'Run a read-only repository inspection command such as pwd, ls, rg, git diff, or git status.',
      parameters: z.object({ command: z.string().min(1) }),
      async execute(input, runContext) {
        const toolContext = runContext?.context as OpenAiStageContext;
        const command = input.command.trim();
        if (!isReadOnlyCommand(command)) {
          return JSON.stringify(
            {
              allowed: false,
              message: 'Only read-only repository inspection commands are allowed in this agent path.',
            },
            null,
            2
          );
        }
        const { stdout, stderr } = await execAsync(command, {
          cwd: toolContext.repoDir,
          maxBuffer: MAX_BUFFER_IN_BYTES,
        });
        return JSON.stringify({ allowed: true, stdout: stdout.trim(), stderr: stderr.trim() }, null, 2);
      },
    });

    const reusableAgent = params.session?.agent as Agent<OpenAiStageContext> | undefined;
    const reusableRunner = params.session?.runner as Runner | undefined;

    const agent =
      reusableAgent ??
      new Agent<OpenAiStageContext>({
        name: `wf ${params.stage} openai agent backend`,
        handoffDescription: 'Uses read-only tools to inspect the repository and answer the current stage prompt.',
        instructions: [openAiContext, openAiSystemPrompt].filter(Boolean).join('\n\n'),
        model,
        tools: allowInspection ? [readFileTool, listFilesTool, searchFilesTool, runCommandTool] : [],
        toolUseBehavior: 'run_llm_again',
        resetToolChoice: true,
      });

    const runner = reusableRunner ?? new Runner({ modelProvider });

    const runInput = params.session?.runState ?? params.userMessage;
    const streamedRun: StreamedRunResult<OpenAiStageContext, typeof agent> = await runner.run(agent, runInput as any, {
      stream: true,
      context,
      maxTurns: 8,
    });

    for await (const event of streamedRun) {
      void event;
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

    const content = typeof streamedRun.finalOutput === 'string' ? streamedRun.finalOutput.trim() : '';

    return {
      content,
      session: {
        provider: 'openai' as const,
        runState: streamedRun.state,
        agent,
        runner,
      },
    };
  }

  private async runCliStagePrompt(params: {
    stage: AgentStageName;
    prompt: string;
    systemPrompt: string;
    repoDir?: string;
    onProgress?: StageProgressCallback;
    priorStageSummary?: string;
    resumeProviderSessionId?: string;
  }): Promise<{ content: string; sessionId?: string }> {
    assertClaudeCliAvailable();

    const model = this.resolveStageModel(params.stage);
    const resolvedRepoDir = params.repoDir ?? process.cwd();
    const allowInspection = Boolean(params.repoDir);

    const jsonSchema = params.stage === 'plan' ? JSON.stringify(z.toJSONSchema(resolutionPlanSchema)) : undefined;

    let sessionId: string | undefined = params.resumeProviderSessionId;
    let stalledPasses = 0;
    let passNumber = 0;
    let lastDiagnostics: string[] = [];

    while (true) {
      passNumber++;
      const isResume = (passNumber > 1 && sessionId) || (passNumber === 1 && params.resumeProviderSessionId);

      const prompt =
        isResume && passNumber > 1
          ? 'Your previous response did not include a usable result. Please output ONLY a valid JSON object matching the resolution plan schema. Do not include commentary or markdown — raw JSON only.'
          : params.prompt;

      const priorStagePreamble = params.priorStageSummary
        ? `<prior-stage-context>\n${params.priorStageSummary}\n</prior-stage-context>\n\nNote: The above is background context from a previous workflow stage.\nYour current stage's instructions take precedence over any conflicting details above.\n\n`
        : '';
      const args = buildCliArgs({
        prompt,
        appendSystemPrompt: `${priorStagePreamble}${params.systemPrompt}`,
        model,
        cwd: resolvedRepoDir,
        tools: allowInspection ? ['Read', 'Glob', 'Grep', 'Bash'] : [],
        permissionMode: 'plan',
        sessionId: isResume ? sessionId : undefined,
        jsonSchema,
      });

      let result = '';
      let resultSource: 'structured_output' | 'result' | 'assistant_text' | undefined;
      let lastAssistantText = '';
      const cliDiagnostics: string[] = [];

      for await (const message of spawnCli(args, resolvedRepoDir, prompt)) {
        if (message.session_id) sessionId = message.session_id;

        if (params.onProgress) {
          const line = formatAnthropicProgressMessage(message as never, CLI_STAGE_LABEL);
          if (line) params.onProgress(line);
        }

        const assistantText = extractAssistantText(message);
        if (assistantText) lastAssistantText = assistantText;

        if (message.type === 'result' && !message.is_error) {
          if (message.structured_output && typeof message.structured_output === 'object') {
            result = JSON.stringify(message.structured_output);
            resultSource = 'structured_output';
          } else if (message.result) {
            result = message.result;
            resultSource = 'result';
          }
        }
        const diagnostic = extractCliDiagnostic(message);
        if (diagnostic) cliDiagnostics.push(diagnostic);
      }

      if (!result && lastAssistantText.trim()) {
        result = lastAssistantText;
        resultSource = 'assistant_text';
      }

      if (result) {
        console.log(chalk.cyan(`  [${CLI_STAGE_LABEL}] Result extracted via ${resultSource} (pass ${passNumber})`));
        if (sessionId) {
          console.log(chalk.cyan(`  [${CLI_STAGE_LABEL}] Provider session: ${sessionId}`));
        }
        return { content: result.trim(), sessionId };
      }

      // Stall detection: stop when consecutive passes produce no content
      const hadContent = lastAssistantText.trim().length > 0;
      if (hadContent) {
        stalledPasses = 0;
      } else {
        stalledPasses++;
      }

      if (stalledPasses >= CLI_STALL_THRESHOLD) {
        const detail = lastDiagnostics.length ? ` Diagnostics:\n${lastDiagnostics.join('\n')}` : '';
        throw new AIError(
          `Claude CLI finished without returning a result after ${passNumber} pass(es) — workload not decreasing.${detail}`,
          null,
          true
        );
      }

      lastDiagnostics = cliDiagnostics;

      console.log(chalk.yellow(`\n  [${CLI_STAGE_LABEL}] Pass ${passNumber}: no usable result — resuming session`));
    }
  }

  private async runCodexCliStagePrompt(params: {
    stage: AgentStageName;
    prompt: string;
    systemPrompt: string;
    repoDir?: string;
    onProgress?: StageProgressCallback;
    priorStageSummary?: string;
    resumeProviderSessionId?: string;
  }): Promise<{ content: string; sessionId?: string }> {
    assertCodexCliAvailable();

    const model = this.resolveStageModel(params.stage);
    const resolvedRepoDir = params.repoDir ?? process.cwd();

    const priorStagePreamble = params.priorStageSummary
      ? `<prior-stage-context>\n${params.priorStageSummary}\n</prior-stage-context>\n\nNote: The above is background context from a previous workflow stage.\nYour current stage's instructions take precedence over any conflicting details above.\n\n`
      : '';
    const fullPrompt = `${priorStagePreamble}${params.systemPrompt}\n\n${params.prompt}`;

    const args = buildCodexCliArgs({
      prompt: fullPrompt,
      model,
      cwd: resolvedRepoDir,
      sessionId: params.resumeProviderSessionId,
    });

    let sessionId: string | undefined = params.resumeProviderSessionId;
    let result = '';

    for await (const message of spawnCodex(args, resolvedRepoDir, fullPrompt)) {
      if (message.session_id) sessionId = message.session_id;

      if (params.onProgress && message.summary) {
        params.onProgress(`  [codex-cli] ${message.summary}`);
      }

      if (message.type === 'result' && !message.is_error && message.result) {
        result = message.result;
      }
    }

    if (!result) {
      throw new AIError('Codex CLI finished without returning a result.', null, true);
    }

    if (sessionId) {
      console.log(chalk.gray(`  [codex-cli] Provider session: ${sessionId}`));
    }
    return { content: result.trim(), sessionId };
  }

  private async cliChatTurn(params: {
    stage: AgentStageName;
    userMessage: string;
    systemPrompt: string;
    repoDir?: string;
    session?: AgentChatSession;
  }): Promise<{ content: string; session: AgentChatSession }> {
    assertClaudeCliAvailable();

    const model = this.resolveStageModel(params.stage);
    const resolvedRepoDir = params.repoDir ?? process.cwd();
    const allowInspection = Boolean(params.repoDir);

    let sessionId: string | undefined = params.session?.sessionId;
    let stalledPasses = 0;
    let passNumber = 0;
    let lastDiagnostics: string[] = [];

    while (true) {
      passNumber++;
      const isResume = passNumber > 1 && sessionId;

      const prompt = isResume
        ? 'Your previous response did not include a usable result. Please respond with the requested content directly.'
        : params.userMessage;

      const args = buildCliArgs({
        prompt,
        appendSystemPrompt: params.systemPrompt,
        model,
        cwd: resolvedRepoDir,
        sessionId: isResume ? sessionId : params.session?.sessionId,
        tools: allowInspection ? ['Read', 'Glob', 'Grep', 'Bash'] : [],
        permissionMode: 'plan',
      });

      let result = '';
      let resultSource: 'structured_output' | 'result' | 'assistant_text' | undefined;
      let lastAssistantText = '';
      const cliDiagnostics: string[] = [];

      for await (const message of spawnCli(args, resolvedRepoDir, prompt)) {
        if (message.session_id) sessionId = message.session_id;

        const assistantText = extractAssistantText(message);
        if (assistantText) lastAssistantText = assistantText;

        if (message.type === 'result' && !message.is_error) {
          if (message.structured_output && typeof message.structured_output === 'object') {
            result = JSON.stringify(message.structured_output);
            resultSource = 'structured_output';
          } else if (message.result) {
            result = message.result;
            resultSource = 'result';
          }
        }
        const diagnostic = extractCliDiagnostic(message);
        if (diagnostic) cliDiagnostics.push(diagnostic);
      }

      if (!result && lastAssistantText.trim()) {
        result = lastAssistantText;
        resultSource = 'assistant_text';
      }

      if (result) {
        console.log(chalk.cyan(`  [${CLI_STAGE_LABEL}] Result extracted via ${resultSource} (pass ${passNumber})`));
        return {
          content: result.trim(),
          session: {
            provider: 'anthropic' as const,
            backend: 'cli',
            sessionId,
          },
        };
      }

      // Stall detection: stop when consecutive passes produce no content
      const hadContent = lastAssistantText.trim().length > 0;
      if (hadContent) {
        stalledPasses = 0;
      } else {
        stalledPasses++;
      }

      if (stalledPasses >= CLI_STALL_THRESHOLD) {
        const detail = lastDiagnostics.length ? ` Diagnostics:\n${lastDiagnostics.join('\n')}` : '';
        throw new AIError(
          `Claude CLI finished without returning a result after ${passNumber} pass(es) — workload not decreasing.${detail}`,
          null,
          true
        );
      }

      lastDiagnostics = cliDiagnostics;

      console.log(chalk.yellow(`\n  [${CLI_STAGE_LABEL}] Pass ${passNumber}: no usable result — resuming session`));
    }
  }
}
