import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Agent, OpenAIProvider, Runner, setTracingExportApiKey, tool } from '@openai/agents';
import type { JsonSchemaDefinition } from '@openai/agents';
import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import chalk from 'chalk';
import dayjs from 'dayjs';
import { formatProgressMessage as formatAnthropicProgressMessage } from './adapters/anthropic-agent.adapter';
import { isUnavailableModelError } from './adapters/ai-provider-error.classify';
import { estimateOpenAiCostUsd, extractUsageFromEvent, formatProgressMessage as formatOpenAiProgressMessage } from './adapters/openai-agent.adapter';
import { loadAnthropicAgentSdk } from './adapters/load-anthropic-agent-sdk';
import { loadAiContextConfig } from './adapters/load-ai-context-config';
import { discoverDirAgentConfigs } from './adapters/discover-dir-agent-configs';
import { JSON_OUTPUT_RULES } from './json-output-rules';
import {
  buildPlanSkillSection,
  buildPlanTestConventionsBlock,
  buildPlanVerificationBlock,
  buildReviewSkillSection,
  buildUiDesignComplianceSystemPromptSection,
  deriveModelSource,
  formatFigmaPlanPromptSection,
  planFileListingInstructions,
  planMinimalChangePrinciple,
  planStepPrinciples,
  reviewInstructions,
  reviewOutputSchema,
  reviewTraceGuidance,
} from './prompt-fragments';
import type { UiDesignScreenshot } from '../../shared/types/ui-design-screenshot';
import { appendToLogFile } from '../../shared/logger/log-file-writer';
import { DEFAULT_STALL_THRESHOLD } from './adapters/verification-report';
import { assertClaudeCliAvailable, buildCliArgs, CLI_INACTIVITY_TIMEOUT_MS, type ClaudeCliMessage, spawnCli } from './adapters/claude-cli-runner';
import {
  assertCodexCliAvailable,
  buildCodexCliArgs,
  type CodexCliMessage,
  spawnCodex,
} from './adapters/codex-cli-runner';
import type { WfBackendMode } from '../../config/public-config';
import { resolveDefaultStageBackend } from '../../config/stage-backend-defaults';
import {
  CodeReview,
  normalizeFileEntries,
  parseJsonResponse,
  requireAiResponseContent,
  requireReviewResponseContent,
  ResolutionPlan,
  sanitizeCodeReviewTrace,
} from './ai.service';
import type { AIRequest } from '../../shared/types/ai.types';
import { resolutionPlanSchema } from '../../shared/schemas/ai.schema';
import { codeReviewSchema } from '../../shared/schemas/review.schema';
import { generateTicketSchema } from '../../shared/schemas/generate-ticket.schema';
import { AiProviderError, ConfigurationError, ExecutionError, isAiProviderErrorLike } from '../../shared/utils/errors';
import { formatZodError, isZodErrorLike } from '../../shared/utils/zod-error.util';
import type { TestInfraContext } from '../../shared/types/detection.types';
import type { WfAiProviderName } from '../../shared/types/config.types';
import { formatTestInfraPromptSection } from '../../shared/utils/detect-test-infra';
import { postProcessCodeReview } from '../../review/code-review-post-processing';
import {
  formatRepoConventionsPromptSection,
  type RepoConventionsContext,
} from '../../shared/utils/detect-repo-conventions';
import { isUiRelevantTicket } from '../../shared/utils/detect-ui-relevance';
import {
  formatPlanCorrelationPromptSection,
  formatPriorPlansPromptSection,
  type PlanCorrelationResult,
  type PriorPlanContext,
} from '../../shared/utils/detect-prior-plans';
import {
  type CrossRepoContext,
  formatCrossRepoPatternsPromptSection,
} from '../../shared/utils/detect-cross-repo-patterns';
import {
  type ReuseCandidateContext,
  formatReuseCandidatesPromptSection,
} from '../../shared/utils/detect-reuse-candidates';
import type { AgentStageName, StageProgressCallback } from '../../shared/types/agent.types';
import { resolveProviderModel } from './adapters/shared-routing';
import { estimateLlmCostUsd } from './llm-cost';
import { buildSanitisedJsonSchema, normalizeOpenAiJsonSchema, serializeOpenAiJsonSchema } from './schema/openai-json-schema';
export { buildSanitisedJsonSchema } from './schema/openai-json-schema';

const execAsync = promisify(exec);
const MAX_BUFFER_IN_BYTES = 1024 * 1024 * 4;
const OPENAI_STAGE_MAX_TURNS = 16;
const OPENAI_CHAT_MAX_TURNS = 8;
const READ_ONLY_OPENAI_MODEL = 'gpt-5.4-mini';
const READ_ONLY_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_STAGE_TOOLS = ['Read', 'Glob', 'Grep', 'Bash'] as const;
const allowedReadOnlyCommandPrefixes = [
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
const CLI_STALL_THRESHOLD = DEFAULT_STALL_THRESHOLD;
const CLI_REVIEW_EPILOGUE_TIMEOUT_MS = 30_000;
const cliEpiloguePrompt
  = 'Summarize the review for the developer: approval status, issue count by severity, '
    + 'and your top suggestions. Keep it brief and human-readable.';
const DEFAULT_CLI_WALL_CLOCK_TIMEOUT_MS = 30 * 60 * 1000;

const CODEX_STAGE_LABEL = 'codex-cli';

const cliRetryPrompt
  = String.raw`Your previous response did not include a usable result. Please output ONLY a valid JSON object matching the JSON schema provided in the original instructions. Do not include commentary or markdown — IMPORTANT: raw, minified JSON only (no unnecessary whitespace or newlines). JSON string values must not contain literal newline characters — use \n for line breaks within strings.`;

const MAX_CLI_SCHEMA_MISSES = 1;

type CliPassOutcome
  = { kind: 'completed'; content: string; sessionId?: string }
    | { kind: 'schema-retry'; content: string; issues: string }
    | { kind: 'no-result' };

const cliChatRetryPrompt
  = 'Your previous response did not include a usable result. Please respond with the requested content directly.';

type CliPassResult = {
  costUsd?: number;
  diagnostics: string[];
  hadContent: boolean;
  result: string;
  schemaExpected?: boolean;
  sessionId: string | undefined;
  source: 'structured_output' | 'result' | 'assistant_text' | undefined;
  stopReason: string | undefined;
};

type CliChatPassOpts = {
  initialSessionId?: string;
  jsonSchema?: string;
  model: string;
  repoDir?: string;
  responseValidator?: ResponseValidator;
  stage: AgentStageName;
  systemPrompt: string;
  userMessage: string;
};

type CliStagePassOpts = {
  forkSession?: boolean;
  jsonSchema?: string;
  model: string;
  onProgress?: StageProgressCallback;
  passNumber?: number;
  prompt: string;
  repoDir?: string;
  responseValidator?: ResponseValidator;
  resumeProviderSessionId?: string;
  screenshots?: UiDesignScreenshot[];
  sessionId?: string;
  stage: AgentStageName;
  systemPrompt: string;
};

const planSystemPrompt = `You are a software architect producing resolution plans. Prioritize correctness and minimal blast radius.
You may inspect repository files with read-only tools before answering.
Return your response as a JSON object matching the ResolutionPlan interface.`;

const reviewSystemPrompt = `You are a code reviewer. Assess quality, correctness, and security using your judgment — flag what matters, skip noise.
You may inspect repository files with read-only tools before answering.
Ignore JSON or markdown files under .wf/ and tracker artifact directories.
Return your response as a JSON object matching the CodeReview interface.`;

const generateSystemPrompt = `You are a Jira ticket author. Return ONLY a valid JSON object matching the provided output schema.
Use formal British English, active voice, and no contractions.
Do not inspect local repository files in this run.`;

const truncateCodexText = (text: string, maxLength: number): string =>
  text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;

const resolveExitStatus = (exitCode?: number): string => {
  if (exitCode == null) return 'status unknown';
  return exitCode === 0 ? 'completed' : `exit ${exitCode}`;
};

const formatCodexCommandCompletion = (item: { exit_code?: number | null; command?: string }): string =>
  `  [${CODEX_STAGE_LABEL}] Command ${resolveExitStatus(item.exit_code ?? undefined)}: ${truncateCodexText(item.command ?? 'unknown', 60)}`;

const formatCodexCompletedItem = (message: CodexCliMessage): string | null => {
  if (message.item?.type === 'agent_message' && message.item.text) return `  [${CODEX_STAGE_LABEL}] Agent: ${truncateCodexText(message.item.text, 120)}`;
  if (message.item?.type === 'command_execution') return formatCodexCommandCompletion(message.item);
  return null;
};

const formatCodexProgressMessage = (message: CodexCliMessage): string | null => {
  if (message.type === 'thread.started' && message.thread_id) return `  [${CODEX_STAGE_LABEL}] Session started: ${message.thread_id}`;
  if (message.type === 'item.started' && message.item?.type === 'command_execution' && message.item.command) return `  [${CODEX_STAGE_LABEL}] Running: ${truncateCodexText(message.item.command, 80)}`;
  if (message.type === 'item.completed') return formatCodexCompletedItem(message);
  if (message.type === 'turn.completed' && message.usage) return `  [${CODEX_STAGE_LABEL}] Turn complete (${message.usage.input_tokens} in / ${message.usage.output_tokens} out)`;
  return null;
};

const extractTextBlockContent = (block: unknown): string => {
  if (typeof block !== 'object' || block === null) return '';
  const record = block as Record<string, unknown>;
  return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
};

const extractAssistantText = (message: ClaudeCliMessage): string | undefined => {
  if (message.type !== 'assistant') return undefined;
  const content = (message as Record<string, unknown>).message;
  if (!content || typeof content !== 'object' || !('content' in content)) return undefined;
  const blocks = (content as { content: unknown[] }).content;
  if (!Array.isArray(blocks)) return undefined;
  const turnText = blocks.map(extractTextBlockContent).join('');
  return turnText || undefined;
};

export type { StageProgressCallback, AgentStageName } from '../../shared/types/agent.types';

export type AgentChatSession = {
  agent?: unknown;
  backend?: 'agent' | 'cli';
  provider: 'anthropic' | 'openai';
  runState?: unknown;
  runner?: unknown;
  sessionId?: string;
};

type OpenAiStageContext = {
  repoDir: string;
};

type ReviewCodeOpts = {
  skillNames?: string[]; forkSession?: boolean; figmaContextSection?: string; screenshots?: UiDesignScreenshot[];
};

type StagePromptParams = {
  structuredOutput?: AIRequest['structuredOutput'];
  jsonSchema?: string;
  forkSession?: boolean;
  modelOverride?: string;
  onProgress?: StageProgressCallback;
  priorStageSummary?: string;
  prompt: string;
  repoDir?: string;
  resumeProviderSessionId?: string;
  screenshots?: UiDesignScreenshot[];
  stage: AgentStageName;
  systemPrompt: string;
};

type ChatTurnParams = {
  structuredOutput?: AIRequest['structuredOutput'];
  jsonSchema?: string;
  modelOverride?: string;
  repoDir?: string;
  responseValidator?: ResponseValidator;
  session?: AgentChatSession;
  stage: AgentStageName;
  systemPrompt: string;
  userMessage: string;
};

type OpenAiStageAgentOptions = {
  stage: AgentStageName;
  systemPrompt: string;
  repoDir?: string;
  priorStageSummary?: string;
  apiKey: string;
  jsonSchema?: string;
  model?: string;
  structuredOutput?: AIRequest['structuredOutput'];
};

type AgentChatTurnResult = { content: string; costUsd?: number; session: AgentChatSession };
type StagePromptResult = { content: string; sessionId?: string; modelUsed?: string };

type ResponseValidator = {
  label: string;
  parse: (value: unknown) => unknown;
};

const resolveStagePromptRepoExample = (repositories?: string[]): string => {
  const firstRepository = repositories?.find(repository => typeof repository === 'string' && repository.trim());
  return firstRepository?.trim() || 'current-repo';
};

const isReadOnlyCommand = (command: string): boolean =>
  allowedReadOnlyCommandPrefixes.some(prefix => command === prefix || command.startsWith(prefix));

type GeneratePlanParams = {
  action: 'fix' | 'feature' | 'investigate';
  affectedRepositories?: string[];
  conventions?: RepoConventionsContext;
  crossRepoPatterns?: CrossRepoContext;
  figmaLinks?: string[];
  issueContent: string;
  planCorrelation?: PlanCorrelationResult;
  planQualityFeedback?: string[];
  priorPlans?: PriorPlanContext;
  reuseCandidates?: ReuseCandidateContext;
  skillNames?: string[];
  testInfra?: TestInfraContext;
  ticketKey?: string;
};

const buildPlanDiscoveryBlock = (params: GeneratePlanParams): string => {
  const repoName = params.affectedRepositories?.[0] ?? 'repo';
  const isUiRelevant = Boolean(params.figmaLinks?.length) || isUiRelevantTicket(params.issueContent);
  const parts = [
    params.conventions ? formatRepoConventionsPromptSection(params.conventions, repoName, { includeDesignSystem: isUiRelevant }) : '',
    params.crossRepoPatterns ? formatCrossRepoPatternsPromptSection(params.crossRepoPatterns) : '',
    params.planCorrelation ? formatPlanCorrelationPromptSection(params.planCorrelation) : '',
    params.priorPlans ? formatPriorPlansPromptSection(params.priorPlans) : '',
    params.reuseCandidates ? formatReuseCandidatesPromptSection(params.reuseCandidates) : '',
    formatFigmaPlanPromptSection(params.figmaLinks, Boolean(params.conventions?.designSystem)),
  ].filter(Boolean);
  return parts.length > 0 ? `\n${parts.join('\n\n')}\n` : '';
};

const buildRetryFeedbackBlock = (feedback?: string[]): string =>
  feedback && feedback.length > 0
    ? `Previous plan attempt was rejected for these exact reasons:\n${feedback.join('\n')}\n\nRegenerate the full plan and fix every listed problem. Do not repeat any rejected step wording.\n\n`
    : '';

const buildStagePlanPrompt = (params: GeneratePlanParams): string => {
  const hasNodeTestInfra = params.testInfra?.ecosystems.some(e => e.ecosystem === 'node') ?? false;
  return buildPlanPromptBody({
    action: params.action, issueContent: params.issueContent, ticketKey: params.ticketKey,
    affectedRepositories: params.affectedRepositories,
    repoExample: resolveStagePromptRepoExample(params.affectedRepositories),
    retryFeedbackBlock: buildRetryFeedbackBlock(params.planQualityFeedback),
    discoveryBlock: buildPlanDiscoveryBlock(params),
    testInfraSection: params.testInfra ? formatTestInfraPromptSection(params.testInfra) : '',
    hasNodeInfra: hasNodeTestInfra,
    skillNames: params.skillNames,
  });
};

type PlanPromptBodyOpts = {
  action: string;
  affectedRepositories?: string[];
  discoveryBlock: string;
  hasNodeInfra: boolean;
  issueContent: string;
  repoExample: string;
  retryFeedbackBlock: string;
  skillNames?: string[];
  testInfraSection: string;
  ticketKey?: string;
};

const buildPlanPromptPreamble = (opts: PlanPromptBodyOpts): string => `
Action: ${opts.action}
Issue Content:
${opts.issueContent}

Context:
${JSON.stringify({ ticketKey: opts.ticketKey, summary: opts.ticketKey, affectedRepositories: opts.affectedRepositories }, null, 2)}
${opts.retryFeedbackBlock}${opts.discoveryBlock}
Create a detailed resolution plan with:
1. A brief summary of the issue and proposed solution
2. Specific, actionable steps to ${opts.action} the issue — when the ticket includes code examples, embed relevant snippets inline (e.g., "Replace \`oldFunction()\` with \`newFunction()\` in src/utils.ts")
${planStepPrinciples}
${planFileListingInstructions}`;

const buildPlanJsonSchemaExample = (opts: PlanPromptBodyOpts): string => `
Return ONLY a valid JSON object. Reference:
{"action":"${opts.action}","summary":"Extract shared auth guard into a reusable middleware.","steps":["Rename AuthGuard to SharedAuthGuard in ${opts.repoExample}/src/auth/guard.ts","Update all import paths in ${opts.repoExample}/src/controllers/"],"estimatedComplexity":"medium","affectedFiles":[{"filePath":"${opts.repoExample}/src/auth/guard.ts","status":"found"},{"filePath":"${opts.repoExample}/src/middleware/auth.middleware.ts","status":"to-create"}],"affectedFilesContext":[{"filePath":"${opts.repoExample}/package.json","status":"found"}],"affectedRepositories":["${opts.repoExample}"],"newRepositories":[],"risks":["Renaming may break downstream consumers"],"verification":{"targeted":[{"id":"manual-review","run":"yarn test:manual -- test-auth-guard","policy":"enforced","reason":"Verify guard behaviour after rename"}]}}

When an optional field has no value, omit it from the JSON entirely. Do not use null.

${JSON_OUTPUT_RULES}`;

const buildPlanPromptBody = (opts: PlanPromptBodyOpts): string => [
  buildPlanPromptPreamble(opts),
  opts.testInfraSection,
  buildPlanTestConventionsBlock(!!opts.testInfraSection),
  planMinimalChangePrinciple,
  buildPlanVerificationBlock(opts.hasNodeInfra),
  buildPlanJsonSchemaExample(opts),
  buildPlanSkillSection(opts.skillNames),
].join('\n');

const buildStageReviewPrompt = (
  diff: string, guidelines: string[], skillNames?: string[], figmaContextSection?: string
): string => {
  const numberedGuidelines = guidelines.map((g, i) => (i + 1) + '. ' + g).join('\n');
  const skillSection = buildReviewSkillSection(skillNames, figmaContextSection);
  return [
    `\nCode Changes:\n\`\`\`\n${diff}\n\`\`\``,
    `\nReview Guidelines:\n${numberedGuidelines}`,
    `\n${reviewInstructions}`,
    ...(skillSection ? [skillSection] : []),
    reviewTraceGuidance,
    `\n${reviewOutputSchema}`,
  ].join('\n');
};

const anthropicReadOnlyToolGuard = async (
  toolName: string,
  input: Record<string, unknown>
): Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string; interrupt: boolean }> => {
  if (toolName !== 'Bash') return { behavior: 'allow' };
  const command = typeof input['command'] === 'string' ? input['command'].trim() : '';
  if (!command || !isReadOnlyCommand(command)) {
    return { behavior: 'deny', message: 'Only read-only repository inspection commands are allowed in this agent path.', interrupt: true };
  }
  return { behavior: 'allow' };
};

