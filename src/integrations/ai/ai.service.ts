import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import dayjs from 'dayjs';
import { AIError } from '../../shared/utils/errors';
import { LoggerService } from '../../shared/logger/logger.service';
import { LLM_ADAPTER } from './llm-adapter.interface';
import type { LlmAdapter } from './llm-adapter.interface';
import type { PlanVerificationConfig } from '../../shared/utils/verification-manifest';
import type {
  ReviewTraceCallStackNode,
  ReviewTraceStateTransition,
} from './review-trace';
import { postProcessCodeReview } from '../../review/code-review-post-processing';

/**
 * Strips a single wrapping markdown code fence from LLM output.
 * Handles ```typescript, ```ts, ```js, ```json, and plain ``` fences.
 * When the model adds preamble or trailing text around the fence, the first
 * embedded fence block is extracted instead.
 * @param content Raw LLM response string
 * @returns File content without the outermost code fence, or the original string if none is present
 */
export const stripCodeFences = (content: string): string => {
  // Happy path: the entire response is a single code fence.
  const exactMatch = content.match(/^```[\w]*\n?([\s\S]*?)```\s*$/);
  if (exactMatch) return exactMatch[1];

  // Fallback: the model added preamble or trailing text — extract the first fence.
  const embeddedMatch = content.match(/```[\w]*\n([\s\S]*?)```/);
  if (embeddedMatch) return embeddedMatch[1];

  return content;
};

/**
 * Extract the first balanced JSON object from arbitrary text.
 * Ignores braces inside JSON strings so wrapper text can be skipped safely.
 * @param content Raw content that may contain a JSON object
 * @returns First balanced JSON object substring, or null when none is found
 */
const extractFirstJsonObject = (content: string): string | null => {
  let braceDepth = 0;
  let startIndex = -1;
  let inString = false;
  let isEscaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];

    if (startIndex === -1) {
      if (char === '{') {
        startIndex = index;
        braceDepth = 1;
      }
      continue;
    }

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (char === '\\') {
        isEscaped = true;
        continue;
      }

      if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      braceDepth += 1;
      continue;
    }

    if (char !== '}') {
      continue;
    }

    braceDepth -= 1;
    if (braceDepth === 0) {
      return content.slice(startIndex, index + 1);
    }
  }

  return null;
};

/**
 * Parse JSON from an LLM response after removing common wrapper text or fences.
 * @param content Raw LLM response content
 * @returns Parsed JSON payload
 * @throws SyntaxError when no valid JSON object can be parsed
 */
