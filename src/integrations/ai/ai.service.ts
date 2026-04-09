import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import dayjs from 'dayjs';
import { AIError } from '../../shared/utils/errors';
import { LoggerService } from '../../shared/logger/logger.service';
import { LLM_ADAPTER } from './llm-adapter.interface';
import type { LlmAdapter } from './llm-adapter.interface';
import type { PlanVerificationConfig } from '../../shared/utils/verification-manifest';
import type { FixPlan } from '../../agents/interfaces';

/**
 * Strips a single wrapping markdown code fence from LLM output.
 * Handles ```typescript, ```ts, ```js, ```json, and plain ``` fences.
 * When the model adds preamble or trailing text around the fence, the first
 * embedded fence block is extracted instead.
 * @param content Raw LLM response string
 * @returns File content without the outermost code fence, or the original string if none is present
 */
const stripCodeFences = (content: string): string => {
  // Happy path: the entire response is a single code fence.
  const exactMatch = content.match(/^```[\w]*\n?([\s\S]*?)```\s*$/);
  if (exactMatch) return exactMatch[1];

  // Fallback: the model added preamble or trailing text — extract the first fence.
  const embeddedMatch = content.match(/```[\w]*\n([\s\S]*?)```/);
  if (embeddedMatch) return embeddedMatch[1];

  return content;
};

/**
 * Normalize a repository hint for plan prompt examples.
 *
 * @param repositories - Optional affected repository list
 * @returns First repository name or a generic fallback
 */
const resolvePlanPromptRepoExample = (repositories?: string[]): string => {
  const firstRepository = repositories?.find(
    (repository) => typeof repository === 'string' && repository.trim(),
  );
  return firstRepository?.trim() || 'current-repo';
};

/**
 * Derive prompt guardrails from repository test-runner/config context so
 * implement and diagnosis calls stay aligned with the repo's actual tools.
 *
 * The current use case is reducing framework drift between Jest and Vitest,
 * but the guardrail text stays generic enough for future runner detection.
 *
 * @param repoContext - package.json plus discovered config files
 * @returns Prompt guardrail lines to append to system prompts
 */
const buildRepoGuardrails = (repoContext?: {
  packageJson?: string;
  configFiles: Record<string, string>;
}): string[] => {
  if (!repoContext) {
    return [];
  }

  const configFileNames = Object.keys(repoContext.configFiles);
  const packageJson = repoContext.packageJson?.toLowerCase() ?? '';
  const hasJestConfig = configFileNames.some((fileName) =>
    /^jest\.config\./.test(fileName),
  );
  const hasVitestConfig = configFileNames.some((fileName) =>
    /^vitest\.config\./.test(fileName),
  );
  const mentionsJest = hasJestConfig || /\bjest\b/.test(packageJson);
  const mentionsVitest = hasVitestConfig || /\bvitest\b/.test(packageJson);
  const guardrails: string[] = [
    'Follow the repository package.json scripts and config files exactly when choosing test APIs and imports.',
  ];

  if (mentionsJest && !mentionsVitest) {
    guardrails.push('Detected test framework: Jest.');
    guardrails.push(
      'Do not import from vitest or use Vitest-only APIs unless the repo already has Vitest configured.',
    );
  } else if (mentionsVitest && !mentionsJest) {
    guardrails.push('Detected test framework: Vitest.');
    guardrails.push(
      'Do not import from jest or use Jest-only globals unless the repo already has Jest configured.',
    );
  }

  return guardrails;
};

/**
 * Render repository context into prompt-friendly text so the model sees the
 * package scripts and config files that define the repo's test framework.
 *
 * @param repoContext - package.json plus discovered config files
 * @returns Prompt section or an empty string when no context was provided
 */