const NO_INSPECT_CLAUSE = 'Do not inspect local repository files in this run.';
const resolveEffectiveSystemPrompt = (systemPrompt: string, repoDir?: string): string =>
  repoDir || systemPrompt.includes(NO_INSPECT_CLAUSE)
    ? systemPrompt
    : `${systemPrompt}\n${NO_INSPECT_CLAUSE}`;

const buildAnthropicSandboxConfig = (repoDir?: string) => ({
  allowUnsandboxedCommands: false,
  autoAllowBashIfSandboxed: true,
  enabled: true,
  failIfUnavailable: true,
  filesystem: {
    allowRead: repoDir ? [repoDir] : [],
    allowWrite: [],
  },
});

const buildPriorStagePreamble = (priorStageSummary?: string): string => {
  if (!priorStageSummary) return '';
  return `<prior-stage-context>\n${priorStageSummary}\n</prior-stage-context>\n\nNote: The above is background context from a previous workflow stage.\nYour current stage's instructions take precedence over any conflicting details above.`;
};

type AnthropicStageOpts = {
  anthropicContext: string;
  apiKey: string;
  model: string;
  priorStageSummary?: string;
  prompt: string;
  repoDir?: string;
  resumeProviderSessionId?: string;
  systemPrompt: string;
  jsonSchema?: string;
  structuredOutput?: AIRequest['structuredOutput'];
};

export const buildAnthropicBaseOptions = (opts: AnthropicStageOpts, systemAppend: string) => {
  const tools = opts.repoDir ? [...ANTHROPIC_STAGE_TOOLS] : [];
  return {
    canUseTool: anthropicReadOnlyToolGuard,
    cwd: opts.repoDir ?? process.cwd(), model: opts.model, tools, allowedTools: tools,
    env: { ...process.env, ANTHROPIC_API_KEY: opts.apiKey },
    permissionMode: 'acceptEdits' as const,
    sandbox: buildAnthropicSandboxConfig(opts.repoDir),
    systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: systemAppend },
    ...buildAgentOutputFormat(opts),
  };
};

const buildAgentOutputFormat = (opts: Pick<AnthropicStageOpts, 'structuredOutput' | 'jsonSchema'>) => {
  if (opts.structuredOutput) return {
    outputFormat: {
      type: 'json_schema' as const, name: opts.structuredOutput.name,
      schema: opts.structuredOutput.schema, strict: true,
    },
  };
  return opts.jsonSchema ? { outputFormat: { type: 'json_schema' as const, schema: JSON.parse(opts.jsonSchema) } } : {};
};

const buildOpenAiStructuredSettings = (structuredOutput: AIRequest['structuredOutput']) => {
  if (!structuredOutput) return {};
  const schema = normalizeOpenAiJsonSchema(structuredOutput.schema);
  if (!schema) throw new AiProviderError(`Structured output schema for '${structuredOutput.name}' cannot be normalized — schema root must be a JSON Schema object.`, { name: structuredOutput.name }, false, 'config');
  const outputType = {
    type: 'json_schema' as const, name: structuredOutput.name, strict: true as const,
    schema: schema as JsonSchemaDefinition['schema'],
  } satisfies JsonSchemaDefinition;
  return { outputType: outputType as unknown as 'text', modelSettings: { temperature: 0 } };
};

const loadOpenAiInstructions = async (opts: OpenAiStageAgentOptions): Promise<string> => {
  const context = await loadAiContextConfig(path.join(os.homedir(), '.openai', 'AGENTS.md'), 'AGENTS.md', 'openai', true);
  return [context, buildOpenAiSystemPrompt(opts.systemPrompt, opts.priorStageSummary, opts.repoDir)].filter(Boolean).join('\n\n');
};

const buildAnthropicStageQueryOptions = (opts: AnthropicStageOpts) => {
  const effectiveSystemPrompt = resolveEffectiveSystemPrompt(opts.systemPrompt, opts.repoDir);
  const systemAppend = [buildPriorStagePreamble(opts.priorStageSummary), opts.anthropicContext, effectiveSystemPrompt].filter(Boolean).join('\n\n');
  const resumeOption = opts.resumeProviderSessionId ? { resume: opts.resumeProviderSessionId } : {};
  return { ...buildAnthropicBaseOptions(opts, systemAppend), ...resumeOption };
};

const buildAnthropicStageOptions = (opts: AnthropicStageOpts) => ({
  prompt: opts.prompt,
  options: buildAnthropicStageQueryOptions(opts),
});

const serializeOpenAiFinalOutput = (output: unknown): string => {
  if (typeof output === 'string') return output.trim();
  if (output == null) return '';
  return JSON.stringify(output);
};

const finalizeCodexResult = (result: string, sessionId?: string): { content: string; sessionId?: string } => {
  if (!result) {
    console.log(chalk.yellow(`  [${CODEX_STAGE_LABEL}] No result message received from Codex CLI`));
    if (sessionId) console.log(chalk.yellow(`  [${CODEX_STAGE_LABEL}] Provider session: ${sessionId}`));
    throw new AiProviderError('Codex CLI finished without returning a result.', null, true, 'stall');
  }
  if (sessionId) console.log(chalk.gray(`  [${CODEX_STAGE_LABEL}] Provider session: ${sessionId}`));
  return { content: result.trim(), sessionId };
};

type CodexStageResultState = {
  agentMessageCount: number;
  inputTokens: number;
  outputTokens: number;
  result: string;
  sessionId?: string;
  stopReason?: string;
};

const extractCodexStopReason = (message: CodexCliMessage): string | undefined => {
  const stopReason = message['stop_reason'];
  return typeof stopReason === 'string' ? stopReason : undefined;
};

const extractCodexErrorField = (error: unknown): string | undefined => {
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (!error || typeof error !== 'object') return undefined;
  const details = error as Record<string, unknown>;
  if (typeof details.message === 'string' && details.message.trim()) return details.message.trim();
  return JSON.stringify(details);
};

