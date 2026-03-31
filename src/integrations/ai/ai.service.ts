import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import dayjs from 'dayjs';
import { AIError } from '../../shared/utils/errors';
import { LoggerService } from '../../shared/logger/logger.service';
import { LLM_ADAPTER } from './llm-adapter.interface';
import type { LlmAdapter } from './llm-adapter.interface';

/**
 * Strips a single wrapping markdown code fence from LLM output.
 * Handles ```typescript, ```ts, ```js, ```json, and plain ``` fences.
 * @param content Raw LLM response string
 * @returns File content without the outermost code fence, or the original string if none is present
 */
const stripCodeFences = (content: string): string => {
  const match = content.match(/^```[\w]*\n?([\s\S]*?)```\s*$/);
  return match ? match[1] : content;
};

export interface AIRequest {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  context?: Record<string, any>;
  model?: string;
  provider?: string;
  stage?: 'plan' | 'implement' | 'review' | 'generate';
}

export interface AIResponse {
  content: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Request interface for multi-turn conversations
 * Supports passing full conversation history to maintain context
 */
export interface AIConversationRequest {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  model?: string;
  provider?: string;
  stage?: 'plan' | 'implement' | 'review' | 'generate';
}

export interface FindingsDocument {
  action: 'investigate';
  summary: string;
  findings: string[];
  recommendations: string[];
  conclusion: string;
}

export interface ResolutionPlan {
  action: 'fix' | 'feature' | 'investigate';
  summary: string;
  steps: string[];
  estimatedComplexity: 'low' | 'medium' | 'high';
  filesAffected?: string[];
  repositoriesAffected?: string[];
  risks?: string[];
  provider?: string;
  source?: string;
  timestamp?: string;
}

export interface CodeReview {
  summary: string;
  issues: CodeIssue[];
  suggestions: string[];
  approved: boolean;
}

export interface CodeIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  file?: string;
  line?: number;
}

@Injectable()
export class AiService {
  constructor(
    private logger: LoggerService,
    @Inject(LLM_ADAPTER) private adapter: LlmAdapter,
    private configService: ConfigService,
  ) {}

  async execute(request: AIRequest): Promise<AIResponse> {
    return this.adapter.execute({
      ...request,
      ...this.resolveAiTarget(request.stage, request.provider, request.model),
    });
  }

  /**
   * Execute a multi-turn conversation with the configured LLM provider.
   * Maintains conversation history by passing full message array to the adapter.
   *
   * @param request - Conversation request with message history
   * @returns AI response with content and token usage
   */
  async executeWithHistory(
    request: AIConversationRequest,
  ): Promise<AIResponse> {
    return this.adapter.executeWithHistory({
      ...request,
      ...this.resolveAiTarget(request.stage, request.provider, request.model),
    });
  }