const formatRepoContextSection = (repoContext?: {
  packageJson?: string;
  configFiles: Record<string, string>;
}): string => {
  if (!repoContext) {
    return '';
  }

  const configSection = Object.entries(repoContext.configFiles)
    .map(([fileName, content]) => `// ${fileName}\n${content}`)
    .join('\n\n---\n\n');

  return [
    'Repository context:',
    'package.json',
    repoContext.packageJson ?? '(none)',
    '',
    'Config files:',
    configSection || '(none)',
  ].join('\n');
};

export interface AIRequest {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  context?: Record<string, any>;
  model?: string;
  provider?: string;
  stage?: 'plan' | 'implement' | 'review' | 'generate' | 'commit';
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
  stage?: 'plan' | 'implement' | 'review' | 'generate' | 'commit';
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
  verification?: PlanVerificationConfig;
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
    const repoExample = resolvePlanPromptRepoExample(
      context?.affectedRepositories as string[] | undefined,
    );

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
7. Task-specific verification only when needed:
   - Use "verification.targeted" for focused checks required by this specific plan
   - Use "verification.waivers" only when this plan needs to explicitly waive a repo-level baseline check
   - Omit "verification" entirely when no targeted checks or waivers are needed
   - Keep verification tool-agnostic and command-based, e.g. "npm run test:manual -- test-issue-review"
   - Verification commands run from the selected repository root; do not prefix them with "cd <repo>" or any other repo-selection step
   - Every verification command must exit 0 when it succeeds
   - If you need to prove an expected failure, wrap it in a shell assertion that exits 0 when the expected failure occurs.

Return ONLY a valid JSON object with these fields:
{
  "action": "${action}",
  "summary": "...",
  "steps": ["step 1", "step 2", ...],
  "estimatedComplexity": "low|medium|high",
  "filesAffected": ["${repoExample}/src/path/to/file.ts", ...],
  "repositoriesAffected": ["${repoExample}", ...],
  "risks": ["risk 1", ...],
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
    repoContext?: {
      packageJson?: string;
      configFiles: Record<string, string>;
    };
  }): Promise<string> {
    const repoGuardrails = buildRepoGuardrails(params.repoContext);
    const systemPrompt = `You are an expert software engineer implementing code changes.
Return ONLY the complete updated file content — no explanation, no markdown code blocks, no surrounding text.

Scene context: you are implementing one file as part of a larger plan. The plan narration is included in the ticket context above. Apply only the steps that are relevant to this specific file.

Your response will be written byte-for-byte to disk as a TypeScript source file.
Any character that is not valid TypeScript syntax will immediately cause a SyntaxError.

Before returning, silently verify (do not write these checks into the output):
1. Every plan step relevant to this file is implemented
2. No unrequested additions (YAGNI)
3. Names describe what things do, not how they work
4. Diagnostics inform code edits — do not explain, reason, or comment on them
${repoGuardrails.length > 0 ? `\n5. Repository guardrails:\n${repoGuardrails.map((guardrail) => `- ${guardrail}`).join('\n')}` : ''}`;

    const prompt = `Ticket context:
${params.ticketContent.substring(0, 2000)}

Implementation steps:
${params.planSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
${params.conversationContext ? `\n${params.conversationContext}\n` : ''}
${params.repoContext ? `\n${formatRepoContextSection(params.repoContext)}\n` : ''}
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

  /**
   * Diagnoses a verification failure and produces a structured fix plan.
   * Called on retry attempt 2+ so the next generateFileChange() calls share context.
   *
   * @param params.implicatedFileContents - Disk state of files mentioned in diagnostics
   * @param params.relatedFileContents - Depth-1 import-chain files from implicated files
   * @param params.testSources - Test files relevant to the failure (when test failure detected)
   * @param params.diagnostics - Raw verification diagnostics text
   * @param params.planSteps - Original plan steps for context
   * @returns Structured FixPlan; throws on parse failure (caller falls back to prose retry)
   */
  async diagnoseVerificationFailure(params: {
    implicatedFileContents: Record<string, string>;
    relatedFileContents: Record<string, string>;
    testSources: Record<string, string>;
    repoContext?: {
      packageJson?: string;
      configFiles: Record<string, string>;
    };
    diagnostics: string;
    planSteps: string[];
    classification?: {
      category: string;
      rootSignal: string;
      strategy: string;
    };
  }): Promise<FixPlan> {
    const repoGuardrails = buildRepoGuardrails(params.repoContext);
    const systemPrompt = `You are an expert TypeScript software engineer diagnosing verification failures.
Analyse the failing file contents, related type definitions, test sources, and diagnostic output.
Prefer the smallest next-change surface that can satisfy the latest verification failure.
Do not include documentation, mapping, or unrelated support files unless the diagnostics require edits there.
Return ONLY a valid JSON object — no markdown fences, no explanation text.
${repoGuardrails.length > 0 ? `\nRepository guardrails:\n${repoGuardrails.map((guardrail) => `- ${guardrail}`).join('\n')}` : ''}`;

    const implicatedSection = Object.entries(params.implicatedFileContents)
      .map(([file, content]) => `// ${file}\n${content}`)
      .join('\n\n---\n\n');

    const relatedSection = Object.entries(params.relatedFileContents)
      .map(([file, content]) => `// ${file}\n${content}`)
      .join('\n\n---\n\n');

    const testSection = Object.entries(params.testSources)
      .map(([file, content]) => `// ${file}\n${content}`)
      .join('\n\n---\n\n');
    const prompt = `Plan steps:
${params.planSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

Diagnostics:
${params.diagnostics}

Failure classification:
${params.classification ? `- Category: ${params.classification.category}\n- Root signal: ${params.classification.rootSignal}\n- Retry strategy: ${params.classification.strategy}` : '- Category: unknown\n- Root signal: n/a\n- Retry strategy: broad-context'}

Implicated files (current disk state):
${implicatedSection || '(none)'}

Related type files (depth-1 imports):
${relatedSection || '(none)'}

Test sources:
${testSection || '(none)'}

${formatRepoContextSection(params.repoContext)}

Diagnose the root cause and return a fix plan. List only the files that should change on the next retry pass:
{
  "summary": "One-sentence root-cause description",
  "fixes": [
    {
      "file": "relative/path/to/file.ts",
      "rationale": "What to change and why",
      "relatedFiles": ["relative/path/to/sibling.ts"]
    }
  ],
  "testContext": "Optional: what the tests expect that the implementation must satisfy"
}`;

    const response = await this.execute({
      prompt,
      systemPrompt,
      temperature: 0.2,
      maxTokens: 4096,
      stage: 'implement',
    });

    const stripped = stripCodeFences(response.content.trim());
    return JSON.parse(stripped) as FixPlan;
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
    if (provider === 'google') return 'Google Gemini';
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
    if (provider === 'google') return 'Gemini';
    if (provider === 'deepseek') return 'DeepSeek';
    return 'Claude';
  }

  private resolveAiTarget(
    stage?: 'plan' | 'implement' | 'review' | 'generate' | 'commit',
    providerOverride?: string,
    modelOverride?: string,
  ): { provider?: string; model?: string } {
    if (providerOverride || modelOverride) {
      if (!providerOverride || !modelOverride) {
        throw new AIError(
          'AI provider and model overrides must be supplied together.',
        );
      }

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

    const stageProvider =
      this.configService.get<string>(`stages.${stage}.provider`) ??
      this.configService.get<string>(`ai.stages.${stage}.provider`);
    const stageModel =
      this.configService.get<string>(`stages.${stage}.model`) ??
      this.configService.get<string>(`ai.stages.${stage}.model`);

    if (!stageProvider && !stageModel) {
      return { provider, model };
    }

    if (!stageProvider || !stageModel) {
      throw new AIError(
        `AI stage target for "${stage}" must define provider and model together.`,
      );
    }

    return {
      provider: stageProvider,
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