const extractCodexMessageError = (message: CodexCliMessage): string | undefined => {
  const hasErrorField = message['error'] !== undefined;
  const hasFailedStatus = message['status'] === 'failed';
  if (!message.is_error && message.type !== 'error' && message.type !== 'turn.failed' && !hasErrorField && !hasFailedStatus) {
    return undefined;
  }
  if (typeof message.result === 'string' && message.result.trim()) return message.result.trim();
  if (typeof message.summary === 'string' && message.summary.trim()) return message.summary.trim();
  if (typeof message.message === 'string' && message.message.trim()) return message.message.trim();
  const errorDetail = extractCodexErrorField(message['error']);
  if (errorDetail) return errorDetail;
  return `Codex CLI returned ${message.type}${message.subtype ? ` (${message.subtype})` : ''}.`;
};

const throwCodexMessageError = (message: CodexCliMessage, stage: AgentStageName): never => {
  const detail = extractCodexMessageError(message) ?? 'unknown error';
  const isSchemaConfigurationError = /invalid_json_schema|text\.format\.schema/i.test(detail);
  let category: 'api' | 'stall' | 'config' = 'api';
  if (message.subtype === 'timeout' || message.subtype === 'inactivity_timeout') category = 'stall';
  else if (isSchemaConfigurationError) category = 'config';
  throw new AiProviderError(`Codex CLI returned an error: ${detail}`, {
    stage, subtype: message.subtype, response: message,
  }, true, category);
};

const updateCodexAgentMessageState = (state: CodexStageResultState, message: CodexCliMessage): void => {
  if (message.type !== 'item.completed') return;
  if (message.item?.type !== 'agent_message' || !message.item.text) return;
  state.agentMessageCount++;
  state.result = message.item.text;
};

const accumulateCodexTokenUsage = (state: CodexStageResultState, message: CodexCliMessage): void => {
  if (!message.usage) return;
  state.inputTokens += message.usage.input_tokens;
  state.outputTokens += message.usage.output_tokens;
};

const emitCodexProgressLine = (message: CodexCliMessage, onProgress?: StageProgressCallback): void => {
  if (!onProgress) return;
  const line = formatCodexProgressMessage(message);
  if (line) onProgress(line);
};

const accumulateCodexStageResult = (
  state: CodexStageResultState,
  message: CodexCliMessage, stage: AgentStageName,
  onProgress?: StageProgressCallback
): void => {
  if (extractCodexMessageError(message)) throwCodexMessageError(message, stage);
  if (message.type === 'thread.started' && message.thread_id) state.sessionId = message.thread_id;
  const stopReason = extractCodexStopReason(message);
  if (stopReason) state.stopReason = stopReason;
  accumulateCodexTokenUsage(state, message);
  emitCodexProgressLine(message, onProgress);
  updateCodexAgentMessageState(state, message);
};

const throwCodexTruncationError = (stage: AgentStageName, stopReason: string): never => {
  throw new AiProviderError(
    'CLI response was truncated due to output token limit — the model ran out of space before '
    + 'completing the response. Reduce prompt/context size or switch to provider-backed OpenAI '
    + 'if you need a larger output budget.',
    { stopReason, stage }, true, 'truncation'
  );
};

const logCodexMultiChunkResult = (agentMessageCount: number): void => {
  console.log(
    chalk.cyan(`  [${CODEX_STAGE_LABEL}] Codex emitted ${agentMessageCount} agent_message chunks; using the last non-empty chunk.`)
  );
};

const finalizeCodexStageResult = (
  state: CodexStageResultState,
  stage: AgentStageName
): { content: string; sessionId?: string } => {
  if (state.stopReason === 'max_tokens') throwCodexTruncationError(stage, state.stopReason);
  if (state.agentMessageCount > 1) logCodexMultiChunkResult(state.agentMessageCount);
  return finalizeCodexResult(state.result, state.sessionId);
};

interface CodexStageResultOpts {
  sessionId?: string;
  model?: string;
  onProgress?: StageProgressCallback;
  timeoutMs?: number;
  inactivityTimeoutMs?: number;
}

const computeCodexCostUsd = (model: string | undefined, state: CodexStageResultState): number | undefined =>
  estimateLlmCostUsd('openai', model, { inputTokens: state.inputTokens, outputTokens: state.outputTokens }) ?? undefined;

const processCodexStageResult = async (
  args: string[], repoDir: string, fullPrompt: string, stage: AgentStageName,
  opts?: CodexStageResultOpts,
): Promise<{ content: string; sessionId?: string; costUsd?: number }> => {
  const state: CodexStageResultState = {
    sessionId: opts?.sessionId, result: '', agentMessageCount: 0, inputTokens: 0, outputTokens: 0,
  };
  const stream = spawnCodex(args, repoDir, fullPrompt, undefined, opts?.timeoutMs, opts?.inactivityTimeoutMs);
  for await (const message of stream) {
    accumulateCodexStageResult(state, message, stage, opts?.onProgress);
  }
  return { ...finalizeCodexStageResult(state, stage), costUsd: computeCodexCostUsd(opts?.model, state) };
};

export const extractCliResultContent = (
  message: ClaudeCliMessage
): { result: string; source: 'structured_output' | 'result' } | undefined => {
  if (message.type !== 'result' || message.is_error) return undefined;
  if (message.structured_output && typeof message.structured_output === 'object') {
    return { result: JSON.stringify(message.structured_output), source: 'structured_output' };
  }
  if (message.result) return { result: message.result, source: 'result' };
  return undefined;
};

type CliPassAccumulator = {
  costUsd?: number;
  diagnostics: string[];
  lastAssistantText: string;
  result: string;
  sessionId: string | undefined;
  source: CliPassResult['source'];
  stopReason: string | undefined;
};

const applyCliResultToAcc = (acc: CliPassAccumulator, message: ClaudeCliMessage): void => {
  const extracted = extractCliResultContent(message);
  if (!extracted) return;
  acc.result = extracted.result;
  acc.source = extracted.source;
  acc.stopReason = message.stop_reason as string | undefined;
};

const accumulateCliMessage = (
  acc: CliPassAccumulator, message: ClaudeCliMessage, onProgress?: StageProgressCallback
): void => {
  if (message.session_id) acc.sessionId = message.session_id;
  acc.costUsd = (message as { total_cost_usd?: number }).total_cost_usd ?? acc.costUsd;
  if (onProgress) {
    const line = formatAnthropicProgressMessage(message as never, CLI_STAGE_LABEL);
    if (line) onProgress(line);
  }
  const assistantText = extractAssistantText(message);
  if (assistantText) acc.lastAssistantText = assistantText;
  applyCliResultToAcc(acc, message);
  const diagnostic = extractCliDiagnostic(message);
  if (diagnostic) acc.diagnostics.push(diagnostic);
};

const finalizeCliPass = (acc: CliPassAccumulator): CliPassResult => {
  const result = acc.result || (acc.lastAssistantText.trim() ? acc.lastAssistantText : '');
  const fallbackSource = acc.lastAssistantText.trim() ? 'assistant_text' as const : acc.source;
  const source = acc.result ? acc.source : fallbackSource;
  const hadContent = acc.lastAssistantText.trim().length > 0;
  return {
    result, source, stopReason: acc.stopReason,
    sessionId: acc.sessionId, hadContent, diagnostics: acc.diagnostics,
    costUsd: acc.costUsd,
  };
};

const processCliPassMessages = async (
  args: string[],
  repoDir: string,
  prompt: string,
  wallClockTimeoutMs: number,
  inactivityTimeoutMs?: number,
  onProgress?: StageProgressCallback
): Promise<CliPassResult> => {
  const acc: CliPassAccumulator = { result: '', source: undefined, stopReason: undefined, sessionId: undefined, lastAssistantText: '', diagnostics: [] };
  for await (const message of spawnCli(args, repoDir, prompt, undefined, wallClockTimeoutMs, inactivityTimeoutMs)) {
    accumulateCliMessage(acc, message, onProgress);
  }
  return finalizeCliPass(acc);
};

type CliRetryState = {
  costUsd?: number;
  lastDiagnostics: string[];
  passNumber: number;
  schemaMisses: number;
  sessionId?: string;
  stalledPasses: number;
};

const makeCliRetryState = (sessionId?: string): CliRetryState => ({
  sessionId, stalledPasses: 0, passNumber: 0, lastDiagnostics: [], schemaMisses: 0,
});

const advanceCliRetryState = (state: CliRetryState, passResult: CliPassResult): void => {
  const madeProgress = passResult.hadContent && passResult.source !== 'assistant_text';
  state.stalledPasses = madeProgress ? 0 : state.stalledPasses + 1;
  logCliPassOutcome(state, passResult);
  checkCliStallCondition(state.stalledPasses, state.passNumber, state.lastDiagnostics);
  state.lastDiagnostics = passResult.diagnostics;
};

/**
 * Logs a pass's outcome fields. Only genuinely unusable passes (no result, or
 * result demoted from assistant_text) are labeled `cli.pass_unusable` at WARN —
 * a usable pass logs as `cli.pass_outcome` at DEBUG so successful passes don't
 * read as failures in the log.
 */
const logCliPassOutcome = (state: CliRetryState, passResult: CliPassResult): void => {
  const unusable = !passResult.result || passResult.source === 'assistant_text';
  const fields = [
    `pass=${state.passNumber}`,
    `stalledPasses=${state.stalledPasses}`,
    `source=${passResult.source ?? 'none'}`,
    `schemaExpected=${passResult.schemaExpected === true}`,
    `hadContent=${passResult.hadContent}`,
    `resultChars=${passResult.result?.length ?? 0}`,
    `session=${state.sessionId ?? 'none'}`,
  ].join(' ');
  const diagnostics = passResult.diagnostics.length ? ` diagnostics=${passResult.diagnostics.join(' | ')}` : '';
  const label = unusable ? 'cli.pass_unusable' : 'cli.pass_outcome';
  appendToLogFile(unusable ? 'WARN' : 'DEBUG', `${label} ${fields}${diagnostics}`, CLI_STAGE_LABEL);
};

const RATE_LIMIT_DIAGNOSTIC_PATTERN = /rate limited \(status: rejected\)|usage limit reached|hit your .*limit/i;

const hasRateLimitDiagnostic = (diagnostics: string[]): boolean =>
  diagnostics.some(diagnostic => RATE_LIMIT_DIAGNOSTIC_PATTERN.test(diagnostic));

const checkCliStallCondition = (stalledPasses: number, passNumber: number, lastDiagnostics: string[]): void => {
  if (stalledPasses < CLI_STALL_THRESHOLD) return;
  const detail = lastDiagnostics.length ? ` Diagnostics:\n${lastDiagnostics.join('\n')}` : '';
  const rateLimited = hasRateLimitDiagnostic(lastDiagnostics);
  const message = rateLimited
    ? `Claude CLI hit a rate or usage limit and produced no result after ${passNumber} pass(es).${detail}`
    : `Claude CLI finished without returning a result after ${passNumber} pass(es) — workload not decreasing.${detail}`;
  const label = rateLimited ? 'cli.rate_limited' : 'cli.stall';
  appendToLogFile('ERROR', `${label} ${message.replaceAll('\n', ' | ')}`, CLI_STAGE_LABEL);
  throw new AiProviderError(message, { passes: passNumber, diagnostics: lastDiagnostics }, true, rateLimited ? 'rate-limit' : 'stall');
};

type AnthropicChatOpts = {
  anthropicContext: string;
  apiKey: string;
  model: string;
  prompt: string;
  repoDir?: string;
  resumeSessionId?: string;
  systemPrompt: string;
  structuredOutput?: AIRequest['structuredOutput'];
};

const buildAnthropicChatQueryOptions = (opts: AnthropicChatOpts) => {
  const effectiveSystemPrompt = resolveEffectiveSystemPrompt(opts.systemPrompt, opts.repoDir);
  const systemAppend = [opts.anthropicContext, effectiveSystemPrompt].filter(Boolean).join('\n\n');
  const resumeOption = opts.resumeSessionId ? { resume: opts.resumeSessionId } : {};
  return { ...buildAnthropicBaseOptions(opts, systemAppend), ...resumeOption };
};

const buildAnthropicChatOptions = (opts: AnthropicChatOpts) => ({
  prompt: opts.prompt,
  options: buildAnthropicChatQueryOptions(opts),
});

