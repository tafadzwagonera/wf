import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Agent, OpenAIProvider, Runner, setTracingExportApiKey, tool } from '@openai/agents';
import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import chalk from 'chalk';
import dayjs from 'dayjs';
import { formatProgressMessage as formatAnthropicProgressMessage } from './adapters/anthropic-agent.adapter';
import { formatProgressMessage as formatOpenAiProgressMessage } from './adapters/openai-agent.adapter';
import { loadAnthropicAgentSdk } from './adapters/load-anthropic-agent-sdk';
import { loadAiContextConfig } from './adapters/load-ai-context-config';
import { JSON_OUTPUT_RULES } from './json-output-rules';
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
  parseJsonResponse,
  requireAiResponseContent,
  requireReviewResponseContent,
  ResolutionPlan,
  sanitizeCodeReviewTrace,
} from './ai.service';
import { resolutionPlanSchema } from '../../shared/schemas/ai.schema';
import { codeReviewSchema } from '../../shared/schemas/review.schema';
import { AIError, ExecutionError, isAIErrorLike } from '../../shared/utils/errors';
import type { TestInfraContext } from '../../shared/types/detection.types';
import { formatTestInfraPromptSection } from '../../shared/utils/detect-test-infra';
import { postProcessCodeReview } from '../../review/code-review-post-processing';
import {
  formatRepoConventionsPromptSection,
  type RepoConventionsContext,
} from '../../shared/utils/detect-repo-conventions';
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
import type { AgentStageName, StageProgressCallback } from '../../shared/types/agent.types';
import { resolveProviderModel } from './adapters/shared-routing';

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
const CLI_STALL_THRESHOLD = DEFAULT_STALL_THRESHOLD;
const CLI_REVIEW_EPILOGUE_TIMEOUT_MS = 5000;
const CLI_EPILOGUE_PROMPT
  = 'Summarize the code review you just completed in a brief, human-readable format. '
    + 'Include: approval status, issue count by severity, and top suggestions. '
    + 'IMPORTANT: Do NOT repeat the raw JSON.';
const DEFAULT_CLI_WALL_CLOCK_TIMEOUT_MS = 30 * 60 * 1000;

const CODEX_STAGE_LABEL = 'codex-cli';

const CLI_RETRY_PROMPT
  = 'Your previous response did not include a usable result. Please output ONLY a valid JSON object matching the resolution plan schema. Do not include commentary or markdown — IMPORTANT: raw, minified JSON only (no unnecessary whitespace or newlines). JSON string values must not contain literal newline characters — use \\n for line breaks within strings.';

const CLI_CHAT_RETRY_PROMPT
  = 'Your previous response did not include a usable result. Please respond with the requested content directly.';

type CliPassResult = {
  diagnostics: string[];
  hadContent: boolean;
  result: string;
  sessionId: string | undefined;
  source: 'structured_output' | 'result' | 'assistant_text' | undefined;
  stopReason: string | undefined;
};

type CliChatPassOpts = {
  allowInspection: boolean;
  initialSessionId?: string;
  model: string;
  resolvedRepoDir: string;
  stage: AgentStageName;
  systemPrompt: string;
  userMessage: string;
};

type CliStagePassOpts = {
  allowInspection: boolean;
  jsonSchema?: string;
  model: string;
  onProgress?: StageProgressCallback;
  passNumber?: number;
  prompt: string;
  resolvedRepoDir: string;
  resumeProviderSessionId?: string;
  sessionId?: string;
  stage: AgentStageName;
  systemPrompt: string;
};

const PLAN_SYSTEM_PROMPT = `You are an expert software engineer creating detailed resolution plans.
You may inspect repository files with read-only tools before answering.
Return your response as a JSON object matching the ResolutionPlan interface.`;

const REVIEW_SYSTEM_PROMPT = `You are an expert code reviewer providing constructive feedback.
You may inspect repository files with read-only tools before answering.
Focus on code quality, bugs, security, and the changed execution path.
Ignore JSON or markdown files under .wf/ and tracker artifact directories.`;

const GENERATE_SYSTEM_PROMPT = `You are an expert technical writer and repository analyst.
You may inspect repository files with read-only tools before answering.
Return only the requested ticket markdown and preserve the required heading structure exactly.`;

/**
 * @param text - raw text to truncate
 * @param maxLength - maximum allowed character count
 * @returns truncated text with ellipsis if over limit, original otherwise
 */
const truncateCodexText = (text: string, maxLength: number): string =>
  text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;

/**
 * @param item - completed command execution item
 * @returns formatted command completion line
 */
/**
 * @param exitCode - process exit code
 * @returns human-readable completion status
 */
const resolveExitStatus = (exitCode?: number): string => {
  if (exitCode == null) return 'status unknown';
  return exitCode === 0 ? 'completed' : `exit ${exitCode}`;
};

const formatCodexCommandCompletion = (item: { exit_code?: number | null; command?: string }): string =>
  `[${CODEX_STAGE_LABEL}] Command ${resolveExitStatus(item.exit_code ?? undefined)}: ${truncateCodexText(item.command ?? 'unknown', 60)}`;

/**
 * @param message - a completed-item Codex CLI message
 * @returns formatted progress string or null
 */
const formatCodexCompletedItem = (message: CodexCliMessage): string | null => {
  if (message.item?.type === 'agent_message' && message.item.text) return `[${CODEX_STAGE_LABEL}] Agent: ${truncateCodexText(message.item.text, 120)}`;
  if (message.item?.type === 'command_execution') return formatCodexCommandCompletion(message.item);
  return null;
};

/**
 * @param message - a parsed Codex CLI NDJSON message
 * @returns formatted progress string or null if the message type is not display-worthy
 */
const formatCodexProgressMessage = (message: CodexCliMessage): string | null => {
  if (message.type === 'thread.started' && message.thread_id) return `[${CODEX_STAGE_LABEL}] Session started: ${message.thread_id}`;
  if (message.type === 'item.started' && message.item?.type === 'command_execution' && message.item.command) return `[${CODEX_STAGE_LABEL}] Running: ${truncateCodexText(message.item.command, 80)}`;
  if (message.type === 'item.completed') return formatCodexCompletedItem(message);
  if (message.type === 'turn.completed' && message.usage) return `[${CODEX_STAGE_LABEL}] Turn complete (${message.usage.input_tokens} in / ${message.usage.output_tokens} out)`;
  return null;
};

/**
 * @param block - a single content block from a CLI assistant message
 * @returns the block's text if it is a text block, empty string otherwise
 */
const extractTextBlockContent = (block: unknown): string => {
  if (typeof block !== 'object' || block === null) return '';
  const record = block as Record<string, unknown>;
  return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
};

/**
 * Extracts the last assistant turn's text from a CLI NDJSON message.
 * Only the last assistant turn is relevant — earlier turns may contain
 * JSON-like fragments from intermediate analysis.
 *
 * @param message - a parsed CLI NDJSON message
 * @returns concatenated text content or undefined if not an assistant message
 */
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

type StagePromptParams = {
  onProgress?: StageProgressCallback;
  priorStageSummary?: string;
  prompt: string;
  repoDir?: string;
  resumeProviderSessionId?: string;
  stage: AgentStageName;
  systemPrompt: string;
};

type ChatTurnParams = {
  repoDir?: string;
  session?: AgentChatSession;
  stage: AgentStageName;
  systemPrompt: string;
  userMessage: string;
};

const resolveStagePromptRepoExample = (repositories?: string[]): string => {
  const firstRepository = repositories?.find(repository => typeof repository === 'string' && repository.trim());
  return firstRepository?.trim() || 'current-repo';
};

const isReadOnlyCommand = (command: string): boolean =>
  ALLOWED_READ_ONLY_COMMAND_PREFIXES.some(prefix => command === prefix || command.startsWith(prefix));

type GeneratePlanParams = {
  action: 'fix' | 'feature' | 'investigate';
  affectedRepositories?: string[];
  conventions?: RepoConventionsContext;
  crossRepoPatterns?: CrossRepoContext;
  issueContent: string;
  planCorrelation?: PlanCorrelationResult;
  planQualityFeedback?: string[];
  priorPlans?: PriorPlanContext;
  skillNames?: string[];
  testInfra?: TestInfraContext;
  ticketKey?: string;
};