  async generatePlan(
    action: 'fix' | 'implement' | 'investigate',
    issueContent: string,
    context?: Record<string, any>,
  ): Promise<ResolutionPlan> {
    const systemPrompt = `You are an expert software engineer creating detailed resolution plans.
Your task is to analyze the issue and create a structured plan with clear, actionable steps.
Return your response as a JSON object matching the ResolutionPlan interface.`;

    const repoHint = context?.affectedRepositories?.length
      ? `Affected repositories (hint): ${(context.affectedRepositories as string[]).join(', ')}\n\n`
      : '';

    const prompt = `
Action: ${action}
Issue Content:
${issueContent}

${context ? `Context:\n${JSON.stringify(context, null, 2)}` : ''}

${repoHint}Create a detailed resolution plan with:
1. A brief summary of the issue and proposed solution
2. Specific, actionable steps to ${action} the issue
3. Estimated complexity (low/medium/high)
4. Files that will be affected — prefix EVERY path with its repository name
   (e.g., "service-tourv3/src/pricing/pricing.service.ts"). Use the repository
   names from repositoriesAffected when available.
5. Potential risks or considerations
6. Repositories that will be affected (if known — use provided hints or infer from ticket text)

Return ONLY a valid JSON object with these fields:
{
  "action": "${action}",
  "summary": "...",
  "steps": ["step 1", "step 2", ...],
  "estimatedComplexity": "low|medium|high",
  "filesAffected": ["repo-name/src/path/to/file.ts", ...],
  "repositoriesAffected": ["repo-name", ...],
  "risks": ["risk 1", ...]
}`;

    const response = await this.execute({
      prompt,
      systemPrompt,
      temperature: 0.5,
      stage: 'plan',
    });

    try {
      const stripped = stripCodeFences(response.content.trim());
      const plan = JSON.parse(stripped) as ResolutionPlan;

      const rawSteps: unknown[] = Array.isArray(plan.steps) ? plan.steps : [];
      plan.steps = rawSteps.map((step) => {
        if (typeof step === 'string') return step;
        if (step && typeof step === 'object') {
          const s = step as Record<string, unknown>;
          const text =
            s['description'] ?? s['text'] ?? s['title'] ?? s['content'];
          if (typeof text === 'string') return text;
        }
        return String(step);
      });

      const provider = this.configService.get<string>(
        'ai.provider',
        'anthropic',
      );
      const model = this.configService.get<string>('ai.model', '');
      const prefixMap: Record<string, string> = {
        anthropic: 'claude-',
        gemini: 'gemini-',
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
      this.logger.error('Failed to parse AI response as JSON', error);
      throw new AIError('Failed to parse resolution plan from AI response', {
        response: response.content,
        error,
      });
    }
  }

  /**
   * Generate structured findings and recommendations from an investigation plan.
   *
   * @param plan - The investigation plan produced by PlannerAgent
   * @param ticketContent - Optional ticket markdown for additional context
   * @returns Structured findings document with findings and recommendations
   */
  async generateFindings(
    plan: ResolutionPlan,
    ticketContent?: string,
  ): Promise<FindingsDocument> {
    const systemPrompt = `You are an expert software investigator providing structured findings and recommendations.
Analyse the given investigation plan and any available ticket context to produce clear, actionable findings.
Return your response as a JSON object.`;

    const prompt = `
Investigation Plan:
${JSON.stringify(plan, null, 2)}
${ticketContent ? `\nTicket Context:\n${ticketContent}\n` : ''}
Perform the investigation described in the plan and generate structured findings and recommendations.

Return ONLY a valid JSON object:
{
  "action": "investigate",
  "summary": "Brief summary of what was investigated and the key findings",
  "findings": ["finding 1", "finding 2", ...],
  "recommendations": ["recommendation 1", ...],
  "conclusion": "Overall conclusion and suggested next steps"
}`;

    const response = await this.execute({
      prompt,
      systemPrompt,
      temperature: 0.4,
      stage: 'implement',
    });

    try {
      const stripped = stripCodeFences(response.content.trim());
      return JSON.parse(stripped) as FindingsDocument;
    } catch (error) {
      this.logger.error('Failed to parse findings response', error);
      throw new AIError(
        'Failed to parse investigation findings from AI response',
        {
          response: response.content,
          error,
        },
      );
    }
  }

  /**
   * Produce a structured narration of the implementation plan to be shown
   * to the developer before any file edits begin. Borrows the writing-plans
   * skill pattern: Goal / Approach / Tasks.
   *
   * @param ticketContent - Raw ticket markdown for context
   * @param plan - The resolution plan produced by PlannerAgent
   * @returns Plain-text narration string with ## Goal, ## Approach, ## Tasks sections
   */
  async narrateImplementationPlan(
    ticketContent: string,
    plan: ResolutionPlan,
  ): Promise<string> {
    const systemPrompt = `You are a senior software engineer narrating an implementation plan.
Produce a concise, structured narration that helps the developer understand what will be done and why.
Return ONLY the narration text — no markdown code fences, no preamble.
Use exactly this structure:

## Goal
(One sentence describing the outcome.)

## Approach
(Two to three sentences on the architectural approach: which layers are touched, key patterns used, and what is intentionally left unchanged.)

## Tasks
(Numbered list. Each item: "<file path> — <what changes> [depends on: <dependency or risk if any>]")`;

    const prompt = `Ticket context:
${ticketContent.substring(0, 800)}

Plan summary: ${plan.summary}
Action: ${plan.action}
Estimated complexity: ${plan.estimatedComplexity}
Steps:
${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
Files affected:
${(plan.filesAffected ?? []).join('\n') || '(none listed)'}
Risks:
${(plan.risks ?? []).join('\n') || '(none listed)'}

Narrate this plan using the structure in the system prompt.`;

    const response = await this.execute({
      prompt,
      systemPrompt,
      temperature: 0.4,
      maxTokens: 1024,
    });

    return response.content.trim();
  }

  async generateCommitMessage(
    diff: string,
    commitHistory: string[],
    format: 'conventional' | 'freeform' | 'auto' = 'auto',
    ticketContext?: string,
  ): Promise<string> {
    const systemPrompt = `You are an expert at writing clear, concise git commit messages.
Analyze the diff and commit history to generate an appropriate commit message.`;

    // Detect format from commit history if auto
    let detectedFormat = format;
    if (format === 'auto' && commitHistory.length > 0) {
      detectedFormat = this.detectCommitFormat(commitHistory);
    }

    const formatInstructions =
      detectedFormat === 'conventional'
        ? `Use conventional commits format: <type>(<scope>): <subject>
Types: feat, fix, docs, style, refactor, test, chore
Example: "feat(auth): add JWT token validation"`
        : 'Write a clear, concise commit message describing the changes';

    const ticketContextSection = ticketContext
      ? `Ticket context: ${ticketContext}\n\n`
      : '';

    const prompt = `
${ticketContextSection}Git Diff:
\`\`\`
${diff.substring(0, 3000)} ${diff.length > 3000 ? '...(truncated)' : ''}
\`\`\`

Recent Commit History:
${commitHistory.slice(0, 5).join('\n')}

${formatInstructions}

Generate a commit message that:
1. Reflects the ticket's intent, not just the code change pattern
2. Follows the repository's commit message style
3. Is concise but informative
4. ${detectedFormat === 'conventional' ? 'Follows conventional commits format' : 'Follows the existing commit message style'}

Do NOT include ticket IDs, issue keys, or project codes in your message (e.g. WBP-1234, TAD-575). The ticket prefix is added automatically.
Return ONLY the commit message description, nothing else.`;

    const response = await this.execute({
      prompt,
      systemPrompt,
      temperature: 0.3,
      maxTokens: 200,
    });

    return response.content.trim();
  }

  /**
   * Generate the complete updated content for a single file based on the
   * ticket context and plan steps. Returns only the file content — no
   * markdown fences, no explanation text.
   *
   * @param params.ticketContent - Raw ticket markdown for context
   * @param params.planSteps - Ordered implementation steps from the plan
   * @param params.filePath - Relative path of the file being updated
   * @param params.existingContent - Current file content (empty string for new files)
   * @returns The full updated file content ready to write to disk
   */
  async generateFileChange(params: {
    ticketContent: string;
    planSteps: string[];
    filePath: string;
    existingContent: string;
    conversationContext?: string;
  }): Promise<string> {
    const systemPrompt = `You are an expert software engineer implementing code changes.
Return ONLY the complete updated file content — no explanation, no markdown code blocks, no surrounding text.

Scene context: you are implementing one file as part of a larger plan. The plan narration is included in the ticket context above. Apply only the steps that are relevant to this specific file.

Self-review before returning:
1. Completeness — did you implement every plan step that touches this file?
2. YAGNI — did you add anything not requested by the plan?
3. Naming — do all names describe what things do, not how they work?
Handle any issues silently in the code before returning.`;

    const prompt = `Ticket context:
${params.ticketContent.substring(0, 2000)}

Implementation steps:
${params.planSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
${params.conversationContext ? `\n${params.conversationContext}\n` : ''}
File: ${params.filePath}
Current content:
${params.existingContent || '(empty — create this file from scratch)'}

Apply the relevant steps to this file. Return ONLY the complete updated file content.`;

    const response = await this.execute({
      prompt,
      systemPrompt,
      temperature: 0.2,
      maxTokens: 8192,
      stage: 'implement',
    });

    return stripCodeFences(response.content.trim());
  }

  async reviewCode(diff: string, guidelines: string[]): Promise<CodeReview> {
    const systemPrompt = `You are an expert code reviewer providing constructive feedback.
Focus on code quality, best practices, potential bugs, and security issues.
Ignore any changes to JSON or markdown files under \`.wf/\` or platform artefact directories (jira/, bitbucket/) — review only application source code.
Return your response as a JSON object matching the CodeReview interface.`;

    const prompt = `
Code Changes:
\`\`\`
${diff.substring(0, 5000)} ${diff.length > 5000 ? '...(truncated)' : ''}
\`\`\`

Review Guidelines:
${guidelines.map((g, i) => `${i + 1}. ${g}`).join('\n')}

Provide a code review with:
1. A brief summary of the changes
2. Any issues found (errors, warnings, or info)
3. Suggestions for improvement
4. Whether the code is approved

Return ONLY a valid JSON object:
{
  "summary": "...",
  "issues": [
    {
      "severity": "error|warning|info",
      "message": "...",
      "file": "optional",
      "line": optional_number
    }
  ],
  "suggestions": ["suggestion 1", ...],
  "approved": true|false
}`;

    const response = await this.execute({
      prompt,
      systemPrompt,
      temperature: 0.3,
      stage: 'review',
    });

    try {
      const stripped = stripCodeFences(response.content.trim());
      return JSON.parse(stripped) as CodeReview;
    } catch (error) {
      this.logger.error('Failed to parse code review response', error);
      throw new AIError('Failed to parse code review from AI response', {
        response: response.content,
        error,
      });
    }
  }

  /**
   * Returns the full AI provider display name for use in dry-run previews.
   * Reads ai.provider from config (default: 'anthropic').
   *
   * @returns 'Anthropic Claude' | 'OpenAI' | 'Google Gemini' | 'DeepSeek'
   */
  getProviderDisplayName(): string {
    const provider = this.configService.get<string>('ai.provider', 'anthropic');
    if (provider === 'openai') return 'OpenAI';
    if (provider === 'gemini') return 'Google Gemini';
    if (provider === 'deepseek') return 'DeepSeek';
    return 'Anthropic Claude';
  }

  /**
   * Returns a short AI provider name for use in interactive chat UI labels.
   * Reads ai.provider from config (default: 'anthropic').
   *
   * @returns 'Claude' | 'OpenAI' | 'Gemini' | 'DeepSeek'
   */
  getProviderShortName(): string {
    const provider = this.configService.get<string>('ai.provider', 'anthropic');
    if (provider === 'openai') return 'OpenAI';
    if (provider === 'gemini') return 'Gemini';
    if (provider === 'deepseek') return 'DeepSeek';
    return 'Claude';
  }

  private resolveAiTarget(
    stage?: 'plan' | 'implement' | 'review' | 'generate',
    providerOverride?: string,
    modelOverride?: string,
  ): { provider?: string; model?: string } {
    if (providerOverride || modelOverride) {
      return {
        provider: providerOverride,
        model: modelOverride,
      };
    }

    const provider = this.configService.get<string>('ai.provider', 'anthropic');
    const model = this.configService.get<string>('ai.model', '');

    if (!stage) {
      return { provider, model };
    }

    const stageModel =
      this.configService.get<string>(`ai.stages.${stage}`) ??
      this.configService.get<Record<string, string>>('ai.stages', {})?.[stage];

    if (!stageModel) {
      return { provider, model };
    }

    const providers =
      this.configService.get<
        Array<{ name: string; model?: string; default?: boolean }>
      >('ai.providers', []) ?? [];
    const matchingProvider = providers.find(
      (candidate) => candidate.model === stageModel,
    );

    return {
      provider: matchingProvider?.name ?? provider,
      model: stageModel,
    };
  }

  private detectCommitFormat(
    commitHistory: string[],
  ): 'conventional' | 'freeform' {
    const conventionalPattern =
      /^(feat|fix|docs|style|refactor|test|chore)(\(.+\))?:/;
    const conventionalCount = commitHistory.filter((msg) =>
      conventionalPattern.test(msg),
    ).length;

    // If more than 60% use conventional format, use it
    return conventionalCount / commitHistory.length > 0.6
      ? 'conventional'
      : 'freeform';
  }
}