const buildOpenAiSystemPrompt = (
  systemPrompt: string, priorStageSummary?: string, repoDir?: string
): string => {
  const preamble = buildPriorStagePreamble(priorStageSummary);
  const preambleWithNewline = preamble ? `${preamble}\n\n` : '';
  return `${preambleWithNewline}${resolveEffectiveSystemPrompt(systemPrompt, repoDir)}`;
};

const createOpenAiReadFileTool = () => tool({
  name: 'read_file',
  description: 'Read a file from the current repository workspace.',
  parameters: z.object({ path: z.string().min(1) }),
  async execute(input, runContext) {
    const ctx = runContext?.context as OpenAiStageContext;
    const absolutePath = path.resolve(ctx.repoDir, input.path);
    const content = await fs.readFile(absolutePath, 'utf-8');
    return JSON.stringify({ path: path.relative(ctx.repoDir, absolutePath), content }, null, 2);
  },
});

const createOpenAiListFilesTool = () => tool({
  name: 'list_files',
  description: 'List files in the current repository workspace.',
  parameters: z.object({ root: z.string().min(1).describe('Repository subdirectory to list; use "." for the repo root.') }),
  async execute(input, runContext) {
    const ctx = runContext?.context as OpenAiStageContext;
    const relativeRoot = input.root.trim() || '.';
    const command = `rg --files ${relativeRoot === '.' ? '' : relativeRoot}`.trim();
    const { stdout } = await execAsync(command, { cwd: ctx.repoDir, maxBuffer: MAX_BUFFER_IN_BYTES });
    return stdout.trim();
  },
});

const createOpenAiSearchFilesTool = () => tool({
  name: 'search_files',
  description: 'Search repository files with ripgrep.',
  parameters: z.object({ pattern: z.string().min(1), root: z.string().min(1).describe('Repository subdirectory to search; use "." for the repo root.') }),
  async execute(input, runContext) {
    const ctx = runContext?.context as OpenAiStageContext;
    const relativeRoot = input.root.trim() || '.';
    const { stdout } = await execAsync(`rg -n ${JSON.stringify(input.pattern)} ${relativeRoot}`, { cwd: ctx.repoDir, maxBuffer: MAX_BUFFER_IN_BYTES });
    return stdout.trim();
  },
});

const createOpenAiRunCommandTool = () => tool({
  name: 'run_readonly_command',
  description: 'Run a read-only repository inspection command such as pwd, ls, rg, git diff, or git status.',
  parameters: z.object({ command: z.string().min(1) }),
  async execute(input, runContext) {
    const ctx = runContext?.context as OpenAiStageContext;
    const command = input.command.trim();
    if (!isReadOnlyCommand(command)) {
      return JSON.stringify({ allowed: false, message: 'Only read-only repository inspection commands are allowed in this agent path.' }, null, 2);
    }
    const { stdout, stderr } = await execAsync(command, { cwd: ctx.repoDir, maxBuffer: MAX_BUFFER_IN_BYTES });
    return JSON.stringify({ allowed: true, stdout: stdout.trim(), stderr: stderr.trim() }, null, 2);
  },
});

const buildOpenAiStageTools = () => [
  createOpenAiReadFileTool(), createOpenAiListFilesTool(), createOpenAiSearchFilesTool(), createOpenAiRunCommandTool(),
];

type AnthropicSession = AsyncIterable<Record<string, unknown>> & { close: () => void };
type AnthropicResultHandler = (msg: Record<string, unknown>) => { content: string } | undefined;

const drainAnthropicSession = async (
  session: AnthropicSession, handler: AnthropicResultHandler, sessionLogPrefix: string
): Promise<{ content: string; sessionId?: string }> => {
  let sessionId: string | undefined;
  try {
    for await (const message of session) {
      if ('session_id' in message && typeof message.session_id === 'string') sessionId = message.session_id;
      const result = handler(message);
      if (!result) continue;
      if (sessionId && sessionLogPrefix) console.log(chalk.cyan(sessionLogPrefix + sessionId));
      return { ...result, sessionId };
    }
  } finally { session.close(); }
  throw new AiProviderError('Claude Agent SDK finished without returning a result.');
};

const STALE_RESUME_PATTERNS = [
  /session[_ ]?id.*(?:not found|invalid|expired|does not exist)/i,
  /(?:invalid|unknown|expired|stale).*session/i,
  /resume.*(?:fail|invalid|not found)/i,
  /(?:conversation|thread).*(?:not found|invalid|expired)/i,
  /no conversation found/i,
];

const isStaleResumeError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return STALE_RESUME_PATTERNS.some(pattern => pattern.test(message));
};

type AnthropicResultMessage = {
  subtype: string;
  is_error?: boolean;
  errors?: string[];
  result?: string;
  structured_output?: unknown;
};

const extractAnthropicResultContent = (result: AnthropicResultMessage): string | undefined => {
  if ('structured_output' in result) {
    return typeof result.structured_output === 'string'
      ? result.structured_output
      : JSON.stringify(result.structured_output);
  }
  return result.result;
};

const extractAnthropicResultMessage = (
  message: Record<string, unknown>, onProgress?: StageProgressCallback
): string | undefined => {
  if ((message as { type: string }).type !== 'result') {
    const line = onProgress ? formatAnthropicProgressMessage(message as never) : null;
    if (line) onProgress?.(line);
    return undefined;
  }
  const result = message as AnthropicResultMessage;
  if (result.subtype !== 'success' || result.is_error) {
    const errorSummary = result.errors?.length ? result.errors.join('; ') : 'unknown error';
    throw new AiProviderError(`Claude Agent SDK failed (${result.subtype}): ${errorSummary}`);
  }
  return extractAnthropicResultContent(result);
};

const STAGE_RESPONSE_SCHEMAS: Partial<Record<AgentStageName, string>> = {
  plan: buildSanitisedJsonSchema(z.toJSONSchema(resolutionPlanSchema)),
  review: buildSanitisedJsonSchema(z.toJSONSchema(codeReviewSchema)),
  generate: buildSanitisedJsonSchema(z.toJSONSchema(generateTicketSchema)),
};

const stageZodSchemas: Partial<Record<AgentStageName, { parse: (v: unknown) => unknown }>> = {
  plan: resolutionPlanSchema,
  review: codeReviewSchema,
  generate: generateTicketSchema,
};

const resolveStageResponseIssues = (stage: AgentStageName, content: string): string | null => {
  const zodSchema = stageZodSchemas[stage];
  if (!zodSchema) return null;
  try {
    zodSchema.parse(parseJsonResponse(content));
    return null;
  } catch (err) {
    if (isZodErrorLike(err)) return formatZodError(err);
    return 'Response is not valid JSON';
  }
};

const resolveResponseIssues = (
  stage: AgentStageName, content: string, responseValidator?: ResponseValidator
): string | null => {
  if (!responseValidator) return resolveStageResponseIssues(stage, content);
  try {
    responseValidator.parse(parseJsonResponse(content));
    return null;
  } catch (err) {
    if (isZodErrorLike(err)) return formatZodError(err);
    return 'Response is not valid JSON';
  }
};

const resolveStageZodIssues = (stage: AgentStageName, content: string): string | undefined => {
  const zodSchema = stageZodSchemas[stage];
  if (!zodSchema) return undefined;
  try {
    zodSchema.parse(parseJsonResponse(content));
    return undefined;
  } catch (err) {
    return isZodErrorLike(err) ? formatZodError(err) : undefined;
  }
};

const STAGE_PARSE_ERROR_LABELS: Partial<Record<AgentStageName, string>> = {
  plan: 'resolution plan',
  review: 'code review',
  generate: 'ticket',
};

const buildStageParseErrorMessage = (
  stage: AgentStageName, content: string, zodIssues: string | undefined, label?: string
): string => {
  const responseLabel = label ?? STAGE_PARSE_ERROR_LABELS[stage] ?? 'resolution plan';
  const baseMessage = `Failed to parse ${responseLabel} from agent response`;
  return zodIssues ? `${baseMessage}\n${zodIssues}` : baseMessage;
};

const throwStageParseFailure = (
  stage: AgentStageName, response: string, sessionId: string | undefined, error: unknown
): never => {
  const zodIssues = resolveStageZodIssues(stage, response);
  throw new AiProviderError(
    buildStageParseErrorMessage(stage, response, zodIssues),
    { response, error, sessionId, zodIssues },
    true,
    'parse'
  );
};

const buildCodexSchemaSection = (stage: AgentStageName): string => {
  const schemaJson = STAGE_RESPONSE_SCHEMAS[stage];
  if (!schemaJson) return '';
  return `\n\nOutput contract — your response MUST be a JSON object that validates against this schema:\n${schemaJson}`;
};

const buildCodexRetryPrompt = (issues: string): string =>
  `Your previous response did not validate against the required JSON schema. Issues:\n${issues}\n\nPlease output ONLY a corrected JSON object. Raw, minified JSON only — no commentary or markdown.`;

type CodexPassBase = {
  stage: AgentStageName; model: string; repoDir: string;
  onProgress?: StageProgressCallback; timeoutMs?: number; inactivityTimeoutMs?: number;
  responseValidator?: ResponseValidator;
  jsonSchema?: string;
};

const NON_RETRYABLE_CODEX_ERROR_CATEGORIES = new Set(['stall', 'truncation']);

const isNonRetryableCodexError = (error: unknown): boolean =>
  isAiProviderErrorLike(error) && NON_RETRYABLE_CODEX_ERROR_CATEGORIES.has(error.category ?? '');

const throwCodexParseError = (
  stage: AgentStageName, content: string, zodIssues: string, sessionId: string | undefined,
  responseValidator?: ResponseValidator
): never => {
  throw new AiProviderError(
    buildStageParseErrorMessage(stage, content, zodIssues, responseValidator?.label),
    { response: content, sessionId, zodIssues },
    true, 'parse'
  );
};

const applySchemaRetry = (
  state: CliRetryState, stage: AgentStageName, outcome: { content: string; issues: string },
  responseValidator?: ResponseValidator
): true => {
  state.schemaMisses++;
  if (state.schemaMisses > MAX_CLI_SCHEMA_MISSES || !state.sessionId) {
    throw new AiProviderError(
      buildStageParseErrorMessage(stage, outcome.content, outcome.issues, responseValidator?.label),
      { response: outcome.content, sessionId: state.sessionId, zodIssues: outcome.issues },
      true, 'parse'
    );
  }
  console.log(chalk.yellow(`  [${CLI_STAGE_LABEL}] Pass ${state.passNumber}: schema miss (${outcome.issues.slice(0, 120)}) — retrying`));
  return true;
};

const appendAgentSdkScreenshotPaths = (prompt: string, screenshots: UiDesignScreenshot[] | undefined): string => {
  if (!screenshots?.length) return prompt;
  return `${prompt}\n\nDesign screenshots (accessible via filesystem):\n${screenshots.map(s => `- ${s.path}`).join('\n')}`;
};

@Injectable()
export class StageAgentService {
  constructor(private readonly configService: ConfigService) {}

  isEnabledForStage(stage: AgentStageName): boolean {
    const backend = this.resolveStageBackend(stage);
    return backend === 'agent' || backend === 'cli';
  }

  resolveTargetForStage(stage: AgentStageName): { provider: string; model: string } {
    return { provider: this.resolveStageProvider(stage), model: this.resolveStageModel(stage) };
  }

  enrichPlanWithDirectoryConfigs(plan: ResolutionPlan, repoDir: string): void {
    const provider = this.resolveImplementProvider();
    const affectedPaths = normalizeFileEntries(plan.affectedFiles ?? []).map(e => e.filePath);
    const contextPaths = normalizeFileEntries(plan.affectedFilesContext ?? []).map(e => e.filePath);
    const discovered = discoverDirAgentConfigs([...affectedPaths, ...contextPaths], provider, path.dirname(repoDir));
    if (discovered.length === 0) return;
    const newEntries = discovered.filter(e => !new Set(contextPaths).has(e.filePath));
    if (newEntries.length === 0) return;
    plan.affectedFilesContext ??= [];
    plan.affectedFilesContext.push(...newEntries);
    console.log(chalk.cyan(`  Discovered ${newEntries.length} per-directory agent config(s)`));
  }

  private resolveImplementProvider(): WfAiProviderName {
    return (
      this.configService.get<string>('stages.implement.provider')
      ?? this.configService.get<string>('ai.provider')
      ?? 'anthropic'
    ) as WfAiProviderName;
  }