/**
 * @param params - plan generation parameters including discovery context
 * @returns discovery context block string (may be empty)
 */
const buildPlanDiscoveryBlock = (params: GeneratePlanParams): string => {
  const repoName = params.affectedRepositories?.[0] ?? 'repo';
  const parts = [
    params.conventions ? formatRepoConventionsPromptSection(params.conventions, repoName) : '',
    params.crossRepoPatterns ? formatCrossRepoPatternsPromptSection(params.crossRepoPatterns) : '',
    params.planCorrelation ? formatPlanCorrelationPromptSection(params.planCorrelation) : '',
    params.priorPlans ? formatPriorPlansPromptSection(params.priorPlans) : '',
  ].filter(Boolean);
  return parts.length > 0 ? `\n${parts.join('\n\n')}\n` : '';
};

/**
 * @param params - plan generation parameters including test infra context
 * @returns test conventions block for inclusion in the plan prompt
 */
const buildPlanTestConventionsBlock = (params: GeneratePlanParams): string => {
  if (!params.testInfra) return '';
  return `When a plan step includes test code snippets or prescribes test changes:
   - Follow ALL test conventions listed above (mock cleanup, DI setup, error handling).
   - Mock isolation steps MUST be concrete, not conditional — prescribe the exact call, do not say "check whether X or add Y".
   - Test setup MUST match the DI wiring the code path requires — every injected service the code reaches MUST have a mock provider, not an empty object.
   - Follow the repo's existing test isolation conventions (detected above). If tests use jest.restoreAllMocks() in afterEach, new tests MUST do the same — do not introduce a different cleanup strategy.
`;
};

/**
 * @param hasNodeTestInfra - whether the project has Node.js test infrastructure
 * @returns shell-safety guidance block for verification commands
 */
const buildPlanShellSafetyBlock = (hasNodeTestInfra: boolean): string => {
  if (!hasNodeTestInfra) return '';
  return `   - Verification commands MUST be shell-safe by construction. For inline \`node -e\`, prefer
     single-quoted JS strings or properly escaped backticks — never rely on unescaped
     template literals inside double-quoted shell strings.
`;
};

/**
 * @param params - plan generation parameters
 * @returns the fully assembled plan prompt string
 */
/**
 * @param feedback - plan quality feedback array
 * @returns formatted retry feedback block or empty string
 */
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
    testConventionsBlock: buildPlanTestConventionsBlock(params),
    shellSafetyBlock: buildPlanShellSafetyBlock(hasNodeTestInfra),
    skillNames: params.skillNames,
  });
};

// Step instructions for the plan prompt — extracted to stay under max-lines-per-function
const PLAN_STEP_INSTRUCTIONS = `   Every rename, move, or refactoring step MUST state both the current name/path AND the
   replacement name/path (e.g., "Rename class \`PaymentService\` to \`PaymentProcessorService\`
   in src/payments/payment.service.ts"). A step that says only "rename X" without the target
   is unusable by the implementer and will be rejected.
   When a step adds a new call site to an existing function or method, the plan MUST trace every existing call site for that function and note whether the shared code path already handles the new case. If it does, state so explicitly and skip the redundant change. If it does not, list which call sites need updating.
   When a step adds or modifies a JSDoc comment or docstring, the prose MUST be cross-checked against the implementation's guard clauses. If the function throws on null input, the docstring must document that. If the function silently returns undefined, the docstring must not claim it throws.
   When a step says "remove line X inside block Y", the plan MUST state whether the
   surrounding block (function, if-branch, class) becomes dead code after the removal
   and whether it should also be removed. Do not leave dead-code discovery to the
   implementer.
   When prescribing a new module-level helper near existing class methods, explicitly
   state its placement: "add as a module-level function outside the class, near the
   existing \`<CONSTANT_NAME>\` constant at line N". Do not leave placement ambiguous —
   the implementer should not have to guess whether it belongs inside or outside the
   class.
   When a step introduces an interface field typed with \`| null\` or \`.nullable()\`,
   the plan MUST trace every consumer of that interface and specify the concrete
   behaviour for the null case (skip, default value, throw). Do not leave null
   handling to the implementer to discover during review.
   When a plan involves operations where cache state affects network access (e.g.,
   reading a cached token before calling an API), the plan MUST explicitly state
   that the cache check happens before the network call and note the consequence of
   reversing the order. Cache-before-network ordering bugs are silent and hard to
   catch in review.
   Generated-doc workflows (e.g., auto-generated README sections, API docs from
   schemas) MUST be treated as source-of-truth updates. The plan should prescribe
   re-running the generator — not manually patching the output file. If no generator
   exists, the plan should say so and prescribe the manual edit as a stopgap with a
   TODO to add generation later.

   When a step specifies the return type of a function or method, the plan MUST derive
   it from the call-site options that will actually be passed — not the function's
   default return type. If the call site passes options that narrow or widen the return
   type (e.g., an overload, a generic parameter, or a conditional return), the plan
   must state the concrete type the caller will see and use that in downstream steps.

   When a plan prescribes adding specific text to a file (e.g., a prompt paragraph, a
   config key, a schema field), the plan MUST include a verification step that greps
   for a unique, distinctive substring of that text in the target file. If the substring
   is already present, the step should be marked as "already implemented" and skipped.
   Do NOT conclude that prescribed text is present based on thematic similarity to
   nearby content — perform an exact substring check.

   When a plan changes the semantics of a CLI option (e.g., making an option optional,
   changing its default, renaming it, or restricting its values), the plan MUST trace
   every user-facing surface that references that option — help text, command
   documentation, README examples, man pages — and include update steps for each.
   Restricting the affected-files list to only the implementation and its test misses
   help/doc text drift.

   When the implementation stage involves iterative fix-and-retry cycles, the plan
   MUST require verification of both working-tree and staged/index state before
   handoff (e.g., before commit). A file with both staged and unstaged changes can
   cause the commit to ship a stale version. The plan should prescribe an explicit
   clean-state check before the handoff step.

   When a plan includes a manual smoke test as an acceptance check, the implementation
   stage MUST either run it or explicitly mark it as incomplete with a reason. A plan
   that lists a smoke test but never executes it appears complete when one of its
   acceptance criteria was silently skipped.

   When a plan step prescribes a test, the plan MUST trace the execution path
   through the mock/DI setup to the first point where the command returns or
   fails downstream. State whether the test will reach a clean return or a
   downstream error, and prescribe the strongest viable positive assertion for
   that path. A test that only asserts "no throw" proves nothing if the mock
   setup silently short-circuits the code under test.

   When new code intentionally swallows or downgrades errors (e.g., "log a warning
   and continue" instead of throwing), the plan MUST include failure-path test
   coverage for that behaviour. Verify that the warning is emitted, the return value
   is correct on the failure path, and downstream code handles the degraded state.
   Silent error swallowing without coverage is a latent bug.`;

const PLAN_FILE_LISTING_INSTRUCTIONS = `3. Estimated complexity (low/medium/high)
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
8. New repositories that must be created (not yet existing locally) — a subset of affectedRepositories. Omit or leave empty when the plan only touches existing repos`;

const PLAN_VERIFICATION_INSTRUCTIONS = `9. Task-specific verification only when needed:
   - Use "verification.targeted" for focused checks required by this specific plan
   - Use "verification.waivers" only when this plan needs to explicitly waive a repo-level baseline check
   - Omit "verification" entirely when no targeted checks or waivers are needed
   - Verification commands run from the selected repository root
   - Every verification command must exit 0 when it succeeds
   - Commands must be copy-paste-runnable: reference ONLY scripts/binaries listed in the
     "Available test infrastructure" section. Do not invent scripts.
   - CRITICAL: verification commands are validated against the allowlist above. Any command
     that does not match an allowed form will be rejected. When unsure, use: node -e "..."`;

const PLAN_VERIFICATION_TAIL = `   - Each verification command MUST be relevant to this plan: it should verify a side effect
     or behavior introduced by the steps above, not just run the whole test suite.
   - Each verification command MUST target the specific behavior introduced by the step it validates
     — not unrelated output like global README string order or full-file snapshots.
     A verification that checks something the step did not change will produce false failures.
   - Verification commands that use CLI flags (e.g., jest --forceExit, tsc --noEmit) MUST
     cross-check flag names against the installed framework version. If the flag was added
     in a later version or renamed, the command will fail for reasons unrelated to the
     change. When uncertain, prefer the long-form flag name and note the minimum version.
   - For inline assertions, prefer: node -e "const assert = require('node:assert'); ..."
     (when node:test is available) or the installed test framework CLI
   - If you need to prove an expected failure, wrap it in a shell assertion that exits 0`;