export const parseJsonResponse = <T>(content: string): T => {
  const trimmedContent = content.trim();
  const strippedContent = stripCodeFences(trimmedContent);
  const candidates = [
    strippedContent,
    extractFirstJsonObject(strippedContent),
    extractFirstJsonObject(trimmedContent),
  ].filter((candidate): candidate is string => Boolean(candidate));

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new SyntaxError('No valid JSON object found in AI response');
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

const REVIEW_TRACE_META_PATTERNS: RegExp[] = [
  /\banalyz(?:e|ed|ing|is)?\b/i,
  /\breviewer?\b/i,
  /\bdiff[_\s-]?loaded\b/i,
  /\bdiff review\b/i,
  /\bticket lookup\b/i,
  /\bpr discovery\b/i,
  /\bcode review complete\b/i,
  /\bissues? found\b/i,
  /\bsuggestions?\b/i,
  /\bapproval status\b/i,
  /\breview flow\b/i,
  /\breview process\b/i,
  /\breviewed\b/i,
];

const REVIEW_TRACE_ANCHOR_PATTERNS: RegExp[] = [
  /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /\bclass\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
  /\b(?:public|private|protected)?\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g,
  /\b(?:this\.)?([A-Za-z_$][\w$]*)\s*=\s*/g,
];

const REVIEW_TRACE_STOP_WORDS = new Set([
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'constructor',
  'default',
  'delete',
  'do',
  'else',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'let',
  'new',
  'null',
  'protected',
  'private',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'undefined',
  'var',
  'while',
  'with',
]);

const extractReviewTraceAnchors = (diff: string): string[] => {
  const anchors = new Set<string>();

  for (const pattern of REVIEW_TRACE_ANCHOR_PATTERNS) {
    for (const match of diff.matchAll(pattern)) {
      const candidate = match[1]?.trim();
      if (!candidate) {
        continue;
      }

      const lowered = candidate.toLowerCase();
      if (REVIEW_TRACE_STOP_WORDS.has(lowered)) {
        continue;
      }

      anchors.add(lowered);
    }
  }

  return [...anchors];
};

const traceContainsCodeAnchors = (
  traceText: string,
  anchors: string[],
): boolean => anchors.some((anchor) => traceText.includes(anchor));

const traceContainsReviewerAnalysisLanguage = (traceText: string): boolean =>
  REVIEW_TRACE_META_PATTERNS.some((pattern) => pattern.test(traceText));

export const sanitizeCodeReviewTrace = (
  review: CodeReview,
  diff: string,
): CodeReview => {
  const traceText = JSON.stringify({
    callStack: review.callStack ?? [],
    stateTransition: review.stateTransition ?? {},
  }).toLowerCase();
  const anchors = extractReviewTraceAnchors(diff);
  const hasCodeAnchors =
    anchors.length > 0 && traceContainsCodeAnchors(traceText, anchors);
  const hasReviewerAnalysisLanguage =
    traceContainsReviewerAnalysisLanguage(traceText);

  if (!hasCodeAnchors || hasReviewerAnalysisLanguage) {
    return {
      ...review,
      traceProvenance: 'unavailable',
      callStack: [],
      stateTransition: {},
    };
  }

  return review;
};

export interface AIRequest {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  context?: Record<string, any>;
  model?: string;
  provider?: string;
  stage?: 'plan' | 'implement' | 'review' | 'generate' | 'commit' | 'create';
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
  stage?: 'plan' | 'implement' | 'review' | 'generate' | 'commit' | 'create';
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
  executionMode?: 'standard' | 'agent';
  traceProvenance?: 'evidence-based' | 'best-effort' | 'unavailable';
  callStack?: ReviewTraceCallStackNode[];
  stateTransition?: ReviewTraceStateTransition;
  suggestions: string[];
  approved: boolean;
}

export interface CodeIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  file?: string;
  line?: number;
  suggestion?: string;
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
    3. A trace provenance label: evidence-based, best-effort, or unavailable
    4. A nested tree-like call stack that walks the changed code path, starting from concrete functions, handlers, or methods in the diff
    5. A frame-aligned state transition tree that captures variable changes between the frames in the call stack, not the reviewer's analysis flow
    6. A suggestion for each issue when remediation is clear — each suggestion must recommend the smallest effective fix (the minimum change that resolves the issue without introducing unnecessary scope). Write suggestions in plain, human-friendly language: be concise, use everyday phrasing, and avoid jargon-heavy or robotic sentences.
    7. Optional trailing suggestions for general follow-up work that is not tied to a single issue — each must also prefer the smallest effective fix and use the same concise, human-friendly tone
    8. Whether the code is approved

    Important trace rules:
    - Describe the code under review, not the review process.
    - Do not return review-process steps such as "diff loaded", "analyzing", "reviewed", or "issues found" in callStack or stateTransition.
    - If the changed code cannot be traced confidently, set traceProvenance to "unavailable" and return empty callStack and stateTransition fields.
    - Evidence-based traces must mention concrete identifiers from the diff.
    - Use concrete code identifiers as callStack node labels, such as Class.method(...), functionName(...), or Client.method(...).
    - Nest child callStack nodes under the parent frame that directly invokes or depends on them.
    - When external effects matter, attach them as leaf nodes beneath the method that performs them, for example HttpClient.get(...), POST /endpoint, or SQL query execution.
    - Prefer executable units over prose: avoid nodes like "validates request", "maps response", or "calls external API" unless the concrete method name is unavailable in the diff.
    - Keep the tree in execution tense by naming the callable units and effect leaves, not by narrating what the reviewer thinks the code does.
    - For the state transition tree, use the same frame labels and capture the variable changes observed at each frame.
    - Use \`captured\` for the variables or objects observed at a frame, and \`changes\` for the values that changed between the current frame and the previous one.
    - For detailed traces, include important intermediate methods, mappers, helpers, and client calls when they materially affect the changed path.
    - Prefer multiple distinct tree levels when downstream dependencies are nested.

    Return ONLY a valid JSON object:
    {
      "summary": "...",
      "issues": [
    {
      "severity": "error|warning|info",
      "message": "...",
          "file": "optional",
          "line": optional_number,
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
        "from": "entry-frame",
        "to": "exit-frame",
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
            },
            "children": []
          }
        ]
      },
      "suggestions": ["general follow-up suggestion 1", ...],
      "approved": true|false
    }`;

    const response = await this.execute({
      prompt,
      systemPrompt,
      temperature: 0.3,
      stage: 'review',
    });

    try {
      const parsed = parseJsonResponse<CodeReview>(response.content);
      const processedReview = postProcessCodeReview(
        sanitizeCodeReviewTrace(parsed, diff),
        diff,
      );
      return {
        ...processedReview.review,
        executionMode: 'standard',
      };
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
    stage?: 'plan' | 'implement' | 'review' | 'generate' | 'commit' | 'create',
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