  async generatePlan(params: GeneratePlanParams & {
    onProgress?: StageProgressCallback;
    priorStageSummary?: string;
    resumeProviderSessionId?: string;
  }): Promise<{ plan: ResolutionPlan; sessionId?: string }> {
    const { content: response, sessionId, modelUsed } = await this.runStagePrompt({
      stage: 'plan', prompt: buildStagePlanPrompt(params), systemPrompt: planSystemPrompt,
      repoDir: process.cwd(), onProgress: params.onProgress,
      priorStageSummary: params.priorStageSummary, resumeProviderSessionId: params.resumeProviderSessionId,
    });
    return this.parseStagePlanResponse(response, sessionId, modelUsed);
  }

  private parseStagePlanResponse(
    response: string, sessionId?: string, modelUsed?: string
  ): { plan: ResolutionPlan; sessionId?: string } {
    try {
      return { plan: this.parseAndValidatePlan(response, modelUsed), sessionId };
    } catch (error) {
      if (isAiProviderErrorLike(error)) throw error;
      return throwStageParseFailure('plan', response, sessionId, error);
    }
  }

  private parseAndValidatePlan(response: string, modelUsed?: string): ResolutionPlan {
    return this.applyPlanMetadata(this.parsePlanContent(response), modelUsed);
  }

  private parsePlanContent(response: string): ResolutionPlan {
    const parsedPlan = parseJsonResponse<ResolutionPlan & { repositoriesAffected?: string[] }>(
      requireAiResponseContent(
        {
          content: response,
          provider: this.resolveStageProvider('plan'),
          model: this.resolveStageModel('plan'),
        },
        'AI provider returned an empty plan response'
      )
    );
    return this.applyRepositoriesAffected(resolutionPlanSchema.parse(parsedPlan), parsedPlan.repositoriesAffected);
  }

  private applyPlanMetadata(plan: ResolutionPlan, modelUsed?: string): ResolutionPlan {
    const provider = this.resolveStageProvider('plan');
    plan.provider = provider;
    plan.source = deriveModelSource(provider, modelUsed ?? this.resolveStageModel('plan'));
    plan.timestamp = dayjs().toISOString();
    return plan;
  }

  private applyRepositoriesAffected(
    plan: ResolutionPlan,
    repositoriesAffected?: string[]
  ): ResolutionPlan {
    if (!plan.affectedRepositories && repositoriesAffected) {
      plan.affectedRepositories = repositoriesAffected;
    }
    return plan;
  }

  private buildReviewSystemPrompt(screenshots?: UiDesignScreenshot[]): string {
    const compliance = buildUiDesignComplianceSystemPromptSection({
      uiDesignScreenshots: screenshots?.map(s => s.path),
    });
    return compliance ? `${reviewSystemPrompt}\n\n${compliance}` : reviewSystemPrompt;
  }

  async reviewCode(
    diff: string, guidelines: string[], repoDir?: string, priorStageSummary?: string,
    resumeProviderSessionId?: string, onProgress?: StageProgressCallback, opts?: ReviewCodeOpts,
  ): Promise<{ review: CodeReview; sessionId?: string }> {
    const systemPrompt = this.buildReviewSystemPrompt(opts?.screenshots);
    const prompt = buildStageReviewPrompt(diff, guidelines, opts?.skillNames, opts?.figmaContextSection);
    const base = { prompt, systemPrompt, repoDir, priorStageSummary, resumeProviderSessionId, onProgress };
    const { content: response, sessionId } = await this.runReviewStagePrompt(
      base, opts?.forkSession, opts?.screenshots,
    );
    return this.parseStageReviewResponse(diff, response, sessionId, repoDir, systemPrompt, priorStageSummary);
  }

  private async runReviewStagePrompt(
    base: Pick<StagePromptParams, 'prompt' | 'systemPrompt' | 'repoDir' | 'priorStageSummary' | 'resumeProviderSessionId' | 'onProgress'>,
    forkSession?: boolean, screenshots?: UiDesignScreenshot[],
  ) {
    return this.runStagePrompt({ stage: 'review', ...base, forkSession, screenshots });
  }

  private async parseStageReviewResponse(
    diff: string, response: string, sessionId: string | undefined, repoDir: string | undefined,
    systemPrompt: string, priorStageSummary: string | undefined
  ): Promise<{ review: CodeReview; sessionId?: string }> {
    try {
      const review = this.parseAndProcessReview(diff, response);
      const backend = this.resolveStageBackend('review');
      await this.trySendReviewEpilogue(backend, sessionId, repoDir, systemPrompt, priorStageSummary);
      return { review: { ...review, executionMode: backend === 'cli' ? 'cli' : 'agent' }, sessionId };
    } catch (error) {
      if (isAiProviderErrorLike(error)) throw error;
      return throwStageParseFailure('review', response, sessionId, error);
    }
  }

  private parseAndProcessReview(diff: string, response: string): CodeReview {
    const parsed = codeReviewSchema.parse(
      parseJsonResponse<CodeReview>(
        requireReviewResponseContent({ content: response, provider: this.resolveStageProvider('review'), model: this.resolveStageModel('review') })
      )
    );
    return postProcessCodeReview(sanitizeCodeReviewTrace(parsed, diff), diff).review;
  }

  private epilogueFailureOutcome(error: unknown): { sent: false; reason: string } {
    return { sent: false, reason: error instanceof Error ? error.message.split('\n')[0] : String(error) };
  }

  private async trySendReviewEpilogue(
    backend: WfBackendMode, sessionId: string | undefined, repoDir: string | undefined,
    systemPrompt: string, priorStageSummary: string | undefined
  ): Promise<void> {
    if (backend !== 'cli' || !sessionId) return;
    const label = this.resolveReviewEpilogueLabel();
    try {
      const outcome = await this.sendCliReviewEpilogue(
        this.buildReviewEpilogueParams(sessionId, repoDir, systemPrompt, priorStageSummary)
      );
      this.logReviewEpilogueOutcome(label, outcome);
    } catch (error) {
      this.logReviewEpilogueOutcome(label, this.epilogueFailureOutcome(error));
    }
  }

  private resolveReviewEpilogueLabel(): string {
    return this.resolveStageProvider('review') === 'openai' ? CODEX_STAGE_LABEL : CLI_STAGE_LABEL;
  }

  private buildReviewEpilogueParams(
    sessionId: string,
    repoDir: string | undefined,
    systemPrompt: string,
    priorStageSummary: string | undefined
  ): { sessionId: string; repoDir: string; systemPrompt: string; priorStageSummary?: string } {
    return { sessionId, repoDir: repoDir ?? process.cwd(), systemPrompt, priorStageSummary };
  }

  private logReviewEpilogueOutcome(label: string, outcome: { sent: true } | { sent: false; reason: string }): void {
    if (outcome.sent) {
      console.log(chalk.gray(`  [${label}] Review epilogue sent`));
      return;
    }
    console.log(chalk.yellow(`  [${label}] Review epilogue failed (${outcome.reason}) — manual resume may show raw JSON`));
  }

  async generateFromPrompt(
    prompt: string, onProgress?: StageProgressCallback, resumeProviderSessionId?: string
  ): Promise<{ content: string; sessionId?: string }> {
    const { content: response, sessionId, modelUsed } = await this.runStagePrompt(
      { stage: 'generate', prompt, systemPrompt: generateSystemPrompt, onProgress, resumeProviderSessionId }
    );
    const content = requireAiResponseContent(
      { content: response, provider: this.resolveStageProvider('generate'), model: modelUsed ?? this.resolveStageModel('generate') },
      'AI provider returned an empty generated content response'
    );
    return { content, sessionId };
  }

  private resolveStageBackend(stage: AgentStageName): WfBackendMode {
    return this.configService.get<WfBackendMode>(`stages.${stage}.backend`, resolveDefaultStageBackend(stage));
  }

  private resolveStageProvider(stage: AgentStageName): 'anthropic' | 'openai' {
    const provider
      = this.configService.get<string>(`stages.${stage}.provider`)
        ?? this.configService.get<string>('ai.provider', 'anthropic');
    if (provider !== 'anthropic' && provider !== 'openai') {
      throw new ConfigurationError(
        `${stage} stage agent backend is unsupported for provider "${provider}". Configure ${stage}.provider as anthropic or openai, or set stages.${stage}.backend to "standard".`
      );
    }
    return provider;
  }

  private resolveStageModel(stage: AgentStageName): string {
    const stageModel = this.configService.get<string>(`stages.${stage}.model`);
    if (stageModel) return stageModel;
    if (stage === 'implement') {
      const implementModels = this.configService.get<{ default?: string }>('stages.implement.models');
      if (implementModels?.default) return implementModels.default;
    }
    const provider = this.resolveStageProvider(stage);
    const fallback = provider === 'openai' ? READ_ONLY_OPENAI_MODEL : READ_ONLY_ANTHROPIC_MODEL;
    return resolveProviderModel(this.configService, provider, fallback);
  }

  private resolveModelForStage(stage: AgentStageName, override?: string): string {
    return override ?? this.resolveStageModel(stage);
  }

  private resolveFallbackModel(stage: AgentStageName): string | undefined {
    const provider = this.resolveStageProvider(stage);
    const currentModel = this.resolveStageModel(stage);
    const builtInDefault = provider === 'openai' ? READ_ONLY_OPENAI_MODEL : READ_ONLY_ANTHROPIC_MODEL;
    const candidate = resolveProviderModel(this.configService, provider, builtInDefault);
    if (candidate === currentModel) {
      appendToLogFile('DEBUG', `stage-agent.model.fallback.none stage=${stage} provider=${provider} model=${currentModel} reason=no-alternative-in-ai-providers`, 'stage-agent');
      return undefined;
    }
    return candidate;
  }

  private extractStreamError(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    try {
      return JSON.stringify(error) ?? 'unknown error';
    } catch {
      return 'unknown error';
    }
  }

  private resolveStageTimeoutMs(stage: AgentStageName): number {
    return this.configService.get<number>(`stages.${stage}.timeoutMs`, DEFAULT_CLI_WALL_CLOCK_TIMEOUT_MS);
  }

  private resolveStageInactivityTimeoutMs(stage: AgentStageName): number {
    return this.configService.get<number>(`stages.${stage}.inactivityTimeoutMs`, CLI_INACTIVITY_TIMEOUT_MS);
  }

  private resolveStageJsonSchema(stage: AgentStageName): string | undefined {
    return STAGE_RESPONSE_SCHEMAS[stage];
  }

  logResolvedStageTarget(stage: AgentStageName): void {
    const { provider, model } = this.resolveTargetForStage(stage);
    const message = `llm.adapter resolved-provider=${provider} resolved-model=${model}`;
    console.log(chalk.blue(`ℹ ${message}`));
    appendToLogFile('INFO', message, 'llm-adapter');
  }

  private async runStagePromptOnce(params: StagePromptParams): Promise<{ content: string; sessionId?: string }> {
    if (!params.modelOverride) this.logResolvedStageTarget(params.stage);
    try {
      return await this.dispatchToBackend(params);
    } catch (error) {
      if (!params.resumeProviderSessionId || !isStaleResumeError(error)) throw error;
      console.log(chalk.yellow(
        `  [stage-agent] Resume session ${params.resumeProviderSessionId} appears stale — retrying fresh.`
      ));
      return this.retryStagePromptFresh(params, error);
    }
  }

  private async runStagePrompt(params: StagePromptParams): Promise<StagePromptResult> {
    try {
      return await this.runStagePromptOnce(params);
    } catch (error) {
      if (!isUnavailableModelError(error)) throw error;
      const fallbackModel = this.resolveFallbackModel(params.stage);
      if (!fallbackModel) throw error;
      return this.runStagePromptWithFallback(params, error, fallbackModel);
    }
  }

  private async runStagePromptWithFallback(
    params: StagePromptParams, error: unknown, fallbackModel: string
  ): Promise<StagePromptResult> {
    const cause = (error instanceof Error ? error.message.replaceAll(/\s+/g, ' ') : String(error)).slice(0, 300);
    this.logModelFallback(params.stage, fallbackModel, cause);
    const result = await this.runStagePromptOnce({
      ...params, modelOverride: fallbackModel, resumeProviderSessionId: undefined,
    });
    return { ...result, modelUsed: fallbackModel };
  }