const PLAN_MINIMAL_CHANGE_INSTRUCTIONS = `Minimal-change principles — apply to every plan:
- Propose the smallest effective change. Do not modify files unrelated to the ticket.
- Limit verification to files edited by this plan.
- Each component should be designed to address a single responsibility.
- Prefer changes that are replaceable or deletable without cascading effects on other components.`;

type PlanPromptBodyOpts = {
  action: string;
  affectedRepositories?: string[];
  discoveryBlock: string;
  issueContent: string;
  repoExample: string;
  retryFeedbackBlock: string;
  shellSafetyBlock: string;
  skillNames?: string[];
  testConventionsBlock: string;
  testInfraSection: string;
  ticketKey?: string;
};

/**
 * @param opts - pre-computed prompt fragments
 * @returns the plan prompt preamble (action, issue, context, feedback, discovery)
 */
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
${PLAN_STEP_INSTRUCTIONS}
${PLAN_FILE_LISTING_INSTRUCTIONS}`;

/**
 * @param opts - pre-computed prompt fragments
 * @returns the plan prompt JSON schema example block
 */
const buildPlanJsonSchemaExample = (opts: PlanPromptBodyOpts): string => `
Return ONLY a valid JSON object. Reference:
{"action":"${opts.action}","summary":"Extract shared auth guard into a reusable middleware.","steps":["Rename AuthGuard to SharedAuthGuard in ${opts.repoExample}/src/auth/guard.ts","Update all import paths in ${opts.repoExample}/src/controllers/"],"estimatedComplexity":"medium","affectedFiles":[{"filePath":"${opts.repoExample}/src/auth/guard.ts","status":"found"},{"filePath":"${opts.repoExample}/src/middleware/auth.middleware.ts","status":"to-create"}],"affectedFilesContext":[{"filePath":"${opts.repoExample}/package.json","status":"found"}],"affectedRepositories":["${opts.repoExample}"],"newRepositories":[],"risks":["Renaming may break downstream consumers"],"verification":{"targeted":[{"id":"manual-review","run":"yarn test:manual -- test-auth-guard","policy":"enforced","reason":"Verify guard behaviour after rename"}]}}

When an optional field has no value, omit it from the JSON entirely. Do not use null.

${JSON_OUTPUT_RULES}`;

const buildPlanSkillSection = (skillNames: string[] | undefined): string => {
  if (!skillNames?.length) return '';
  return '\n\nSkill-specific instructions:\nBefore starting work, invoke each of the following skills using the Skill tool:\n'
    + skillNames.map(s => `- Skill('${s}')`).join('\n')
    + '\nFollow each skill\'s instructions fully before proceeding.';
};

/**
 * @param opts - pre-computed prompt fragments
 * @returns the raw plan prompt body string
 */
const buildPlanPromptBody = (opts: PlanPromptBodyOpts): string => [
  buildPlanPromptPreamble(opts),
  opts.testInfraSection,
  opts.testConventionsBlock,
  PLAN_MINIMAL_CHANGE_INSTRUCTIONS,
  PLAN_VERIFICATION_INSTRUCTIONS,
  opts.shellSafetyBlock,
  PLAN_VERIFICATION_TAIL,
  buildPlanJsonSchemaExample(opts),
  buildPlanSkillSection(opts.skillNames),
].join('\n');

const REVIEW_INSTRUCTIONS = `Provide a code review with:
1. A brief summary of the changes
2. Any issues found
3. A trace provenance label: evidence-based, best-effort, or unavailable
4. A nested tree-like call stack that walks the changed code path
5. A frame-aligned state transition tree that captures variable changes between the frames in the call stack
6. A suggestion for each issue when remediation is clear — each suggestion must recommend the smallest effective fix (the minimum change that resolves the issue without introducing unnecessary scope). Write suggestions in plain, human-friendly language: be concise, use everyday phrasing, and avoid jargon-heavy or robotic sentences.
7. Optional trailing suggestions for general follow-up work that is not tied to a single issue — each must also prefer the smallest effective fix and use the same concise, human-friendly tone
8. Whether the code is approved`;

const REVIEW_JSON_SCHEMA = `Return ONLY a valid JSON object. Reference:
    {"summary":"Rename display label from X to Y across all user-facing text.","issues":[{"severity":"warning","message":"Missing JSDoc block on new private method.","file":"src/service.ts","line":42,"suggestion":"Add a minimal JSDoc block."},{"severity":"info","message":"Unused import spans multiple lines.","file":"src/utils.ts","line":10,"endLine":14},{"severity":"info","message":"Log message change loses diagnostic value."}],"traceProvenance":"evidence-based","callStack":[{"frame":"Service.method(params)","children":[{"frame":"Helper.transform(input)","children":[]}]}],"stateTransition":{"from":"entry-frame","to":"exit-frame","steps":[{"frame":"Service.method(params)","captured":{"dep":"Dep { ... }"},"changes":{"dep":{"before":"old","after":"new"}},"children":[]}]},"suggestions":["Extract predicate into a named helper for readability."],"approved":true}

    Prefer an absolute line number. Degrade to a line range (line + endLine) when the issue spans multiple lines. Omit line and endLine entirely when the issue cannot be pinned to specific lines.
    When an optional field has no value, omit it from the JSON entirely. Do not use null.

${JSON_OUTPUT_RULES}`;

/**
 * @param diff - unified diff string
 * @param guidelines - review guidelines list
 * @param skillNames - optional skill IDs to inject into the prompt
 * @returns the fully assembled review prompt string
 */
const buildStageReviewSkillSection = (skillNames: string[]): string =>
  '\nSkill-specific instructions:\nBefore starting review, invoke each of the following skills using the Skill tool:\n'
  + skillNames.map(s => `- Skill('${s}')`).join('\n')
  + '\nFollow each skill\'s instructions fully before proceeding.\n';

const buildStageReviewPrompt = (diff: string, guidelines: string[], skillNames?: string[]): string => [
  `\nCode Changes:\n\`\`\`\n${diff}\n\`\`\``,
  `\nReview Guidelines:\n${guidelines.map((g, i) => `${i + 1}. ${g}`).join('\n')}`,
  `\n${REVIEW_INSTRUCTIONS}`,
  ...(skillNames?.length ? [buildStageReviewSkillSection(skillNames)] : []),
  `\n${REVIEW_JSON_SCHEMA}`,
].join('\n');

/**
 * @param provider - AI provider name
 * @param model - model identifier
 * @returns model source label stripped of vendor prefix
 */
const derivePlanSource = (provider: string, model: string): string => {
  const prefixMap: Record<string, string> = {
    anthropic: 'claude-',
    deepseek: 'deepseek-',
    google: 'gemini-',
    openai: 'gpt-',
  };
  const prefix = prefixMap[provider] ?? '';
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
};

/**
 * @param toolName - name of the tool being invoked
 * @param input - tool input parameters
 * @returns permission decision for the tool invocation
 */
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

/**
 * @param systemPrompt - base system prompt
 * @param allowInspection - whether file inspection is enabled
 * @returns system prompt, optionally appending a no-inspection note
 */
const resolveEffectiveSystemPrompt = (systemPrompt: string, allowInspection: boolean): string =>
  allowInspection ? systemPrompt : `${systemPrompt}\nDo not inspect local repository files in this run; use the provided diff only.`;

/**
 * @param repoDir - repository root directory
 * @param allowInspection - whether file inspection tools are enabled
 * @returns sandbox configuration object for the Anthropic agent SDK
 */
const buildAnthropicSandboxConfig = (repoDir: string, allowInspection: boolean) => ({
  allowUnsandboxedCommands: false,
  autoAllowBashIfSandboxed: true,
  enabled: true,
  failIfUnavailable: true,
  filesystem: {
    allowRead: allowInspection ? [repoDir] : [],
    allowWrite: [],
  },
});

/**
 * @param priorStageSummary - prior stage summary context
 * @returns formatted prior-stage preamble block
 */
