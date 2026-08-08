import { ConfigService } from '@nestjs/config';
import chalk from 'chalk';
import { exec } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { ResolutionPlan } from '../ai.service';
import type { planPhaseSchema } from '../../../shared/schemas/ai.schema';
import type { z } from 'zod';

export type PlanPhase = z.infer<typeof planPhaseSchema>;
import type { VerificationScript, ModelRouting } from '../../../agents/interfaces';
import type { BuildTaskBriefParams, BuildPlanContextParams } from '../../../shared/types/agent.types';
export type { BuildTaskBriefParams, BuildPlanContextParams };

const execAsync = promisify(exec);

const MECHANICAL_KEYWORD_PATTERNS = [
  /migrate all/i,
  /replace every/i,
  /update each/i,
  /same pattern across/i,
  /rename all/i,
  /add .+ to every/i,
  /\bfind.and.replace\b/i,
  /\bsearch.and.replace\b/i,
  /\b(bulk|batch|mass)\s+(update|change|edit|modify|rename|delete)/i,
  /\bremove\b.+\bfrom (all|every|each)\b/i,
  /\bdelete\b.+\b(across|everywhere)\b/i,
  /\bapply\b.+\b(across|everywhere|to (all|every|each))\b/i,
];

const MECHANICAL_SEMANTIC_PATTERNS = [
  /\brepeat\b.+\b(across|for each|in every)\b|replicate.+across/i,
  /boilerplate|scaffold/i,
  /same change|uniform/i,
  /for each file|for each module/i,
  /change in all/i,
  /standardize|normalize/i,
  /same way|same approach/i,
];

const CREATIVE_SEMANTIC_PATTERNS = [
  /design|architect/i,
  /analyze|investigate/i,
  /implement new|implement novel/i,
  /algorithm|heuristic/i,
  /research|explore/i,
  /refactor|restructure/i,
];

/**
 * Counts how many steps match at least one pattern in the given list.
 *
 * @param steps - Plan steps to test
 * @param patterns - Regular expressions to test against each step
 * @returns Number of steps that matched at least one pattern
 */
const countPatternMatches = (steps: string[], patterns: RegExp[]): number =>
  steps.filter(step => patterns.some(pattern => pattern.test(step))).length;

/**
 * Counts semantic signal matches in plan steps.
 *
 * @param steps - Plan steps to analyze
 * @returns Object with mechanical and creative signal counts
 */
const countSemanticSignals = (steps: string[]): { mechanical: number; creative: number } => ({
  mechanical: countPatternMatches(steps, MECHANICAL_SEMANTIC_PATTERNS),
  creative: countPatternMatches(steps, CREATIVE_SEMANTIC_PATTERNS),
});

/**
 * Returns the first keyword pattern that matches any plan step, or null.
 *
 * @param steps - Plan steps to test
 * @returns The matched RegExp, or null when no keyword pattern matches
 */
const matchMechanicalKeyword = (steps: string[]): RegExp | null => {
  for (const step of steps) {
    const matched = MECHANICAL_KEYWORD_PATTERNS.find(pattern => pattern.test(step));
    if (matched) {
      return matched;
    }
  }
  return null;
};

/**
 * Detects whether a plan describes a mechanical (repetitive, pattern-based) task.
 *
 * @param plan - The resolution plan to evaluate
 * @returns True when the plan appears mechanical, with a human-readable reason
 */
export const detectMechanicalTask = (plan: ResolutionPlan): { isMechanical: boolean; reason: string } => {
  const filesCount = plan.affectedFiles?.length ?? 0;
  const stepsCount = plan.steps.length;
  if (plan.estimatedComplexity === 'low') return { isMechanical: true, reason: `low complexity task (${filesCount} files)` };
  if (plan.estimatedComplexity === 'high') return { isMechanical: false, reason: 'high complexity task' };
  const highRatio = stepsCount > 0 && filesCount > 3 && filesCount / stepsCount > 3;
  if (highRatio) return { isMechanical: true, reason: `high file-to-step ratio: ${filesCount} files / ${stepsCount} steps` };
  const matched = matchMechanicalKeyword(plan.steps);
  const firstStep = matched ? (plan.steps.find(step => matched.test(step)) ?? '') : '';
  if (matched) return { isMechanical: true, reason: `pattern: "${matched.source}" in step "${firstStep.slice(0, 60)}"` };
  const signals = countSemanticSignals(plan.steps);
  const dominantMechanical = signals.mechanical > 0 && signals.mechanical > signals.creative;
  if (dominantMechanical) return { isMechanical: true, reason: `semantic signals: ${signals.mechanical} mechanical vs ${signals.creative} creative` };
  return { isMechanical: false, reason: 'creative task' };
};