  private logModelFallback(stage: AgentStageName, fallbackModel: string, cause: string): void {
    const msg = `stage-agent.model.fallback stage=${stage} provider=${this.resolveStageProvider(stage)} backend=${this.resolveStageBackend(stage)} original-model=${this.resolveStageModel(stage)} fallback-model=${fallbackModel} cause=${cause}`;
    console.log(chalk.yellow(`  [stage-agent] Model unavailable — retrying with fallback-model=${fallbackModel}`));
    appendToLogFile('WARN', msg, 'stage-agent');
  }

  private async retryStagePromptFresh(
    params: StagePromptParams,
    originalError: unknown
  ): Promise<{ content: string; sessionId?: string }> {
    try {
      return await this.dispatchToBackend({ ...params, resumeProviderSessionId: undefined });
    } catch (retryError) {
      throw isStaleResumeError(retryError)
        ? new ExecutionError(this.buildStaleResumeFallbackErrorMessage(params.stage, retryError), {
            stage: params.stage,
            originalError: this.extractErrorMessage(originalError),
          })
        : retryError;
    }
  }

  private buildStaleResumeFallbackErrorMessage(stage: AgentStageName, error: unknown): string {
    return `Stage ${stage} failed after stale-resume fallback: ${this.extractErrorMessage(error)}`;
  }

  private extractErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async dispatchToBackend(params: StagePromptParams): Promise<{ content: string; sessionId?: string }> {
    const backend = this.resolveStageBackend(params.stage);
    if (backend === 'cli') return this.dispatchCliStagePrompt(params);
    const enriched = { ...params, prompt: appendAgentSdkScreenshotPaths(params.prompt, params.screenshots) };
    const provider = this.resolveStageProvider(params.stage);
    if (provider === 'anthropic') return this.runAnthropicStagePrompt(enriched);
    const content = await this.runOpenAiStagePrompt(enriched);
    return { content };
  }

  private dispatchCliStagePrompt(params: StagePromptParams): Promise<{ content: string; sessionId?: string }> {
    const provider = this.resolveStageProvider(params.stage);
    return provider === 'openai' ? this.runCodexCliStagePrompt(params) : this.runCliStagePrompt(params);
  }

  private async runAnthropicStagePrompt(params: StagePromptParams): Promise<{ content: string; sessionId?: string }> {
    const apiKey = this.requireAnthropicApiKey();
    const anthropicContext = await loadAiContextConfig(path.join(os.homedir(), '.claude', 'CLAUDE.md'), 'CLAUDE.md', 'anthropic', true);
    const options = buildAnthropicStageOptions({
      prompt: params.prompt, model: this.resolveModelForStage(params.stage, params.modelOverride), apiKey,
      repoDir: params.repoDir,
      systemPrompt: params.systemPrompt, priorStageSummary: params.priorStageSummary,
      anthropicContext, resumeProviderSessionId: params.resumeProviderSessionId,
      jsonSchema: params.jsonSchema,
      structuredOutput: params.structuredOutput,
    });
    const { query } = await loadAnthropicAgentSdk();
    return this.processAnthropicStageResult(query(options), params.onProgress);
  }

  private requireAnthropicApiKey(): string {
    const apiKey = this.configService.get<string>('ai.anthropicApiKey');
    if (!apiKey) throw new ConfigurationError('Anthropic agent backend requires `ai.anthropicApiKey` to be configured.');
    return apiKey;
  }

  private async processAnthropicStageResult(
    session: AsyncIterable<Record<string, unknown>> & { close: () => void }, onProgress?: StageProgressCallback
  ): Promise<{ content: string; sessionId?: string }> {
    return drainAnthropicSession(session, msg => {
      const outcome = extractAnthropicResultMessage(msg, onProgress);
      return outcome ? { content: outcome.trim() } : undefined;
    }, '  [claude-agent-sdk] Provider session: ');
  }

  private async runOpenAiStagePrompt(params: StagePromptParams): Promise<string> {
    const apiKey = this.requireOpenAiApiKey();
    setTracingExportApiKey(apiKey);
    if (params.resumeProviderSessionId) this.logOpenAiResumeUnsupported();
    const resolvedModel = this.resolveModelForStage(params.stage, params.modelOverride);
    const { agent, runner, context } = await this.buildOpenAiStageAgent({
      stage: params.stage, systemPrompt: params.systemPrompt, repoDir: params.repoDir,
      priorStageSummary: params.priorStageSummary, apiKey, jsonSchema: params.jsonSchema,
      structuredOutput: params.structuredOutput, model: resolvedModel,
    });
    const { content } = await this.processOpenAiStageResult(
      agent, runner, context, params.prompt, OPENAI_STAGE_MAX_TURNS, params.onProgress, resolvedModel
    );
    return content;
  }

  private logOpenAiResumeUnsupported(): void {
    console.log(chalk.yellow('  [openai-agent] Session resumption is not yet supported for the OpenAI agent backend. Starting fresh.'));
  }

  private requireOpenAiApiKey(): string {
    const apiKey = this.configService.get<string>('ai.openaiApiKey');
    if (!apiKey) throw new ConfigurationError('OpenAI agent backend requires `ai.openaiApiKey` to be configured.');
    return apiKey;
  }

  private async buildOpenAiStageAgent(
    opts: OpenAiStageAgentOptions,
  ): Promise<{ agent: Agent<OpenAiStageContext>; runner: Runner; context: OpenAiStageContext }> {
    const instructions = await loadOpenAiInstructions(opts);
    return this.buildOpenAiAgentResult(opts, instructions);
  }

  private buildOpenAiAgentResult(
    opts: OpenAiStageAgentOptions, instructions: string,
  ): { agent: Agent<OpenAiStageContext>; runner: Runner; context: OpenAiStageContext } {
    const agent = new Agent<OpenAiStageContext>({
      name: `wf ${opts.stage} openai agent backend`,
      handoffDescription: 'Uses read-only tools to inspect the repository and answer the current stage prompt.',
      instructions, model: opts.model ?? this.resolveStageModel(opts.stage),
      tools: opts.repoDir ? buildOpenAiStageTools() : [], toolUseBehavior: 'run_llm_again', resetToolChoice: true,
      ...buildOpenAiStructuredSettings(opts.structuredOutput),
    });
    return {
      agent, runner: new Runner({ modelProvider: new OpenAIProvider({ apiKey: opts.apiKey }) }),
      context: { repoDir: opts.repoDir ?? process.cwd() },
    };
  }

  private accumulateOpenAiStreamEvent(
    event: unknown,
    onProgress: StageProgressCallback | undefined,
    counts: { inputTokens: number; outputTokens: number; cachedInputTokens: number }
  ): void {
    if (onProgress) {
      const formatted = formatOpenAiProgressMessage(event);
      if (formatted) onProgress(formatted.message);
    }
    const usage = extractUsageFromEvent(event);
    if (!usage) return;
    counts.inputTokens += usage.inputTokens;
    counts.outputTokens += usage.outputTokens;
    counts.cachedInputTokens += usage.cachedInputTokens;
  }

  private async processOpenAiStageResult(
    agent: Agent<OpenAiStageContext>, runner: Runner, context: OpenAiStageContext,
    input: string, maxTurns: number, onProgress?: StageProgressCallback, model?: string
  ): Promise<{ content: string; costUsd?: number }> {
    const streamedRun = await runner.run(agent, input, { stream: true, context, maxTurns });
    const counts = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    for await (const event of streamedRun) this.accumulateOpenAiStreamEvent(event, onProgress, counts);
    if (streamedRun.error) throw new AiProviderError(`OpenAI agent run failed: ${this.extractStreamError(streamedRun.error)}`);
    const content = serializeOpenAiFinalOutput(streamedRun.finalOutput);
    const costUsd = model
      ? estimateOpenAiCostUsd(model, counts.inputTokens, counts.outputTokens, counts.cachedInputTokens) ?? undefined
      : undefined;
    return { content, costUsd };
  }

  private async chatTurnOnce(params: ChatTurnParams): Promise<AgentChatTurnResult> {
    const backend = this.resolveStageBackend(params.stage);
    const provider = this.resolveStageProvider(params.stage);
    if (!params.modelOverride) this.logResolvedStageTarget(params.stage);
    if (backend === 'cli') {
      return provider === 'openai' ? this.codexCliChatTurn(params) : this.cliChatTurn(params);
    }
    if (provider === 'anthropic') {
      return this.anthropicChatTurn(params);
    }
    return this.validateAndReturnOpenAiChat(params);
  }

  async chatTurn(params: ChatTurnParams): Promise<AgentChatTurnResult> {
    try {
      return await this.chatTurnOnce(params);
    } catch (error) {
      if (!isUnavailableModelError(error)) throw error;
      const fallbackModel = this.resolveFallbackModel(params.stage);
      if (!fallbackModel) throw error;
      return this.chatTurnWithFallback(params, error, fallbackModel);
    }
  }

  private async chatTurnWithFallback(
    params: ChatTurnParams, error: unknown, fallbackModel: string
  ): Promise<AgentChatTurnResult> {
    const cause = (error instanceof Error ? error.message.replaceAll(/\s+/g, ' ') : String(error)).slice(0, 300);
    this.logModelFallback(params.stage, fallbackModel, cause);
    return this.chatTurnOnce({ ...params, modelOverride: fallbackModel, session: undefined });
  }

  private async validateAndReturnOpenAiChat(params: ChatTurnParams): Promise<AgentChatTurnResult> {
    const result = await this.openAiChatTurn(params);
    requireAiResponseContent(
      { content: result.content, provider: 'openai', model: this.resolveModelForStage(params.stage, params.modelOverride) },
      'AI provider returned an empty chat response'
    );
    return result;
  }

  private async anthropicChatTurn(params: ChatTurnParams): Promise<AgentChatTurnResult> {
    const apiKey = this.requireAnthropicApiKey();
    const anthropicContext = await loadAiContextConfig(path.join(os.homedir(), '.claude', 'CLAUDE.md'), 'CLAUDE.md', 'anthropic', true);
    const options = buildAnthropicChatOptions({
      prompt: params.userMessage, model: this.resolveModelForStage(params.stage, params.modelOverride), apiKey,
      repoDir: params.repoDir,
      systemPrompt: params.systemPrompt, anthropicContext, resumeSessionId: params.session?.sessionId,
      structuredOutput: params.structuredOutput,
    });
    const { query } = await loadAnthropicAgentSdk();
    return this.processAnthropicChatResult(query(options), params.session?.sessionId);
  }

  private async processAnthropicChatResult(
    session: AsyncIterable<Record<string, unknown>> & { close: () => void }, existingSessionId?: string
  ): Promise<AgentChatTurnResult> {
    let costUsd: number | undefined;
    const result = await drainAnthropicSession(session, msg => {
      const outcome = extractAnthropicResultMessage(msg);
      if (!outcome) return undefined;
      const rawCost = (msg as { total_cost_usd?: unknown }).total_cost_usd;
      if (typeof rawCost === 'number') costUsd = rawCost;
      return { content: outcome.trim() };
    }, '');
    const sessionId = result.sessionId ?? existingSessionId;
    return { content: result.content, costUsd, session: { provider: 'anthropic' as const, sessionId } };
  }

  private async openAiChatTurn(params: ChatTurnParams): Promise<AgentChatTurnResult> {
    const apiKey = this.requireOpenAiApiKey();
    setTracingExportApiKey(apiKey);
    const resolvedModel = this.resolveModelForStage(params.stage, params.modelOverride);
    const { agent, runner, context } = await this.resolveOpenAiChatAgent(params, apiKey, resolvedModel);
    const runInput = (params.session?.runState ?? params.userMessage) as string;
    const { content, costUsd } = await this.processOpenAiStageResult(
      agent, runner, context, runInput, OPENAI_CHAT_MAX_TURNS, undefined, resolvedModel
    );
    return this.buildOpenAiChatResult(content, costUsd, agent, runner);
  }

  private async resolveOpenAiChatAgent(
    params: Pick<ChatTurnParams, 'stage' | 'systemPrompt' | 'repoDir' | 'session' | 'structuredOutput'>,
    apiKey: string,
    model: string
  ): Promise<{ agent: Agent<OpenAiStageContext>; runner: Runner; context: OpenAiStageContext }> {
    const reusableAgent = params.session?.agent as Agent<OpenAiStageContext> | undefined;
    const reusableRunner = params.session?.runner as Runner | undefined;
    if (reusableAgent && reusableRunner) {
      return { agent: reusableAgent, runner: reusableRunner, context: { repoDir: params.repoDir ?? process.cwd() } };
    }
    return this.buildOpenAiStageAgent({
      stage: params.stage, systemPrompt: params.systemPrompt, repoDir: params.repoDir,
      apiKey, structuredOutput: params.structuredOutput, model,
    });
  }