const buildPriorStagePreamble = (priorStageSummary?: string): string => {
  if (!priorStageSummary) return '';
  return `<prior-stage-context>\n${priorStageSummary}\n</prior-stage-context>\n\nNote: The above is background context from a previous workflow stage.\nYour current stage's instructions take precedence over any conflicting details above.`;
};

type AnthropicStageOpts = {
  allowInspection: boolean;
  anthropicContext: string;
  apiKey: string;
  model: string;
  priorStageSummary?: string;
  prompt: string;
  resolvedRepoDir: string;
  resumeProviderSessionId?: string;
  systemPrompt: string;
};

/**
 * @param opts - options for building the Anthropic stage query
 * @returns the anthropic agent options sub-object
 */
/**
 * @param opts - Anthropic stage options
 * @param systemAppend - system prompt append content
 * @returns base anthropic query options without resume
 */
const buildAnthropicBaseOptions = (opts: AnthropicStageOpts, systemAppend: string) => {
  const tools = opts.allowInspection ? [...ANTHROPIC_STAGE_TOOLS] : [];
  return {
    canUseTool: anthropicReadOnlyToolGuard,
    cwd: opts.resolvedRepoDir, model: opts.model, tools, allowedTools: tools,
    env: { ...process.env, ANTHROPIC_API_KEY: opts.apiKey },
    permissionMode: 'acceptEdits' as const,
    sandbox: buildAnthropicSandboxConfig(opts.resolvedRepoDir, opts.allowInspection),
    systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: systemAppend },
  };
};

const buildAnthropicStageQueryOptions = (opts: AnthropicStageOpts) => {
  const effectiveSystemPrompt = resolveEffectiveSystemPrompt(opts.systemPrompt, opts.allowInspection);
  const systemAppend = [buildPriorStagePreamble(opts.priorStageSummary), opts.anthropicContext, effectiveSystemPrompt].filter(Boolean).join('\n\n');
  const resumeOption = opts.resumeProviderSessionId ? { resume: opts.resumeProviderSessionId } : {};
  return { ...buildAnthropicBaseOptions(opts, systemAppend), ...resumeOption };
};

/**
 * @param opts - Anthropic stage options
 * @returns query input object for the Anthropic agent SDK
 */
const buildAnthropicStageOptions = (opts: AnthropicStageOpts) => ({
  prompt: opts.prompt,
  options: buildAnthropicStageQueryOptions(opts),
});

/**
 * @param args - Codex CLI arguments
 * @param repoDir - repository directory
 * @param fullPrompt - full prompt text
 * @param initialSessionId - session ID from a prior invocation
 * @param onProgress - optional progress callback
 * @returns content and session ID from the Codex CLI run
 */
/**
 * @param result - extracted result text
 * @param sessionId - session ID from the codex run
 * @returns content and session ID
 * @throws when no result was produced
 */
const finalizeCodexResult = (result: string, sessionId?: string): { content: string; sessionId?: string } => {
  if (!result) {
    console.log(chalk.yellow(`  [${CODEX_STAGE_LABEL}] No result message received from Codex CLI`));
    if (sessionId) console.log(chalk.yellow(`  [${CODEX_STAGE_LABEL}] Provider session: ${sessionId}`));
    throw new AIError('Codex CLI finished without returning a result.', null, true, 'stall');
  }
  if (sessionId) console.log(chalk.gray(`  [${CODEX_STAGE_LABEL}] Provider session: ${sessionId}`));
  return { content: result.trim(), sessionId };
};

type CodexStageResultState = {
  agentMessageCount: number;
  result: string;
  sessionId?: string;
  stopReason?: string;
};

const extractCodexStopReason = (message: CodexCliMessage): string | undefined => {
  const stopReason = message['stop_reason'];
  return typeof stopReason === 'string' ? stopReason : undefined;
};

const updateCodexAgentMessageState = (state: CodexStageResultState, message: CodexCliMessage): void => {
  if (message.type !== 'item.completed') return;
  if (message.item?.type !== 'agent_message' || !message.item.text) return;
  state.agentMessageCount++;
  state.result = message.item.text;
};

const accumulateCodexStageResult = (
  state: CodexStageResultState,
  message: CodexCliMessage,
  onProgress?: StageProgressCallback
): void => {
  if (message.type === 'thread.started' && message.thread_id) state.sessionId = message.thread_id;
  const stopReason = extractCodexStopReason(message);
  if (stopReason) state.stopReason = stopReason;
  if (onProgress) {
    const line = formatCodexProgressMessage(message);
    if (line) onProgress(line);
  }
  updateCodexAgentMessageState(state, message);
};