export type ModelRoutingResult = {
  model: string;
  defaultModel: string;
  logMessage: string;
};

/**
 * Resolves the default and mechanical model names from config, with fallbacks.
 *
 * @param configService - NestJS config service instance
 * @param fallbackDefaultModel - Fallback when no config default is set
 * @param defaultMechanicalModel - Fallback when no config mechanical model is set
 * @returns Resolved default and mechanical model names
 */
const MODEL_CONFIG_EXCLUSIVE_ERROR
  = 'stages.implement.model and stages.implement.models are mutually exclusive.\n'
    + '  Use stages.implement.model for a single model, or\n'
    + '  Use stages.implement.models for routing-aware model selection (default + mechanical).';

const resolveModelConfig = (
  configService: ConfigService,
  fallbackDefaultModel: string,
  defaultMechanicalModel: string
): { defaultModel: string; mechanicalModel: string } => {
  const singleModel = configService.get<string>('stages.implement.model');
  const modelsConfig
    = configService.get<import('../../../config/public-config').WfImplementStageModelsConfig>('stages.implement.models');
  if (singleModel && modelsConfig) throw new Error(MODEL_CONFIG_EXCLUSIVE_ERROR);
  return {
    defaultModel: modelsConfig?.default || singleModel || fallbackDefaultModel,
    mechanicalModel: modelsConfig?.mechanical || singleModel || defaultMechanicalModel,
  };
};

/**
 * Builds a ModelRoutingResult from a resolved model, default model, adapter label, and suffix.
 *
 * @param model - The selected model identifier
 * @param defaultModel - The resolved default model identifier
 * @param adapterLabel - Label used in log messages
 * @param suffix - Descriptive routing suffix appended to the log message
 * @returns Fully formed routing result with log message
 */
const buildRoutingResult = (
  model: string,
  defaultModel: string,
  adapterLabel: string,
  suffix: string
): ModelRoutingResult => ({
  model,
  defaultModel,
  logMessage: `[${adapterLabel}] Model routing: ${model} (${suffix})`,
});

export type ModelRoutingParams = {
  routing: ModelRouting;
  fallbackDefaultModel: string;
  defaultMechanicalModel: string;
  configService: ConfigService;
  plan: ResolutionPlan;
  adapterLabel: string;
};

/**
 * Resolves the model to use based on routing mode, config, and mechanical detection.
 *
 * @param params - Routing context including the adapter label for log messages
 * @returns Selected model and an observability log message
 */
export const resolveModelRouting = (params: ModelRoutingParams): ModelRoutingResult => {
  const { routing, fallbackDefaultModel, defaultMechanicalModel, configService, plan, adapterLabel } = params;
  const { defaultModel, mechanicalModel }
    = resolveModelConfig(configService, fallbackDefaultModel, defaultMechanicalModel);
  if (routing === 'default') return buildRoutingResult(defaultModel, defaultModel, adapterLabel, 'default — user override');
  if (routing === 'mechanical') return buildRoutingResult(mechanicalModel, defaultModel, adapterLabel, 'mechanical — user override');
  const detection = detectMechanicalTask(plan);
  const autoModel = detection.isMechanical ? mechanicalModel : defaultModel;
  const autoLabel = detection.isMechanical ? `auto — mechanical: ${detection.reason}` : `auto — creative: ${detection.reason}`;
  return buildRoutingResult(autoModel, defaultModel, adapterLabel, autoLabel);
};

/**
 * Resolves the model configured for a specific provider from the ai.providers array.
 * Falls back to the provided default when the provider is not found or has no model.
 *
 * @param configService - NestJS config service
 * @param providerName - Provider name to look up (e.g. 'anthropic', 'openai')
 * @param fallback - Default model when lookup fails
 * @returns The provider's configured model or the fallback
 */
export const resolveProviderModel = (
  configService: ConfigService, providerName: string, fallback: string,
): string => {
  const providers = configService.get<Array<{ provider: string; model?: string }>>('ai.providers') ?? [];
  return providers.find(p => p.provider === providerName)?.model ?? fallback;
};

/**
 * Normalizes a command value to a trimmed string.
 *
 * @param command - The raw command value
 * @returns Trimmed command string, or empty string for non-string input
 */
export const normalizeCommand = (command: unknown): string => (typeof command === 'string' ? command.trim() : '');

/**
 * Builds a set of allowed verification commands from the scripts config.
 *
 * @param verificationScripts - Verification script definitions
 * @returns Set of trimmed, non-empty command strings
 */