  private buildOpenAiChatResult(
    content: string,
    costUsd: number | undefined,
    agent: Agent<OpenAiStageContext>,
    runner: Runner
  ): AgentChatTurnResult {
    return { content, costUsd, session: { provider: 'openai' as const, agent, runner } };
  }

  private async runCliStagePrompt(params: StagePromptParams): Promise<{ content: string; sessionId?: string }> {
    assertClaudeCliAvailable();
    const preamble = buildPriorStagePreamble(params.priorStageSummary);
    const systemPrompt = preamble ? `${preamble}\n\n${params.systemPrompt}` : params.systemPrompt;
    const passOpts: CliStagePassOpts = {
      stage: params.stage, prompt: params.prompt, systemPrompt,
      model: this.resolveModelForStage(params.stage, params.modelOverride), repoDir: params.repoDir,
      jsonSchema: params.structuredOutput
        ? JSON.stringify(params.structuredOutput.schema)
        : params.jsonSchema ?? this.resolveStageJsonSchema(params.stage),
      resumeProviderSessionId: params.resumeProviderSessionId, onProgress: params.onProgress,
      forkSession: params.forkSession, screenshots: params.screenshots,
    };
    return this.runCliRetryLoop(passOpts, params.stage, params.resumeProviderSessionId);
  }

  private async runGenericCliRetryLoop(
    stage: AgentStageName, initialSessionId: string | undefined, validate: boolean,
    runPass: (sessionId: string | undefined, passNumber: number) => Promise<CliPassResult>,
    responseValidator?: ResponseValidator, useStageSchema = true
  ): Promise<{ content: string; costUsd?: number; sessionId?: string }> {
    const state = makeCliRetryState(initialSessionId);
    try {
      return await this.executeCliPasses(state, stage, validate, runPass, responseValidator, useStageSchema);
    } catch (error) {
      if (state.sessionId && isAiProviderErrorLike(error)) {
        error.details = { ...error.details, sessionId: state.sessionId };
      }
      throw error;
    }
  }

  private async executeCliPasses(
    state: CliRetryState, stage: AgentStageName, validate: boolean,
    runPass: (sessionId: string | undefined, passNumber: number) => Promise<CliPassResult>,
    responseValidator?: ResponseValidator, useStageSchema = true
  ): Promise<{ content: string; costUsd?: number; sessionId?: string }> {
    while (true) {
      const passResult = await this.runAndRecordCliPass(state, runPass);
      const outcome = this.tryFinalizeCliPass(
        passResult, stage, state.passNumber, state.sessionId, validate, responseValidator, useStageSchema
      );
      if (outcome.kind === 'completed') return { content: outcome.content, sessionId: outcome.sessionId, costUsd: state.costUsd };
      if (outcome.kind === 'schema-retry' && applySchemaRetry(state, stage, outcome, responseValidator)) continue;
      advanceCliRetryState(state, passResult);
    }
  }

  private async runAndRecordCliPass(
    state: CliRetryState,
    runPass: (sessionId: string | undefined, passNumber: number) => Promise<CliPassResult>
  ): Promise<CliPassResult> {
    state.passNumber++;
    const passResult = await runPass(state.sessionId, state.passNumber);
    if (passResult.sessionId) state.sessionId = passResult.sessionId;
    if (passResult.costUsd != null) state.costUsd = (state.costUsd ?? 0) + passResult.costUsd;
    return passResult;
  }

  private async runCliRetryLoop(
    passOpts: CliStagePassOpts, stage: AgentStageName, initialSessionId?: string
  ): Promise<{ content: string; costUsd?: number; sessionId?: string }> {
    return this.runGenericCliRetryLoop(
      stage, initialSessionId, Boolean(passOpts.jsonSchema),
      (sessionId, passNumber) => this.runCliStagePass({ ...passOpts, sessionId, passNumber }),
      passOpts.responseValidator, true
    );
  }

  private tryFinalizeCliPass(
    passResult: CliPassResult, stage: AgentStageName, passNumber: number, sessionId?: string, validate?: boolean,
    responseValidator?: ResponseValidator, useStageSchema = true
  ): CliPassOutcome {
    passResult.schemaExpected = Boolean(validate);
    logCliPassOutcome({ sessionId, passNumber, stalledPasses: 0, lastDiagnostics: [], schemaMisses: 0 }, passResult);
    if (!passResult.result || passResult.source === 'assistant_text') return { kind: 'no-result' };
    this.checkCliMaxTokens(passResult.stopReason, stage);
    const retryOutcome = this.resolveCliSchemaRetry(
      passResult, stage, passNumber, sessionId, validate, responseValidator, useStageSchema
    );
    if (retryOutcome) return retryOutcome;
    this.logCliPassCompletion(passResult, passNumber, sessionId);
    return { kind: 'completed', content: passResult.result.trim(), sessionId };
  }

  private logCliPassCompletion(passResult: CliPassResult, passNumber: number, sessionId?: string): void {
    console.log(chalk.cyan(`  [${CLI_STAGE_LABEL}] Result extracted via ${passResult.source} (pass ${passNumber})`));
    if (sessionId) console.log(chalk.cyan(`  [${CLI_STAGE_LABEL}] Provider session: ${sessionId}`));
  }

  private resolveCliSchemaRetry(
    passResult: CliPassResult,
    stage: AgentStageName,
    passNumber: number,
    sessionId: string | undefined,
    validate: boolean | undefined,
    responseValidator?: ResponseValidator, useStageSchema = true
  ): CliPassOutcome | null {
    if (!validate || passResult.source === 'structured_output') return null;
    this.logStructuredOutputMissing(passNumber, passResult.source, sessionId);
    return this.buildCliSchemaRetryOutcome(stage, passResult.result, responseValidator, useStageSchema);
  }

  private logStructuredOutputMissing(
    passNumber: number,
    source: CliPassResult['source'],
    sessionId: string | undefined
  ): void {
    const message = `cli.structured_output_missing pass=${passNumber} `
      + `source=${source ?? 'none'} session=${sessionId ?? 'none'}`;
    appendToLogFile('WARN', message, CLI_STAGE_LABEL);
  }

  private buildCliSchemaRetryOutcome(
    stage: AgentStageName, content = '', responseValidator?: ResponseValidator, useStageSchema = true
  ): CliPassOutcome | null {
    if (!responseValidator && !useStageSchema) {
      return { kind: 'schema-retry', content, issues: 'Structured output was not returned' };
    }
    const issues = resolveResponseIssues(stage, content, responseValidator);
    return issues ? { kind: 'schema-retry', content, issues } : null;
  }

  private checkCliMaxTokens(stopReason: string | undefined, stage: AgentStageName): void {
    if (stopReason !== 'max_tokens') return;
    throw new AiProviderError(
      `CLI response was truncated due to output token limit — the model ran out of space before `
      + `completing the response. Reduce prompt/context size or switch to provider-backed OpenAI if you need a larger output budget.`,
      { stopReason, stage }, true, 'truncation'
    );
  }

  private async runCliStagePass(opts: CliStagePassOpts & { passNumber: number }): Promise<CliPassResult> {
    const isResume = this.isCliResumePass(opts);
    const retryPrompt = opts.jsonSchema ? cliRetryPrompt : cliChatRetryPrompt;
    const prompt = isResume && opts.passNumber > 1 ? retryPrompt : opts.prompt;
    const args = this.buildCliStagePassArgs(opts, prompt, isResume);
    const result = await this.processCliStagePassMessages(opts, args, prompt);
    result.schemaExpected = Boolean(opts.jsonSchema);
    return result;
  }

  private isCliResumePass(opts: CliStagePassOpts & { passNumber: number }): boolean {
    return Boolean((opts.passNumber > 1 && opts.sessionId) || (opts.passNumber === 1 && opts.resumeProviderSessionId));
  }

  private buildCliStagePassArgs(
    opts: CliStagePassOpts & { passNumber: number }, prompt: string, isResume: boolean
  ): ReturnType<typeof buildCliArgs> {
    return buildCliArgs({
      prompt, appendSystemPrompt: opts.systemPrompt, model: opts.model,
      cwd: opts.repoDir ?? process.cwd(), tools: this.resolveCliInspectionTools(opts.repoDir),
      permissionMode: 'plan', sessionId: isResume ? opts.sessionId : undefined,
      jsonSchema: opts.jsonSchema, forkSession: opts.passNumber === 1 ? opts.forkSession : undefined,
      screenshots: opts.screenshots,
    });
  }

  private resolveCliInspectionTools(repoDir?: string): string[] {
    return repoDir ? ['Read', 'Glob', 'Grep', 'Bash', 'Skill'] : [];
  }

  private async processCliStagePassMessages(
    opts: CliStagePassOpts & { passNumber: number },
    args: ReturnType<typeof buildCliArgs>,
    prompt: string
  ): Promise<CliPassResult> {
    return processCliPassMessages(
      args,
      opts.repoDir ?? process.cwd(),
      prompt,
      this.resolveStageTimeoutMs(opts.stage),
      this.resolveStageInactivityTimeoutMs(opts.stage),
      opts.onProgress
    );
  }

  private buildCodexPrompt(params: StagePromptParams): string {
    const preamble = buildPriorStagePreamble(params.priorStageSummary);
    const schemaSection = buildCodexSchemaSection(params.stage);
    const screenshotPaths = params.screenshots?.length
      ? '\n\nDesign screenshots (accessible via filesystem):\n' + params.screenshots.map(s => `- ${s.path}`).join('\n')
      : '';
    return `${preamble ? preamble + '\n\n' : ''}${params.systemPrompt}\n\n${params.prompt}${schemaSection}${screenshotPaths}`;
  }

  private resolveCodexStageJsonSchema(params: StagePromptParams): string | undefined {
    if (!params.structuredOutput) return params.jsonSchema ?? this.resolveStageJsonSchema(params.stage);
    const serialized = serializeOpenAiJsonSchema(params.structuredOutput.schema);
    if (!serialized) throw new AiProviderError(`Structured output schema for '${params.structuredOutput.name}' cannot be normalized — schema root must be a JSON Schema object.`, { name: params.structuredOutput.name }, false, 'config');
    return serialized;
  }

  private async runCodexCliStagePrompt(params: StagePromptParams): Promise<{ content: string; sessionId?: string }> {
    assertCodexCliAvailable();
    const model = this.resolveModelForStage(params.stage, params.modelOverride);
    const repoDir = params.repoDir ?? process.cwd();
    return this.runCodexRetryLoop({
      stage: params.stage, model, repoDir, initialPrompt: this.buildCodexPrompt(params),
      initialSessionId: params.resumeProviderSessionId, onProgress: params.onProgress,
      timeoutMs: this.resolveStageTimeoutMs(params.stage),
      inactivityTimeoutMs: this.resolveStageInactivityTimeoutMs(params.stage),
      jsonSchema: this.resolveCodexStageJsonSchema(params),
    });
  }

  private async runCodexStagePass(opts: {
    stage: AgentStageName; model: string; repoDir: string; prompt: string;
    sessionId?: string;
    onProgress?: StageProgressCallback;
    timeoutMs?: number;
    inactivityTimeoutMs?: number;
    jsonSchema?: string;
  }): Promise<{ content: string; sessionId?: string; costUsd?: number }> {
    const schemaPath = await this.createCodexSchemaFile(opts.jsonSchema);
    return this.executeCodexStagePassWithCleanup(opts, schemaPath);
  }

  private async executeCodexStagePassWithCleanup(
    opts: { stage: AgentStageName; model: string; repoDir: string; prompt: string; sessionId?: string;
      onProgress?: StageProgressCallback; timeoutMs?: number; inactivityTimeoutMs?: number; },
    schemaPath?: string,
  ): Promise<{ content: string; sessionId?: string; costUsd?: number }> {
    try {
      const args = this.buildCodexStageArgs(opts, schemaPath);
      return await this.executeCodexStagePass(opts, args);
    } finally {
      if (schemaPath) await fs.rm(schemaPath, { force: true });
    }
  }

