import { ConfigService } from '@nestjs/config';
import chalk from 'chalk';
import { exec } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { ResolutionPlan } from '../ai.service';
import type { VerificationScript, ModelRouting } from '../../../agents/interfaces';

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
    mechanicalModel: modelsConfig?.mechanical || defaultMechanicalModel,
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

export type BuildPlanContextParams = {
  ticketKey: string;
  repoDir: string;
  repoName: string;
  repoFiles: string[];
  contextFiles?: string[];
  trackedFilePaths: string[];
  verificationScripts: VerificationScript[];
  planSteps: string[];
  planSummary?: string;
  planRisks?: string[];
  planAction?: 'fix' | 'feature' | 'investigate';
};

type PlanContextDisplay = {
  repoDir: string; ticketKey: string; planSummary: string; actionDesc: string;
  planStepList: string; fileList: string; contextFileSection: string; trackedFileList: string; verificationList: string;
};

/**
 * Assembles resolved plan-context values into the final prompt template.
 *
 * @param p - Pre-resolved display strings derived from plan context params
 * @returns Formatted plan-context prompt string
 */
const assemblePlanContextPrompt = (p: PlanContextDisplay): string => `You are an expert software engineer implementing code changes inside a repository.

Repository directory: ${p.repoDir}
Ticket key: ${p.ticketKey}

Plan summary:
${p.planSummary}

Action: ${p.actionDesc}

Plan steps:
${p.planStepList}

Files to implement:
${p.fileList}${p.contextFileSection}

Tracked files:
${p.trackedFileList}

Verification commands:
${p.verificationList}`;

/**
 * Builds the shared plan-context portion of the system prompt used by all
 * implementer adapters. Contains everything from the role description through
 * the verification commands list. Adapter-specific tool names, rules, and
 * summary templates are appended by each adapter separately.
 *
 * @param params - Plan context parameters
 * @returns Formatted plan-context prompt string
 */
export const buildPlanContext = (params: BuildPlanContextParams): string => {
  const fileList = formatRepoFileList(params.repoFiles, params.repoName);
  const trackedIdentical
    = params.repoFiles.length === params.trackedFilePaths.length
      && params.repoFiles.every((f, i) => f === params.trackedFilePaths[i]);
  const trackedFileList = trackedIdentical ? '  (same as files to implement)' : formatRepoFileList(params.trackedFilePaths, params.repoName);
  const hasContextFiles = params.contextFiles && params.contextFiles.length > 0;
  const contextFileSection = hasContextFiles ? `\n\nFiles for context (read-only — do NOT edit these):\n${formatRepoFileList(params.contextFiles ?? [], params.repoName)}` : '';
  return assemblePlanContextPrompt({
    repoDir: params.repoDir, ticketKey: params.ticketKey, planSummary: params.planSummary || '(none)',
    actionDesc: describeAction(params.planAction), planStepList: formatPlanStepList(params.planSteps),
    fileList, contextFileSection, trackedFileList, verificationList: formatVerificationList(params.verificationScripts),
  });
};

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

  if (rootClaude === null) console.log(chalk.yellow(`⚠️ Missing CLAUDE.md file at ${globalClaudePath}`));
  if (dotClaude === null) console.log(chalk.yellow(`⚠️ Missing CLAUDE.md file at ${repoClaudePath}`));

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