export const buildAllowedCommands = (verificationScripts: VerificationScript[]): Set<string> =>
  new Set(verificationScripts.map(script => script.command.trim()).filter(command => command.length > 0));

/**
 * Formats a list of repo files with repo-name prefix stripping.
 *
 * @param repoFiles - File paths, possibly prefixed with repo name
 * @param repoName - The repo name prefix to strip
 * @returns Formatted file list string
 */
export const formatRepoFileList = (repoFiles: string[], repoName: string): string => {
  if (repoFiles.length === 0) {
    return '  (none listed)';
  }

  return repoFiles
    .map(filePath => {
      const relativePath
        = repoName && filePath.startsWith(`${repoName}/`) ? filePath.slice(repoName.length + 1) : filePath;
      return `  - ${relativePath}`;
    })
    .join('\n');
};

/**
 * Strips the repo-name prefix from a file path.
 *
 * @param filePath - The file path, possibly prefixed with repo name
 * @param repoName - The repo name prefix to strip
 * @returns The file path without the repo prefix
 */
export const stripRepoPrefix = (filePath: string, repoName: string): string => {
  if (repoName && filePath.startsWith(`${repoName}/`)) {
    return filePath.slice(repoName.length + 1);
  }
  return filePath;
};

/**
 * Returns true when a planned file path contains glob wildcards.
 * These entries represent pattern-based plan tasks (e.g. `src/**\/*.service.ts`)
 * rather than concrete files and should be excluded from unvisited-file tracking.
 *
 * @param filePath - The planned file path to check
 * @returns True when the path contains `*` or `?` glob characters
 */
export const isGlobPattern = (filePath: string): boolean => filePath.includes('*') || filePath.includes('?');

/**
 * Formats a numbered list of plan steps for prompt inclusion.
 *
 * @param steps - Plan step strings
 * @returns Formatted numbered list, or fallback when empty
 */
const formatPlanStepList = (steps: string[]): string =>
  steps.length > 0 ? steps.map((step, i) => `  ${i + 1}. ${step}`).join('\n') : '  (none listed)';

/**
 * Formats verification scripts as a numbered runbook for the AI to execute verbatim.
 *
 * @param scripts - Verification script definitions
 * @returns Formatted numbered runbook, or fallback when empty
 */
const formatVerificationList = (scripts: VerificationScript[]): string => {
  if (scripts.length === 0) return '  (none configured)';
  const numbered = scripts
    .map((script, i) => `  ${i + 1}. ${script.command}`)
    .join('\n');
  return `${numbered}

IMPORTANT: After completing ALL code edits, you MUST run each verification
command above exactly as written, in order. Do NOT modify, abbreviate, or
pipe the commands. Run each one verbatim using Bash. If a command fails,
fix the code and re-run that same command until it passes before moving
to the next one.`;
};

/**
 * Formats risks as a block for inclusion in task briefs.
 *
 * @param planRisks - Optional list of risk strings from the plan artifact
 * @returns A numbered risks block, or empty string when none are present
 */
export const formatRisksSection = (planRisks?: string[]): string =>
  planRisks && planRisks.length > 0
    ? '\n\nRisks and considerations:\n' + planRisks.map((r, i) => `  ${i + 1}. ${r}`).join('\n')
    : '';

/**
 * Returns a human-readable description of the plan action type.
 *
 * @param planAction - The action type from the plan
 * @returns Sentence describing the action intent
 */
const describeAction = (planAction: 'fix' | 'feature' | 'investigate' | undefined): string => {
  switch (planAction) {
    case 'fix':
      return 'This is a bug fix. Make minimal, targeted changes that resolve the issue without altering unrelated behavior.';
    case 'feature':
      return 'This is a new feature. Extend the codebase following existing patterns and conventions.';
    default:
      return '(not specified)';
  }
};

export type ImplementerToolNames = {
  read: string;
  write: string;
  edit: string;
  search: string;
  glob: string;
  verify: string;
};

/**
 * Builds the tool-agnostic implementer rules section parameterised by adapter tool names.
 *
 * @param t - Adapter-specific tool name mapping
 * @returns Combined rules and workflow rules string
 */