  private executeCodexStagePass(
    opts: { stage: AgentStageName; model: string; repoDir: string; prompt: string; sessionId?: string;
      onProgress?: StageProgressCallback; timeoutMs?: number; inactivityTimeoutMs?: number; },
    args: string[],
  ): Promise<{ content: string; sessionId?: string; costUsd?: number }> {
    return processCodexStageResult(args, opts.repoDir, opts.prompt, opts.stage, {
      sessionId: opts.sessionId, model: opts.model, onProgress: opts.onProgress,
      timeoutMs: opts.timeoutMs, inactivityTimeoutMs: opts.inactivityTimeoutMs,
    });
  }

  private async createCodexSchemaFile(schema?: string): Promise<string | undefined> {
    if (!schema) return undefined;
    const schemaPath = path.join(os.tmpdir(), `wf-codex-schema-${process.pid}-${Date.now()}.json`);
    await fs.writeFile(schemaPath, schema, 'utf8');
    return schemaPath;
  }

  private buildCodexStageArgs(
    opts: { prompt: string; model: string; repoDir: string; sessionId?: string }, outputSchemaPath?: string,
  ): string[] {
    return buildCodexCliArgs({ ...opts, cwd: opts.repoDir, outputSchemaPath });
  }

  private async runCodexRetryLoop(opts: {
    stage: AgentStageName; model: string; repoDir: string; initialPrompt: string;
    initialSessionId?: string;
    onProgress?: StageProgressCallback;
    responseValidator?: ResponseValidator;
    timeoutMs?: number;
    inactivityTimeoutMs?: number;
    jsonSchema?: string;
  }): Promise<{ content: string; sessionId?: string; costUsd?: number }> {
    const passBase = this.buildCodexPassBase(opts);
    let sessionId = opts.initialSessionId;
    const pass1 = await this.runCodexStagePass({ ...passBase, prompt: opts.initialPrompt, sessionId });
    if (pass1.sessionId) sessionId = pass1.sessionId;
    return this.finishCodexRetryLoop(opts, passBase, sessionId, pass1);
  }

  private buildCodexPassBase(opts: {
    stage: AgentStageName; model: string; repoDir: string; onProgress?: StageProgressCallback;
    responseValidator?: ResponseValidator; timeoutMs?: number; inactivityTimeoutMs?: number; jsonSchema?: string;
  }): CodexPassBase {
    return {
      stage: opts.stage, model: opts.model, repoDir: opts.repoDir, onProgress: opts.onProgress,
      responseValidator: opts.responseValidator, timeoutMs: opts.timeoutMs,
      inactivityTimeoutMs: opts.inactivityTimeoutMs, jsonSchema: opts.jsonSchema,
    };
  }

  private async finishCodexRetryLoop(
    opts: { stage: AgentStageName; responseValidator?: ResponseValidator },
    passBase: CodexPassBase, sessionId: string | undefined,
    pass1: { content: string; sessionId?: string; costUsd?: number },
  ): Promise<{ content: string; sessionId?: string; costUsd?: number }> {
    if ((!passBase.jsonSchema && !opts.responseValidator) || !STAGE_RESPONSE_SCHEMAS[opts.stage]) return pass1;
    const issues1 = resolveResponseIssues(opts.stage, pass1.content, opts.responseValidator);
    if (!issues1) return { content: pass1.content, sessionId, costUsd: pass1.costUsd };
    if (!sessionId) return throwCodexParseError(
      opts.stage, pass1.content, issues1, sessionId, opts.responseValidator
    );
    return this.runCodexSchemaRetry(
      passBase, opts.stage, issues1, sessionId, pass1.content, pass1.costUsd, opts.responseValidator
    );
  }

  private async runCodexRetryPass(
    passBase: CodexPassBase, issues1: string, sessionId: string, invalidContent: string
  ): Promise<{ content: string; sessionId?: string; costUsd?: number }> {
    try {
      return await this.runCodexStagePass({ ...passBase, prompt: buildCodexRetryPrompt(issues1), sessionId });
    } catch (error) {
      if (isNonRetryableCodexError(error)) throw error;
      return { content: invalidContent, sessionId };
    }
  }

  private async runCodexSchemaRetry(
    passBase: CodexPassBase, stage: AgentStageName, issues1: string, sessionId: string,
    invalidContent: string, pass1CostUsd?: number, responseValidator?: ResponseValidator
  ): Promise<{ content: string; sessionId?: string; costUsd?: number }> {
    console.log(chalk.yellow(`  [${CODEX_STAGE_LABEL}] Pass 1: schema miss — retrying`));
    const pass2 = await this.runCodexRetryPass(passBase, issues1, sessionId, invalidContent);
    const finalSessionId = pass2.sessionId ?? sessionId;
    const costUsd = pass1CostUsd == null && pass2.costUsd == null
      ? undefined
      : (pass1CostUsd ?? 0) + (pass2.costUsd ?? 0);
    const issues2 = resolveResponseIssues(stage, pass2.content, responseValidator);
    if (!issues2) return { content: pass2.content, sessionId: finalSessionId, costUsd };
    return throwCodexParseError(stage, pass2.content, issues2, finalSessionId, responseValidator);
  }

  private async sendCliReviewEpilogue(params: {
    sessionId: string;
    repoDir: string;
    systemPrompt: string;
    priorStageSummary?: string;
  }): Promise<{ sent: true } | { sent: false; reason: string }> {
    const model = this.resolveStageModel('review');
    const provider = this.resolveStageProvider('review');
    this.logResolvedStageTarget('review');
    return provider === 'openai'
      ? this.sendCodexEpilogue(params.sessionId, params.repoDir, model)
      : this.sendClaudeEpilogue(
          params.sessionId, params.repoDir, model, params.systemPrompt, params.priorStageSummary
        );
  }

  private async sendCodexEpilogue(
    sessionId: string, repoDir: string, model: string
  ): Promise<{ sent: true } | { sent: false; reason: string }> {
    const args = buildCodexCliArgs({
      prompt: cliEpiloguePrompt, sessionId, model, cwd: repoDir,
    });
    const stream = spawnCodex(args, repoDir, cliEpiloguePrompt, undefined, this.resolveReviewEpilogueTimeoutMs());
    for await (const message of stream) {
      if (message.is_error) return { sent: false, reason: extractCliDiagnostic(message) ?? 'CLI error' };
    }
    return { sent: true };
  }

  private async sendClaudeEpilogue(
    sessionId: string, repoDir: string, model: string, systemPrompt: string, priorStageSummary?: string
  ): Promise<{ sent: true } | { sent: false; reason: string }> {
    const preamble = buildPriorStagePreamble(priorStageSummary);
    const appendSystemPrompt = this.buildClaudeEpilogueSystemPrompt(systemPrompt, preamble);
    const args = this.buildClaudeEpilogueArgs({ sessionId, repoDir, model, appendSystemPrompt });
    const stream = spawnCli(args, repoDir, cliEpiloguePrompt, undefined,
      this.resolveReviewEpilogueTimeoutMs(), undefined, { wallClock: 'stages.review.epilogueTimeoutMs' });
    for await (const message of stream) {
      if (message.is_error) return { sent: false, reason: extractCliDiagnostic(message) ?? 'CLI error' };
    }
    return { sent: true };
  }

  private buildClaudeEpilogueArgs(opts: {
    sessionId: string;
    repoDir: string;
    model: string;
    appendSystemPrompt: string;
  }): ReturnType<typeof buildCliArgs> {
    return buildCliArgs(this.buildClaudeEpilogueArgOptions(opts));
  }

  private buildClaudeEpilogueSystemPrompt(systemPrompt: string, preamble: string): string {
    return preamble ? `${preamble}\n\n${systemPrompt}` : systemPrompt;
  }

  private buildClaudeEpilogueArgOptions(
    opts: { sessionId: string; repoDir: string; model: string; appendSystemPrompt: string }
  ): Parameters<typeof buildCliArgs>[0] {
    return {
      prompt: cliEpiloguePrompt,
      appendSystemPrompt: opts.appendSystemPrompt,
      model: opts.model,
      sessionId: opts.sessionId,
      cwd: opts.repoDir,
      permissionMode: 'plan',
      tools: this.resolveCliInspectionTools(opts.repoDir),
      jsonSchema: undefined,
      forkSession: true,
    };
  }

  private resolveReviewEpilogueTimeoutMs(): number {
    return this.configService.get<number>('stages.review.epilogueTimeoutMs', CLI_REVIEW_EPILOGUE_TIMEOUT_MS);
  }

  private async cliChatTurn(
    params: ChatTurnParams
  ): Promise<{ content: string; costUsd?: number; session: AgentChatSession }> {
    assertClaudeCliAvailable();
    const chatPassOpts: CliChatPassOpts = {
      stage: params.stage, userMessage: params.userMessage, systemPrompt: params.systemPrompt,
      model: this.resolveModelForStage(params.stage, params.modelOverride), repoDir: params.repoDir,
      initialSessionId: params.session?.sessionId,
      responseValidator: params.responseValidator,
      jsonSchema: params.structuredOutput ? JSON.stringify(params.structuredOutput.schema) : params.jsonSchema,
    };
    const result = await this.runCliChatRetryLoop(chatPassOpts, params.stage, params.session?.sessionId);
    return { content: result.content, costUsd: result.costUsd, session: { provider: 'anthropic' as const, backend: 'cli', sessionId: result.sessionId } };
  }

  private buildCodexChatPrompt(params: ChatTurnParams): string {
    return params.systemPrompt + '\n\n' + params.userMessage;
  }

  private buildCodexCliChatResult(result: {
    content: string; costUsd?: number; sessionId?: string;
  }): AgentChatTurnResult {
    return {
      content: result.content,
      costUsd: result.costUsd,
      session: { provider: 'openai' as const, backend: 'cli', sessionId: result.sessionId },
    };
  }

  private buildCodexCliChatRunOptions(params: ChatTurnParams) {
    return {
      stage: params.stage, model: this.resolveModelForStage(params.stage, params.modelOverride),
      repoDir: params.repoDir ?? process.cwd(),
      initialPrompt: this.buildCodexChatPrompt(params), initialSessionId: params.session?.sessionId,
      responseValidator: params.responseValidator,
      timeoutMs: this.resolveStageTimeoutMs(params.stage),
      inactivityTimeoutMs: this.resolveStageInactivityTimeoutMs(params.stage),
      jsonSchema: params.structuredOutput
        ? serializeOpenAiJsonSchema(params.structuredOutput.schema)
        : params.jsonSchema,
    };
  }

  private async codexCliChatTurn(
    params: ChatTurnParams
  ): Promise<{ content: string; costUsd?: number; session: AgentChatSession }> {
    assertCodexCliAvailable();
    const result = await this.runCodexRetryLoop(this.buildCodexCliChatRunOptions(params));
    return this.buildCodexCliChatResult(result);
  }

  private async runCliChatRetryLoop(
    passOpts: CliChatPassOpts, stage: AgentStageName, initialSessionId?: string
  ): Promise<{ content: string; costUsd?: number; sessionId?: string }> {
    return this.runGenericCliRetryLoop(
      stage, initialSessionId, Boolean(passOpts.jsonSchema),
      (sessionId, passNumber) => this.runCliChatPass({ ...passOpts, sessionId, passNumber }),
      passOpts.responseValidator, false
    );
  }

  private async runCliChatPass(
    opts: CliChatPassOpts & { sessionId?: string; passNumber: number }
  ): Promise<CliPassResult> {
    const isResume = opts.passNumber > 1 && opts.sessionId;
    const retryPrompt = opts.jsonSchema ? cliRetryPrompt : cliChatRetryPrompt;
    const prompt = isResume ? retryPrompt : opts.userMessage;
    const resolvedRepoDir = opts.repoDir ?? process.cwd();
    const args = buildCliArgs({
      prompt, appendSystemPrompt: opts.systemPrompt, model: opts.model, cwd: resolvedRepoDir,
      sessionId: isResume ? opts.sessionId : opts.initialSessionId,
      tools: this.resolveCliInspectionTools(opts.repoDir), permissionMode: 'plan', jsonSchema: opts.jsonSchema,
    });
    return processCliPassMessages(args, resolvedRepoDir, prompt,
      this.resolveStageTimeoutMs(opts.stage), this.resolveStageInactivityTimeoutMs(opts.stage));
  }
}