const throwCodexTruncationError = (stage: AgentStageName, stopReason: string): never => {
  throw new AIError(
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

const processCodexStageResult = async (
  args: string[],
  repoDir: string,
  fullPrompt: string,
  stage: AgentStageName,
  initialSessionId?: string,
  onProgress?: StageProgressCallback
): Promise<{ content: string; sessionId?: string }> => {
  const state: CodexStageResultState = { sessionId: initialSessionId, result: '', agentMessageCount: 0 };
  for await (const message of spawnCodex(args, repoDir, fullPrompt)) {
    accumulateCodexStageResult(state, message, onProgress);
  }
  return finalizeCodexStageResult(state, stage);
};

/**
 * @param message - a CLI result message
 * @returns extracted result content and source type
 */
const extractCliResultContent = (
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
  diagnostics: string[];
  lastAssistantText: string;
  result: string;
  sessionId: string | undefined;
  source: CliPassResult['source'];
  stopReason: string | undefined;
};

/**
 * @param acc - mutable accumulator for CLI pass state
 * @param message - a CLI NDJSON message
 */
const applyCliResultToAcc = (acc: CliPassAccumulator, message: ClaudeCliMessage): void => {
  const extracted = extractCliResultContent(message);
  if (!extracted) return;
  acc.result = extracted.result;
  acc.source = extracted.source;
  acc.stopReason = message.stop_reason as string | undefined;
};

/**
 * @param acc - mutable accumulator for CLI pass state
 * @param message - a CLI NDJSON message
 * @param onProgress - optional progress callback
 */
const accumulateCliMessage = (
  acc: CliPassAccumulator, message: ClaudeCliMessage, onProgress?: StageProgressCallback
): void => {
  if (message.session_id) acc.sessionId = message.session_id;
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

/**
 * @param acc - finalized CLI pass accumulator
 * @returns CLI pass result derived from the accumulator
 */
const finalizeCliPass = (acc: CliPassAccumulator): CliPassResult => {
  const result = acc.result || (acc.lastAssistantText.trim() ? acc.lastAssistantText : '');
  const fallbackSource = acc.lastAssistantText.trim() ? 'assistant_text' as const : acc.source;
  const source = acc.result ? acc.source : fallbackSource;
  const hadContent = acc.lastAssistantText.trim().length > 0;
  return {
    result, source, stopReason: acc.stopReason,
    sessionId: acc.sessionId, hadContent, diagnostics: acc.diagnostics,
  };
};

/**
 * @param args - CLI arguments
 * @param repoDir - repository directory
 * @param prompt - prompt text
 * @param wallClockTimeoutMs - wall-clock timeout in milliseconds
 * @param inactivityTimeoutMs - optional inactivity timeout in milliseconds; falls back to CLI_INACTIVITY_TIMEOUT_MS
 * @param onProgress - optional progress callback
 * @returns aggregated result from a single CLI pass
 */
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

type CliRetryState = { sessionId?: string; stalledPasses: number; passNumber: number; lastDiagnostics: string[] };

/**
 * @param state - mutable retry loop state
 * @param passResult - result from the latest CLI pass
 */
const advanceCliRetryState = (state: CliRetryState, passResult: CliPassResult): void => {
  const madeProgress = passResult.hadContent && passResult.source !== 'assistant_text';
  state.stalledPasses = madeProgress ? 0 : state.stalledPasses + 1;
  checkCliStallCondition(state.stalledPasses, state.passNumber, state.lastDiagnostics);
  state.lastDiagnostics = passResult.diagnostics;
  const sourceHint = passResult.source === 'assistant_text' ? ' (assistant_text demoted)' : '';
  console.log(chalk.yellow(`\n  [${CLI_STAGE_LABEL}] Pass ${state.passNumber}: no usable result${sourceHint} — resuming session`));
};

/**
 * @param stalledPasses - number of consecutive stalled passes
 * @param passNumber - current pass number
 * @param lastDiagnostics - diagnostics from the most recent pass
 * @throws when stall threshold is reached
 */
const checkCliStallCondition = (stalledPasses: number, passNumber: number, lastDiagnostics: string[]): void => {
  if (stalledPasses < CLI_STALL_THRESHOLD) return;
  const detail = lastDiagnostics.length ? ` Diagnostics:\n${lastDiagnostics.join('\n')}` : '';
  throw new AIError(
    `Claude CLI finished without returning a result after ${passNumber} pass(es) — workload not decreasing.${detail}`,
    null, true, 'stall'
  );
};

type AnthropicChatOpts = {
  allowInspection: boolean;
  anthropicContext: string;
  apiKey: string;
  model: string;
  prompt: string;
  resolvedRepoDir: string;
  resumeSessionId?: string;
  systemPrompt: string;
};

/**
 * @param opts - Anthropic chat options
 * @returns the anthropic agent options sub-object for chat turns
 */
const buildAnthropicChatQueryOptions = (opts: AnthropicChatOpts) => {
  const effectiveSystemPrompt = resolveEffectiveSystemPrompt(opts.systemPrompt, opts.allowInspection);
  const systemAppend = [opts.anthropicContext, effectiveSystemPrompt].filter(Boolean).join('\n\n');
  const resumeOption = opts.resumeSessionId ? { resume: opts.resumeSessionId } : {};
  return { ...buildAnthropicBaseOptions(opts, systemAppend), ...resumeOption };
};

/**
 * @param opts - options for building the Anthropic chat query
 * @returns query input object for the Anthropic agent SDK chat turn
 */
const buildAnthropicChatOptions = (opts: AnthropicChatOpts) => ({
  prompt: opts.prompt,
  options: buildAnthropicChatQueryOptions(opts),
});

/**
 * @param systemPrompt - base system prompt
 * @param priorStageSummary - optional prior stage summary
 * @param allowInspection - whether file inspection is enabled
 * @returns combined OpenAI system prompt with preamble
 */
const buildOpenAiSystemPrompt = (
  systemPrompt: string, priorStageSummary?: string, allowInspection?: boolean
): string => {
  const preamble = buildPriorStagePreamble(priorStageSummary);
  const preambleWithNewline = preamble ? `${preamble}\n\n` : '';
  return `${preambleWithNewline}${resolveEffectiveSystemPrompt(systemPrompt, Boolean(allowInspection))}`;
};

/** @returns OpenAI read_file tool */
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

/** @returns OpenAI list_files tool */
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

/** @returns OpenAI search_files tool */
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

/** @returns OpenAI run_readonly_command tool */
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

/**
 * @returns array of OpenAI agent tools for read-only repository inspection
 */
const buildOpenAiStageTools = () => [
  createOpenAiReadFileTool(), createOpenAiListFilesTool(), createOpenAiSearchFilesTool(), createOpenAiRunCommandTool(),
];

/**
 * @param session - Anthropic SDK session to drain
 * @param handler - processes each message, returns content if done
 * @param sessionLogPrefix - prefix for session ID log line
 * @returns content and session ID from the first successful result
 */
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
  throw new Error('Claude Agent SDK finished without returning a result.');
};

const STALE_RESUME_PATTERNS = [
  /session[_ ]?id.*(?:not found|invalid|expired|does not exist)/i,
  /(?:invalid|unknown|expired|stale).*session/i,
  /resume.*(?:fail|invalid|not found)/i,
  /(?:conversation|thread).*(?:not found|invalid|expired)/i,
];

/**
 * @param error - The caught error value
 * @returns True when the error message matches known stale-resume signatures
 */
const isStaleResumeError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return STALE_RESUME_PATTERNS.some(pattern => pattern.test(message));
};

/**
 * @param message - Anthropic SDK stream message
 * @param onProgress - optional progress callback
 * @returns result text if this is a successful result message, undefined otherwise
 * @throws when the result indicates an error
 */
const extractAnthropicResultMessage = (
  message: Record<string, unknown>, onProgress?: StageProgressCallback
): string | undefined => {
  if ((message as { type: string }).type !== 'result') {
    const line = onProgress ? formatAnthropicProgressMessage(message as never) : null;
    if (line) onProgress?.(line);
    return undefined;
  }
  const result = message as { subtype: string; is_error?: boolean; errors?: string[]; result: string };
  if (result.subtype !== 'success' || result.is_error) {
    const errorSummary = result.errors?.length ? result.errors.join('; ') : 'unknown error';
    throw new Error(`Claude Agent SDK failed (${result.subtype}): ${errorSummary}`);
  }
  return result.result;
};

@Injectable()
export class StageAgentService {
  constructor(private readonly configService: ConfigService) {}

  isEnabledForStage(stage: AgentStageName): boolean {
    const backend = this.resolveStageBackend(stage);
    return backend === 'agent' || backend === 'cli';
  }

  async generatePlan(params: GeneratePlanParams & {
    onProgress?: StageProgressCallback;
    priorStageSummary?: string;
    resumeProviderSessionId?: string;
  }): Promise<{ plan: ResolutionPlan; sessionId?: string }> {
    const { content: response, sessionId } = await this.runStagePrompt({
      stage: 'plan', prompt: buildStagePlanPrompt(params), systemPrompt: PLAN_SYSTEM_PROMPT,
      repoDir: process.cwd(), onProgress: params.onProgress,
      priorStageSummary: params.priorStageSummary, resumeProviderSessionId: params.resumeProviderSessionId,
    });
    return this.parseStagePlanResponse(response, sessionId);
  }

  /**
   * @param response - raw AI response content
   * @param sessionId - provider session identifier
   * @returns parsed and enriched resolution plan with session metadata
   */
  private parseStagePlanResponse(response: string, sessionId?: string): { plan: ResolutionPlan; sessionId?: string } {
    try {
      const plan = this.parseAndValidatePlan(response);
      return { plan, sessionId };
    } catch (error) {
      if (isAIErrorLike(error)) throw error;
      throw new AIError('Failed to parse resolution plan from agent response', { response, error, sessionId }, true, 'parse');
    }
  }

  /**
   * @param response - raw AI response content
   * @returns parsed, normalized, and enriched resolution plan
   */
  private parseAndValidatePlan(response: string): ResolutionPlan {
    return this.applyPlanMetadata(this.parsePlanContent(response));
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

  private applyPlanMetadata(plan: ResolutionPlan): ResolutionPlan {
    const provider = this.resolveStageProvider('plan');
    plan.provider = provider;
    plan.source = derivePlanSource(provider, this.resolveStageModel('plan'));
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

  async reviewCode(
    diff: string,
    guidelines: string[],
    repoDir?: string,
    priorStageSummary?: string,
    resumeProviderSessionId?: string,
    onProgress?: StageProgressCallback,
    skillNames?: string[]
  ): Promise<{ review: CodeReview; sessionId?: string }> {
    const { content: response, sessionId } = await this.runStagePrompt({
      stage: 'review', prompt: buildStageReviewPrompt(diff, guidelines, skillNames), systemPrompt: REVIEW_SYSTEM_PROMPT,
      repoDir, priorStageSummary, resumeProviderSessionId, onProgress,
    });
    return this.parseStageReviewResponse(response, sessionId, repoDir, REVIEW_SYSTEM_PROMPT, priorStageSummary);
  }

  /**
   * @param response - raw AI response content
   * @param sessionId - provider session identifier
   * @param repoDir - repository directory path
   * @param systemPrompt - system prompt used for the review
   * @param priorStageSummary - prior stage summary context
   * @returns parsed code review with session metadata
   */
  private async parseStageReviewResponse(
    response: string, sessionId: string | undefined, repoDir: string | undefined,
    systemPrompt: string, priorStageSummary: string | undefined
  ): Promise<{ review: CodeReview; sessionId?: string }> {
    try {
      const review = this.parseAndProcessReview(response);
      const backend = this.resolveStageBackend('review');
      await this.trySendReviewEpilogue(backend, sessionId, repoDir, systemPrompt, priorStageSummary);
      return { review: { ...review, executionMode: backend === 'cli' ? 'cli' : 'agent' }, sessionId };
    } catch (error) {
      if (isAIErrorLike(error)) throw error;
      throw new AIError('Failed to parse code review from agent response', { response, error }, true, 'parse');
    }
  }

  /**
   * @param response - raw AI response content
   * @returns parsed and post-processed code review
   * @throws AIError when the response JSON is missing required fields (summary, issues, suggestions, approved)
   */
  private parseAndProcessReview(response: string): CodeReview {
    const parsed = codeReviewSchema.parse(
      parseJsonResponse<CodeReview>(
        requireReviewResponseContent({ content: response, provider: this.resolveStageProvider('review'), model: this.resolveStageModel('review') })
      )
    );
    return postProcessCodeReview(sanitizeCodeReviewTrace(parsed, response), response).review;
  }

  /**
   * @param backend - resolved backend mode for the review stage
   * @param sessionId - provider session identifier
   * @param repoDir - repository directory path
   * @param systemPrompt - system prompt used for the review
   * @param priorStageSummary - prior stage summary context
   * @returns nothing; failures are logged and swallowed
   */
  private async trySendReviewEpilogue(
    backend: WfBackendMode, sessionId: string | undefined, repoDir: string | undefined,
    systemPrompt: string, priorStageSummary: string | undefined
  ): Promise<void> {
    if (backend !== 'cli' || !sessionId) return;
    const label = this.resolveStageProvider('review') === 'openai' ? CODEX_STAGE_LABEL : CLI_STAGE_LABEL;
    try {
      await this.sendCliReviewEpilogue({
        sessionId, repoDir: repoDir ?? process.cwd(), systemPrompt, priorStageSummary,
      });
      console.log(chalk.gray(`  [${label}] Review epilogue sent`));
    } catch {
      console.log(chalk.yellow(`  [${label}] Review epilogue failed — manual resume may show raw JSON`));
    }
  }

  async generateFromPrompt(prompt: string, onProgress?: StageProgressCallback): Promise<string> {
    const { content: response } = await this.runStagePrompt({
      stage: 'generate',
      prompt,
      systemPrompt: GENERATE_SYSTEM_PROMPT,
      onProgress,
    });
    return requireAiResponseContent(
      { content: response, provider: this.resolveStageProvider('generate'), model: this.resolveStageModel('generate') },
      'AI provider returned an empty generated content response'
    );
  }

  private resolveStageBackend(stage: AgentStageName): WfBackendMode {
    return this.configService.get<WfBackendMode>(`stages.${stage}.backend`, resolveDefaultStageBackend(stage));
  }

  private resolveStageProvider(stage: AgentStageName): 'anthropic' | 'openai' {
    const provider
      = this.configService.get<string>(`stages.${stage}.provider`)
        ?? this.configService.get<string>('ai.provider', 'anthropic');
    if (provider !== 'anthropic' && provider !== 'openai') {
      throw new Error(
        `${stage} stage agent backend is unsupported for provider "${provider}". Configure ${stage}.provider as anthropic or openai, or set stages.${stage}.backend to "standard".`
      );
    }
    return provider;
  }

  private resolveStageModel(stage: AgentStageName): string {
    const stageModel = this.configService.get<string>(`stages.${stage}.model`);
    if (stageModel) return stageModel;
    const provider = this.resolveStageProvider(stage);
    const fallback = provider === 'openai' ? READ_ONLY_OPENAI_MODEL : READ_ONLY_ANTHROPIC_MODEL;
    return resolveProviderModel(this.configService, provider, fallback);
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

  private async runStagePrompt(params: StagePromptParams): Promise<{ content: string; sessionId?: string }> {
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
    const provider = this.resolveStageProvider(params.stage);
    if (provider === 'anthropic') return this.runAnthropicStagePrompt(params);
    const content = await this.runOpenAiStagePrompt(params);
    return { content };
  }

  /**
   * @param params - stage prompt parameters
   * @returns CLI stage result from the appropriate CLI backend
   */
  private dispatchCliStagePrompt(params: StagePromptParams): Promise<{ content: string; sessionId?: string }> {
    const provider = this.resolveStageProvider(params.stage);
    return provider === 'openai' ? this.runCodexCliStagePrompt(params) : this.runCliStagePrompt(params);
  }

  private async runAnthropicStagePrompt(params: StagePromptParams): Promise<{ content: string; sessionId?: string }> {
    const apiKey = this.requireAnthropicApiKey();
    const anthropicContext = await loadAiContextConfig(path.join(os.homedir(), '.claude', 'CLAUDE.md'), 'CLAUDE.md', 'anthropic', true);
    const options = buildAnthropicStageOptions({
      prompt: params.prompt, model: this.resolveStageModel(params.stage), apiKey,
      resolvedRepoDir: params.repoDir ?? process.cwd(), allowInspection: Boolean(params.repoDir),
      systemPrompt: params.systemPrompt, priorStageSummary: params.priorStageSummary,
      anthropicContext, resumeProviderSessionId: params.resumeProviderSessionId,
    });
    const { query } = await loadAnthropicAgentSdk();
    return this.processAnthropicStageResult(query(options), params.onProgress);
  }

  /**
   * @returns the Anthropic API key from config
   * @throws when the key is not configured
   */
  private requireAnthropicApiKey(): string {
    const apiKey = this.configService.get<string>('ai.anthropicApiKey');
    if (!apiKey) throw new Error('Anthropic agent backend requires `ai.anthropicApiKey` to be configured.');
    return apiKey;
  }

  /**
   * @param session - an active Anthropic agent SDK query session
   * @param onProgress - optional progress callback
   * @returns content and session ID from the first successful result message
   */
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
    if (params.resumeProviderSessionId) {
      console.log(chalk.yellow('  [openai-agent] Session resumption is not yet supported for the OpenAI agent backend. Starting fresh.'));
    }
    const { agent, runner, context } = await this.buildOpenAiStageAgent({
      stage: params.stage, systemPrompt: params.systemPrompt,
      repoDir: params.repoDir, priorStageSummary: params.priorStageSummary, apiKey,
    });
    return this.processOpenAiStageResult(agent, runner, context, params.prompt, 16, params.onProgress);
  }

  /**
   * @returns the OpenAI API key from config
   * @throws when the key is not configured
   */
  private requireOpenAiApiKey(): string {
    const apiKey = this.configService.get<string>('ai.openaiApiKey');
    if (!apiKey) throw new Error('OpenAI agent backend requires `ai.openaiApiKey` to be configured.');
    return apiKey;
  }

  /**
   * @param opts - agent configuration parameters
   * @returns built agent, runner, and context for OpenAI stage operations
   */
  private async buildOpenAiStageAgent(opts: {
    stage: AgentStageName; systemPrompt: string; repoDir?: string; priorStageSummary?: string; apiKey: string;
  }): Promise<{ agent: Agent<OpenAiStageContext>; runner: Runner; context: OpenAiStageContext }> {
    const openAiContext = await loadAiContextConfig(path.join(os.homedir(), '.openai', 'AGENTS.md'), 'AGENTS.md', 'openai', true);
    const allowInspection = Boolean(opts.repoDir);
    const instructions = [openAiContext, buildOpenAiSystemPrompt(opts.systemPrompt, opts.priorStageSummary, allowInspection)].filter(Boolean).join('\n\n');
    const agent = new Agent<OpenAiStageContext>({
      name: `wf ${opts.stage} openai agent backend`,
      handoffDescription: 'Uses read-only tools to inspect the repository and answer the current stage prompt.',
      instructions, model: this.resolveStageModel(opts.stage),
      tools: allowInspection ? buildOpenAiStageTools() : [], toolUseBehavior: 'run_llm_again', resetToolChoice: true,
    });
    const runner = new Runner({ modelProvider: new OpenAIProvider({ apiKey: opts.apiKey }) });
    return { agent, runner, context: { repoDir: opts.repoDir ?? process.cwd() } };
  }

  /**
   * @param agent - OpenAI agent instance
   * @param runner - OpenAI runner instance
   * @param context - stage context with repo directory
   * @param input - prompt or run state input
   * @param maxTurns - maximum number of agent turns
   * @param onProgress - optional progress callback
   * @returns trimmed final output string
   */
  private async processOpenAiStageResult(
    agent: Agent<OpenAiStageContext>, runner: Runner, context: OpenAiStageContext,
    input: string, maxTurns: number, onProgress?: StageProgressCallback
  ): Promise<string> {
    const streamedRun = await runner.run(agent, input, { stream: true, context, maxTurns });
    for await (const event of streamedRun) {
      if (onProgress) {
        const formatted = formatOpenAiProgressMessage(event);
        if (formatted) onProgress(formatted.message);
      }
    }
    if (streamedRun.error) throw new Error(`OpenAI agent run failed: ${this.extractStreamError(streamedRun.error)}`);
    return typeof streamedRun.finalOutput === 'string' ? streamedRun.finalOutput.trim() : '';
  }

  async chatTurn(params: ChatTurnParams): Promise<{ content: string; session: AgentChatSession }> {
    const backend = this.resolveStageBackend(params.stage);
    if (backend === 'cli') return this.cliChatTurn(params);
    const provider = this.resolveStageProvider(params.stage);
    if (provider === 'anthropic') return this.anthropicChatTurn(params);
    return this.validateAndReturnOpenAiChat(params);
  }

  /**
   * @param params - chat turn parameters
   * @returns validated OpenAI chat result
   */
  private async validateAndReturnOpenAiChat(
    params: ChatTurnParams
  ): Promise<{ content: string; session: AgentChatSession }> {
    const result = await this.openAiChatTurn(params);
    requireAiResponseContent(
      { content: result.content, provider: 'openai', model: this.resolveStageModel(params.stage) },
      'AI provider returned an empty chat response'
    );
    return result;
  }

  private async anthropicChatTurn(params: ChatTurnParams): Promise<{ content: string; session: AgentChatSession }> {
    const apiKey = this.requireAnthropicApiKey();
    const anthropicContext = await loadAiContextConfig(path.join(os.homedir(), '.claude', 'CLAUDE.md'), 'CLAUDE.md', 'anthropic', true);
    const options = buildAnthropicChatOptions({
      prompt: params.userMessage, model: this.resolveStageModel(params.stage), apiKey,
      resolvedRepoDir: params.repoDir ?? process.cwd(), allowInspection: Boolean(params.repoDir),
      systemPrompt: params.systemPrompt, anthropicContext, resumeSessionId: params.session?.sessionId,
    });
    const { query } = await loadAnthropicAgentSdk();
    return this.processAnthropicChatResult(query(options), params.session?.sessionId);
  }

  /**
   * @param session - active Anthropic agent SDK session
   * @param existingSessionId - session ID from a prior turn
   * @returns chat content and updated session metadata
   */
  private async processAnthropicChatResult(
    session: AsyncIterable<Record<string, unknown>> & { close: () => void }, existingSessionId?: string
  ): Promise<{ content: string; session: AgentChatSession }> {
    const result = await drainAnthropicSession(session, msg => {
      const outcome = extractAnthropicResultMessage(msg);
      return outcome ? { content: outcome.trim() } : undefined;
    }, '');
    const sessionId = result.sessionId ?? existingSessionId;
    return { content: result.content, session: { provider: 'anthropic' as const, sessionId } };
  }

  private async openAiChatTurn(params: ChatTurnParams): Promise<{ content: string; session: AgentChatSession }> {
    const apiKey = this.requireOpenAiApiKey();
    setTracingExportApiKey(apiKey);
    const { agent, runner, context } = await this.resolveOpenAiChatAgent(params, apiKey);
    const runInput = (params.session?.runState ?? params.userMessage) as string;
    const content = await this.processOpenAiStageResult(agent, runner, context, runInput, 8);
    return this.buildOpenAiChatResult(content, agent, runner);
  }

  /**
   * @param params - chat turn parameters
   * @param apiKey - OpenAI API key
   * @returns reused or freshly built agent, runner, and context
   */
  private async resolveOpenAiChatAgent(
    params: Pick<ChatTurnParams, 'stage' | 'systemPrompt' | 'repoDir' | 'session'>, apiKey: string
  ): Promise<{ agent: Agent<OpenAiStageContext>; runner: Runner; context: OpenAiStageContext }> {
    const reusableAgent = params.session?.agent as Agent<OpenAiStageContext> | undefined;
    const reusableRunner = params.session?.runner as Runner | undefined;
    if (reusableAgent && reusableRunner) {
      return { agent: reusableAgent, runner: reusableRunner, context: { repoDir: params.repoDir ?? process.cwd() } };
    }
    return this.buildOpenAiStageAgent({
      stage: params.stage, systemPrompt: params.systemPrompt, repoDir: params.repoDir, apiKey,
    });
  }

  /**
   * @param content - final output content from the agent
   * @param agent - OpenAI agent instance to preserve for session reuse
   * @param runner - OpenAI runner instance to preserve for session reuse
   * @returns chat result with session metadata
   */
  private buildOpenAiChatResult(
    content: string,
    agent: Agent<OpenAiStageContext>,
    runner: Runner
  ): { content: string; session: AgentChatSession } {
    return { content, session: { provider: 'openai' as const, agent, runner } };
  }

  private async runCliStagePrompt(params: StagePromptParams): Promise<{ content: string; sessionId?: string }> {
    assertClaudeCliAvailable();
    const preamble = buildPriorStagePreamble(params.priorStageSummary);
    const systemPrompt = preamble ? `${preamble}\n\n${params.systemPrompt}` : params.systemPrompt;
    const passOpts: CliStagePassOpts = {
      stage: params.stage, prompt: params.prompt, systemPrompt,
      model: this.resolveStageModel(params.stage), resolvedRepoDir: params.repoDir ?? process.cwd(),
      allowInspection: Boolean(params.repoDir),
      jsonSchema: params.stage === 'plan' ? JSON.stringify(z.toJSONSchema(resolutionPlanSchema)) : undefined,
      resumeProviderSessionId: params.resumeProviderSessionId, onProgress: params.onProgress,
    };
    return this.runCliRetryLoop(passOpts, params.stage, params.resumeProviderSessionId);
  }

  /**
   * @param stage - stage name for error context
   * @param initialSessionId - session ID to start with
   * @param runPass - function that executes a single CLI pass
   * @returns content and session ID from the first successful pass
   */
  private async runGenericCliRetryLoop(
    stage: AgentStageName, initialSessionId: string | undefined,
    runPass: (sessionId: string | undefined, passNumber: number) => Promise<CliPassResult>
  ): Promise<{ content: string; sessionId?: string }> {
    const state = { sessionId: initialSessionId, stalledPasses: 0, passNumber: 0, lastDiagnostics: [] as string[] };
    while (true) {
      state.passNumber++;
      const passResult = await runPass(state.sessionId, state.passNumber);
      if (passResult.sessionId) state.sessionId = passResult.sessionId;
      const completed = this.tryFinalizeCliPass(passResult, stage, state.passNumber, state.sessionId);
      if (completed) return completed;
      advanceCliRetryState(state, passResult);
      this.handleReviewFreshStart(state, stage);
    }
  }

  private async runCliRetryLoop(
    passOpts: CliStagePassOpts, stage: AgentStageName, initialSessionId?: string
  ): Promise<{ content: string; sessionId?: string }> {
    return this.runGenericCliRetryLoop(
      stage, initialSessionId,
      (sessionId, passNumber) => this.runCliStagePass({ ...passOpts, sessionId, passNumber })
    );
  }

  /**
   * @param passResult - result from a CLI pass
   * @param stage - stage name for error context
   * @param passNumber - current pass number
   * @param sessionId - current session ID
   * @returns finalized result if the pass produced a structured or result-typed answer;
   *   undefined if the result is absent or sourced from raw assistant text
   */
  private tryFinalizeCliPass(
    passResult: CliPassResult, stage: AgentStageName, passNumber: number, sessionId?: string
  ): { content: string; sessionId?: string } | undefined {
    if (!passResult.result || passResult.source === 'assistant_text') return undefined;
    this.checkCliMaxTokens(passResult.stopReason, stage);
    console.log(chalk.cyan(`  [${CLI_STAGE_LABEL}] Result extracted via ${passResult.source} (pass ${passNumber})`));
    if (sessionId) console.log(chalk.cyan(`  [${CLI_STAGE_LABEL}] Provider session: ${sessionId}`));
    return { content: passResult.result.trim(), sessionId };
  }

  /**
   * @param state - mutable retry-loop state; `sessionId` is cleared in place so the
   *   next pass opens a fresh CLI session with the original prompt instead of the
   *   JSON retry prompt (because `runCliStagePass` derives `isResume = false` when
   *   `sessionId` is undefined). The stall counter (`stalledPasses`) is deliberately
   *   preserved — this is a session reset, not a full retry budget reset.
   * @param stage - only the `'review'` stage triggers fresh-start behaviour
   */
  private handleReviewFreshStart(state: CliRetryState, stage: AgentStageName): void {
    if (stage === 'review') {
      state.sessionId = undefined;
      console.log(chalk.yellow(`  [${CLI_STAGE_LABEL}] Review retry starts fresh (no session resumption)`));
    }
  }

  /**
   * @param stopReason - CLI stop reason string
   * @param stage - stage name for error context
   * @throws when the response was truncated due to max tokens
   */
  private checkCliMaxTokens(stopReason: string | undefined, stage: AgentStageName): void {
    if (stopReason !== 'max_tokens') return;
    throw new AIError(
      `CLI response was truncated due to output token limit — the model ran out of space before `
      + `completing the response. Reduce prompt/context size or switch to provider-backed OpenAI if you need a larger output budget.`,
      { stopReason, stage }, true, 'truncation'
    );
  }

  /**
   * @param opts - CLI pass configuration
   * @returns extracted result, diagnostics, and metadata from a single CLI pass
   */
  private async runCliStagePass(opts: CliStagePassOpts & { passNumber: number }): Promise<CliPassResult> {
    const isResume = (opts.passNumber > 1 && opts.sessionId) || (opts.passNumber === 1 && opts.resumeProviderSessionId);
    const retryPrompt = opts.jsonSchema ? CLI_RETRY_PROMPT : CLI_CHAT_RETRY_PROMPT;
    const prompt = isResume && opts.passNumber > 1 ? retryPrompt : opts.prompt;
    const args = buildCliArgs({
      prompt, appendSystemPrompt: opts.systemPrompt, model: opts.model, cwd: opts.resolvedRepoDir,
      tools: opts.allowInspection ? ['Read', 'Glob', 'Grep', 'Bash', 'Skill'] : [],
      permissionMode: 'plan', sessionId: isResume ? opts.sessionId : undefined, jsonSchema: opts.jsonSchema,
    });
    const timeoutMs = this.resolveStageTimeoutMs(opts.stage);
    const inactivityTimeoutMs = this.resolveStageInactivityTimeoutMs(opts.stage);
    return processCliPassMessages(args, opts.resolvedRepoDir, prompt, timeoutMs, inactivityTimeoutMs, opts.onProgress);
  }

  private async runCodexCliStagePrompt(params: StagePromptParams): Promise<{ content: string; sessionId?: string }> {
    assertCodexCliAvailable();
    const model = this.resolveStageModel(params.stage);
    const resolvedRepoDir = params.repoDir ?? process.cwd();
    const preamble = buildPriorStagePreamble(params.priorStageSummary);
    const preambleWithNewline = preamble ? `${preamble}\n\n` : '';
    const fullPrompt = `${preambleWithNewline}${params.systemPrompt}\n\n${params.prompt}`;
    const args = buildCodexCliArgs({
      prompt: fullPrompt, model, cwd: resolvedRepoDir,
      sessionId: params.resumeProviderSessionId,
    });
    return processCodexStageResult(
      args, resolvedRepoDir, fullPrompt, params.stage, params.resumeProviderSessionId, params.onProgress
    );
  }

  /**
   * Send a best-effort follow-up turn that replaces the raw JSON session tail
   * with a short readable summary for manual CLI resume flows.
   *
   * @param params - Resumed review session context
   * @returns Nothing; failures are handled by the caller
   */
  private async sendCliReviewEpilogue(params: {
    sessionId: string;
    repoDir: string;
    systemPrompt: string;
    priorStageSummary?: string;
  }): Promise<void> {
    const model = this.resolveStageModel('review');
    const provider = this.resolveStageProvider('review');
    if (provider === 'openai') {
      return this.sendCodexEpilogue(params.sessionId, params.repoDir, model);
    }
    return this.sendClaudeEpilogue(
      params.sessionId, params.repoDir, model, params.systemPrompt, params.priorStageSummary
    );
  }

  /**
   * @param sessionId - Codex session identifier
   * @param repoDir - repository directory
   * @param model - model identifier
   * @returns nothing; drains the Codex epilogue stream
   */
  private async sendCodexEpilogue(sessionId: string, repoDir: string, model: string): Promise<void> {
    const args = buildCodexCliArgs({ prompt: CLI_EPILOGUE_PROMPT, sessionId, model, cwd: repoDir });
    const stream = spawnCodex(args, repoDir, CLI_EPILOGUE_PROMPT, undefined, CLI_REVIEW_EPILOGUE_TIMEOUT_MS);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of stream) { /* drain */ }
  }

  /**
   * @param sessionId - Claude CLI session identifier
   * @param repoDir - repository directory
   * @param model - model identifier
   * @param systemPrompt - system prompt for the review stage
   * @param priorStageSummary - optional prior stage context
   * @returns nothing; drains the Claude CLI epilogue stream
   */
  private async sendClaudeEpilogue(
    sessionId: string, repoDir: string, model: string, systemPrompt: string, priorStageSummary?: string
  ): Promise<void> {
    const preamble = buildPriorStagePreamble(priorStageSummary);
    const preambleWithNewline = preamble ? `${preamble}\n\n` : '';
    const allowInspection = Boolean(repoDir);
    const args = buildCliArgs({
      prompt: CLI_EPILOGUE_PROMPT, appendSystemPrompt: `${preambleWithNewline}${systemPrompt}`,
      model, sessionId, cwd: repoDir, permissionMode: 'plan',
      tools: allowInspection ? ['Read', 'Glob', 'Grep', 'Bash', 'Skill'] : [], jsonSchema: undefined,
    });
    const stream = spawnCli(args, repoDir, CLI_EPILOGUE_PROMPT, undefined, CLI_REVIEW_EPILOGUE_TIMEOUT_MS);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of stream) { /* drain */ }
  }

  private async cliChatTurn(params: ChatTurnParams): Promise<{ content: string; session: AgentChatSession }> {
    assertClaudeCliAvailable();
    const chatPassOpts: CliChatPassOpts = {
      stage: params.stage, userMessage: params.userMessage, systemPrompt: params.systemPrompt,
      model: this.resolveStageModel(params.stage), resolvedRepoDir: params.repoDir ?? process.cwd(),
      allowInspection: Boolean(params.repoDir), initialSessionId: params.session?.sessionId,
    };
    const result = await this.runCliChatRetryLoop(chatPassOpts, params.stage, params.session?.sessionId);
    return { content: result.content, session: { provider: 'anthropic' as const, backend: 'cli', sessionId: result.sessionId } };
  }

  /**
   * @param passOpts - immutable chat pass options reused across iterations
   * @param stage - stage name for error messages
   * @param initialSessionId - session ID to start with
   * @returns content and session ID from the first successful pass
   */
  private async runCliChatRetryLoop(
    passOpts: CliChatPassOpts, stage: AgentStageName, initialSessionId?: string
  ): Promise<{ content: string; sessionId?: string }> {
    return this.runGenericCliRetryLoop(
      stage, initialSessionId,
      (sessionId, passNumber) => this.runCliChatPass({ ...passOpts, sessionId, passNumber })
    );
  }

  /**
   * @param opts - CLI chat pass configuration
   * @returns result from a single CLI chat pass
   */
  private async runCliChatPass(
    opts: CliChatPassOpts & { sessionId?: string; passNumber: number }
  ): Promise<CliPassResult> {
    const isResume = opts.passNumber > 1 && opts.sessionId;
    const prompt = isResume ? CLI_CHAT_RETRY_PROMPT : opts.userMessage;
    const args = buildCliArgs({
      prompt, appendSystemPrompt: opts.systemPrompt, model: opts.model, cwd: opts.resolvedRepoDir,
      sessionId: isResume ? opts.sessionId : opts.initialSessionId,
      tools: opts.allowInspection ? ['Read', 'Glob', 'Grep', 'Bash', 'Skill'] : [], permissionMode: 'plan',
    });
    return processCliPassMessages(args, opts.resolvedRepoDir, prompt,
      this.resolveStageTimeoutMs(opts.stage), this.resolveStageInactivityTimeoutMs(opts.stage));
  }
}