export const buildImplementerRulesSection = (t: ImplementerToolNames): string => `Rules:
- NEVER output free-form text, commentary, or planning at any point during the run. Every response you produce MUST contain at least one tool call. The ONLY exception is the final summary (using the exact template below) which you output after ALL work is done and ALL verification passes. If you feel the urge to describe what you will do next, call a tool instead. Text output without a tool call terminates the run immediately.
- ALWAYS use ${t.edit} instead of ${t.write} for existing files. ${t.write} should only be used for creating new files. Using ${t.write} on existing files wastes context on unchanged lines.
- Use ${t.search} to find relevant line numbers, then ${t.read} with offset/limit to read only the section you need. Avoid reading entire large files.
- For mechanical migrations (e.g. replacing Logger with PinoLogger across many files): use ${t.search} to find all call sites, then apply ${t.edit} to each file without re-reading the full file — the search results show enough context.
- Use ${t.glob} to discover file paths instead of guessing.
- ${t.verify} is the only way to execute a shell command, and it will reject any command outside the verification whitelist. Never invent or call any other shell command tool.
- Never duplicate a function. To add a parameter, modify the existing function signature. To change behavior, edit the existing function body. This applies to constructors, methods, and standalone functions alike.
- NEVER add eslint-disable comments (inline, block, or file-level) to files you create or modify. If a lint rule fails in a file you are editing — whether the violation is new or pre-existing — fix the underlying code so the rule passes. Suppressing lint errors masks real problems. Fix all ESLint violations in every file you touch, not just the lines you changed.
- If you need to create a file not listed in "Files to implement", first check whether any verification command contains an inline allowlist of file paths. If it does, the new file must not cause that check to fail. Creating an unplanned file that is caught by a verification grep or assertion will block you — the verification whitelist is frozen and cannot be changed during this session.
- You MUST implement ALL plan steps listed above. Do not stop after completing only the core infrastructure — continue through every step until all tasks are done.
- Treat the returned progress signal as a heuristic only — never use a 'complete' verdict as a reason to stop. The verdict reflects a single verification command, not overall plan completion.
- Use verification commands as intermediate checkpoints to catch regressions. After each passing verification, check whether ALL plan steps are done. If any migration or refactoring work remains, continue working.
- After verification passes, run ${t.search} to count remaining instances of the patterns you are migrating (e.g. 'new Logger('). If the search returns ANY matches, you MUST continue editing those files — do NOT output a summary or any text. Producing a summary that says "remaining work needed" or "follow-up required" is a failure. Keep calling ${t.edit} until the search returns zero matches.
- Only stop when the migration search confirms zero remaining instances AND all verification commands pass (exit 0) — or when you determine no file changes are required. Then output ONLY the following summary, filled in with actual results. Do not add preamble or planning text.`;

const formatPhaseEntry = (phase: PlanPhase, index: number, planSteps: string[]): string => {
  const stepRange = phase.stepIndices.map(idx => idx + 1).join(', ');
  const stepLabels = phase.stepIndices.map(idx => planSteps[idx]).filter(Boolean)
    .map((s, j) => `  ${phase.stepIndices[j] + 1}. ${s}`).join('\n');
  const verifyLine = phase.verifyAfter?.length ? `  Verify: ${phase.verifyAfter.join(', ')}` : '  Verify: (none)';
  return `Phase ${index + 1}: ${phase.label} (steps ${stepRange})\n${stepLabels}\n${verifyLine}`;
};

const PHASE_CHECKPOINT_HEADER = '\n\n## Phase checkpoints\n\nThis plan is organized into phases. After completing all steps in each phase, run the phase\'s verification commands before proceeding to the next phase. If verification fails, fix the issues before moving on.\n';

const buildPhaseCheckpointSection = (phases: PlanPhase[] | undefined, planSteps: string[]): string => {
  if (!phases || phases.length === 0) return '';
  return [PHASE_CHECKPOINT_HEADER, ...phases.map((p, i) => formatPhaseEntry(p, i, planSteps))].join('\n');
};

const buildImplementSkillSection = (skillNames: string[] | undefined): string => {
  if (!skillNames?.length) return '';
  return '\n\nSkill-specific instructions:\nBefore starting work, invoke each of the following skills using the Skill tool:\n'
    + skillNames.map(s => `- Skill('${s}')`).join('\n')
    + '\nFollow each skill\'s instructions fully before proceeding.';
};

const resolveTrackedFileList = (params: BuildTaskBriefParams): string => {
  const identical = params.repoFiles.length === params.trackedFilePaths.length
    && params.repoFiles.every((f, i) => f === params.trackedFilePaths[i]);
  return identical ? '  (same as files to implement)' : formatRepoFileList(params.trackedFilePaths, params.repoName);
};

const resolveContextFileSection = (params: BuildTaskBriefParams): string =>
  params.contextFiles?.length ? `\n\nFiles for context (read-only — do NOT edit these):\n${formatRepoFileList(params.contextFiles, params.repoName)}` : '';

/**
 * Returns the role identity and repository directory — the stable behavioral
 * context that belongs in the system prompt and never changes between passes.
 *
 * @param repoDir - Primary repository root
 * @returns Role line and repository directory line
 */
export const buildBehavioralContext = (repoDir: string): string =>
  'You are an expert software engineer implementing code changes inside a repository.\n\nRepository directory: ' + repoDir;

/**
 * Builds the task-specific brief injected into user messages (pass 0 and every
 * continuation pass). Contains ticket key, plan summary, steps, file lists,
 * verification commands, risks, phases, and skill instructions.
 *
 * Does NOT include the role identity or repository directory — those belong in
 * `buildBehavioralContext`.
 *
 * @param params - Task brief parameters (no repoDir — use BuildPlanContextParams for callers that have it)
 * @returns Task brief string for user messages
 */
export const buildTaskBrief = (params: BuildTaskBriefParams): string =>
  `Ticket key: ${params.ticketKey}

Plan summary:
${params.planSummary || '(none)'}

Action: ${describeAction(params.planAction)}

Plan steps:
${formatPlanStepList(params.planSteps)}

Files to implement:
${formatRepoFileList(params.repoFiles, params.repoName)}${resolveContextFileSection(params)}

Tracked files:
${resolveTrackedFileList(params)}

Verification commands:
${formatVerificationList(params.verificationScripts)}${formatRisksSection(params.planRisks)}${buildPhaseCheckpointSection(params.phases, params.planSteps)}${buildImplementSkillSection(params.skillNames)}`;

/**
 * Backward-compatible wrapper that joins the behavioral context and task brief.
 * Existing callers continue to receive the same semantic content.
 *
 * @param params - Plan context parameters
 * @returns Combined behavioral context and task brief
 */
export const buildPlanContext = (params: BuildPlanContextParams): string =>
  buildBehavioralContext(params.repoDir) + '\n\n' + buildTaskBrief(params);

/**
 * Builds the initial user prompt that combines the task brief with a standard
 * action instruction. Used by the Anthropic Agent SDK and Claude CLI adapters.
 *
 * @param params - Task brief parameters
 * @returns Full initial user prompt string
 */
export const buildInitialUserPrompt = (params: BuildTaskBriefParams): string =>
  [
    buildTaskBrief(params),
    'Implement the changes described above now. Use Read to inspect existing files, then Write or Edit to apply changes. After ALL edits are complete, run each command listed under "Verification commands:" exactly as written, in order, using Bash. Do not modify or pipe the commands. Do not output any text or plan before making your first tool call.',
  ].join('\n\n');

const readOptionalFile = async (filePath: string): Promise<string | null> => {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
};

/**
 * Loads CLAUDE.md context from global and repo-level paths.
 *
 * @param repoDir - Repository root directory
 * @returns Combined CLAUDE.md context string
 */
export const loadClaudeContext = async (repoDir: string): Promise<string> => {
  const globalClaudePath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  const repoClaudePath = path.join(repoDir, 'CLAUDE.md');
  const [rootClaude, dotClaude]
    = await Promise.all([readOptionalFile(globalClaudePath), readOptionalFile(repoClaudePath)]);

  if (rootClaude === null) console.log(chalk.yellow(`⚠ Missing CLAUDE.md file at ${globalClaudePath}`));
  if (dotClaude === null) console.log(chalk.yellow(`⚠ Missing CLAUDE.md file at ${repoClaudePath}`));

  return [
    rootClaude && `## ~/.claude/CLAUDE.md\n${rootClaude.trimEnd()}`,
    dotClaude && `## CLAUDE.md\n${dotClaude.trimEnd()}`,
  ].filter(Boolean).join('\n\n');
};

/**
 * Splits output lines and adds each non-empty trimmed line into a set.
 *
 * @param lines - Raw newline-delimited output string
 * @param into - Target set to accumulate file paths
 */
const addNonEmptyLines = (lines: string, into: Set<string>): void => {
  for (const line of lines.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) into.add(trimmed);
  }
};

/**
 * Discovers files changed on disk since the last commit using git.
 * Falls back to the provided set if git is unavailable.
 *
 * @param repoDir - Repository root directory
 * @param existing - Existing set of touched files to merge into
 * @returns Merged set of relative file paths
 */
export const discoverChangedFiles = async (repoDir: string, existing: Set<string>): Promise<Set<string>> => {
  try {
    const { stdout } = await execAsync(
      'git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null',
      { cwd: repoDir }
    );
    addNonEmptyLines(stdout, existing);
  } catch (error) {
    console.log(chalk.gray(`  git file discovery unavailable: ${error instanceof Error ? error.message : 'unknown error'}`));
  }
  return existing;
};
