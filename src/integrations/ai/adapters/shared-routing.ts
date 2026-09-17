import { ConfigService } from '@nestjs/config';
import chalk from 'chalk';
import { exec } from 'node:child_process';
import { ConfigurationError } from '../../../shared/utils/errors';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { ResolutionPlan } from '../ai.service';
import type { planPhaseSchema } from '../../../shared/schemas/ai.schema';
import type { z } from 'zod';
import type { WfImplementStageModelRoutingThresholdsConfig } from '../../../shared/types/config.types';

export type PlanPhase = z.infer<typeof planPhaseSchema>;
import type { VerificationScript, ModelRouting } from '../../../agents/interfaces';
import type { BuildTaskBriefParams, BuildPlanContextParams } from '../../../shared/types/agent.types';
export type { BuildTaskBriefParams, BuildPlanContextParams } from '../../../shared/types/agent.types';

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

const countPatternMatches = (steps: string[], patterns: RegExp[]): number =>
  steps.filter(step => patterns.some(pattern => pattern.test(step))).length;

const countSemanticSignals = (steps: string[]): { mechanical: number; creative: number } => ({
  mechanical: countPatternMatches(steps, MECHANICAL_SEMANTIC_PATTERNS),
  creative: countPatternMatches(steps, CREATIVE_SEMANTIC_PATTERNS),
});

const matchMechanicalKeyword = (steps: string[]): RegExp | null => {
  for (const step of steps) {
    const matched = MECHANICAL_KEYWORD_PATTERNS.find(pattern => pattern.test(step));
    if (matched) {
      return matched;
    }
  }
  return null;
};

const countTargetedWrites = (plan: ResolutionPlan): number => plan.affectedFiles?.length ?? 0;

const detectThresholdRouting = (
  plan: ResolutionPlan,
  thresholds: WfImplementStageModelRoutingThresholdsConfig | undefined,
  filesCount: number,
  stepsCount: number
): string | undefined => {
  if (plan.estimatedComplexity !== 'medium' && plan.estimatedComplexity !== 'high') return undefined;
  if (thresholds?.maxTargetedWritesForDefault !== undefined && filesCount > thresholds.maxTargetedWritesForDefault) {
    return `targeted writes threshold exceeded: ${filesCount} targeted writes > ${thresholds.maxTargetedWritesForDefault}`;
  }
  if (thresholds?.maxPlanStepsForDefault !== undefined && stepsCount > thresholds.maxPlanStepsForDefault) {
    return `plan steps threshold exceeded: ${stepsCount} steps > ${thresholds.maxPlanStepsForDefault}`;
  }
  return undefined;
};

const detectPatternRouting = (steps: string[]): { isMechanical: boolean; reason: string } | undefined => {
  const matched = matchMechanicalKeyword(steps);
  const firstStep = matched ? (steps.find(step => matched.test(step)) ?? '') : '';
  if (matched) return { isMechanical: true, reason: `pattern: "${matched.source}" in step "${firstStep.slice(0, 60)}"` };
  const signals = countSemanticSignals(steps);
  const dominantMechanical = signals.mechanical > 0 && signals.mechanical > signals.creative;
  if (dominantMechanical) {
    return { isMechanical: true, reason: `semantic signals: ${signals.mechanical} mechanical vs ${signals.creative} creative` };
  }
  return undefined;
};

export const detectMechanicalTask = (
  plan: ResolutionPlan,
  thresholds?: WfImplementStageModelRoutingThresholdsConfig
): { isMechanical: boolean; reason: string } => {
  const filesCount = countTargetedWrites(plan);
  const stepsCount = plan.steps.length;
  if (plan.estimatedComplexity === 'low') return { isMechanical: true, reason: `low complexity task (${filesCount} files)` };
  const thresholdReason = detectThresholdRouting(plan, thresholds, filesCount, stepsCount);
  if (thresholdReason) return { isMechanical: true, reason: thresholdReason };
  if (plan.estimatedComplexity === 'high') return { isMechanical: false, reason: 'high complexity task' };
  const highRatio = stepsCount > 0 && filesCount > 3 && filesCount / stepsCount > 3;
  if (highRatio) return { isMechanical: true, reason: `high file-to-step ratio: ${filesCount} files / ${stepsCount} steps` };
  return detectPatternRouting(plan.steps) ?? { isMechanical: false, reason: 'creative task' };
};

export type ModelRoutingResult = {
  model: string;
  defaultModel: string;
  logMessage: string;
};

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
  if (singleModel && modelsConfig) throw new ConfigurationError(MODEL_CONFIG_EXCLUSIVE_ERROR);
  return {
    defaultModel: modelsConfig?.default || singleModel || fallbackDefaultModel,
    mechanicalModel: modelsConfig?.mechanical || singleModel || defaultMechanicalModel,
  };
};

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

export const resolveModelRouting = (params: ModelRoutingParams): ModelRoutingResult => {
  const { routing, fallbackDefaultModel, defaultMechanicalModel, configService, plan, adapterLabel } = params;
  const { defaultModel, mechanicalModel }
    = resolveModelConfig(configService, fallbackDefaultModel, defaultMechanicalModel);
  if (routing === 'default') return buildRoutingResult(defaultModel, defaultModel, adapterLabel, 'default — user override');
  if (routing === 'mechanical') return buildRoutingResult(mechanicalModel, defaultModel, adapterLabel, 'mechanical — user override');
  const thresholds
    = configService.get<WfImplementStageModelRoutingThresholdsConfig>('stages.implement.modelRoutingThresholds');
  const detection = detectMechanicalTask(plan, thresholds);
  const autoModel = detection.isMechanical ? mechanicalModel : defaultModel;
  const autoLabel = detection.isMechanical ? `auto — mechanical: ${detection.reason}` : `auto — creative: ${detection.reason}`;
  return buildRoutingResult(autoModel, defaultModel, adapterLabel, autoLabel);
};

export const resolveProviderModel = (
  configService: ConfigService, providerName: string, fallback: string,
): string => {
  const providers = configService.get<Array<{ provider: string; model?: string }>>('ai.providers') ?? [];
  return providers.find(p => p.provider === providerName)?.model ?? fallback;
};

export const normalizeCommand = (command: unknown): string => (typeof command === 'string' ? command.trim() : '');

export const buildAllowedCommands = (verificationScripts: VerificationScript[]): Set<string> =>
  new Set(verificationScripts.map(script => script.command.trim()).filter(command => command.length > 0));

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

const formatPlanStepList = (steps: string[]): string =>
  steps.length > 0 ? steps.map((step, i) => `  ${i + 1}. ${step}`).join('\n') : '  (none listed)';

const formatVerificationList = (scripts: VerificationScript[]): string => {
  if (scripts.length === 0) return '  (none configured)';
  const numbered = scripts
    .map((script, i) => `  ${i + 1}. ${script.command}`)
    .join('\n');
  return `${numbered}

After completing all code edits, run each verification command above exactly as written, in order.
Do not modify, abbreviate, or pipe the commands — run each one verbatim using Bash.
If a command fails, fix the code and re-run that same command until it passes before moving to the next one.`;
};

export const formatRisksSection = (planRisks?: string[]): string =>
  planRisks && planRisks.length > 0
    ? '\n\nRisks and considerations:\n' + planRisks.map((r, i) => `  ${i + 1}. ${r}`).join('\n')
    : '';

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

const buildImplementerEditingRuleLines = (t: ImplementerToolNames): string[] => [
  'Respond exclusively with tool calls — text without a tool call terminates the run. The only exception is the final summary (template below), output after all work and verification passes.',
  `Use ${t.edit} for existing files and ${t.write} only for new files — writing a full file wastes context on unchanged lines.`,
  `Use ${t.search} to find relevant line numbers, then ${t.read} with offset/limit to read only the section you need. Avoid reading entire large files.`,
  `For mechanical migrations (e.g. replacing Logger with PinoLogger across many files): use ${t.search} to find all call sites, then apply ${t.edit} to each file without re-reading the full file — the search results show enough context.`,
  `For a rename or terminology migration, search with a broad case-insensitive substring search (e.g. /oldterm/i), not a word-boundary-only pattern (e.g. /\\boldterm\\b/) — the latter misses kebab-case identifiers (old-term-thing), capitalized prose (OldTerm), and other non-word-boundary forms that are still real occurrences of the term being migrated. Run this search across the whole repository, including docs/specs directories, not only the source directories the plan happened to list.`,
  `Use ${t.glob} to discover file paths instead of guessing.`,
  `${t.verify} is the only way to execute a shell command and rejects anything outside the verification whitelist.`,
  'Modify existing functions in place rather than duplicating them — this applies to constructors, methods, and standalone functions.',
  'Fix lint violations in every file you touch rather than suppressing them with eslint-disable comments — suppression masks real problems.',
  'If you need to create a file not listed in "Files to implement", first check whether any verification command contains an inline allowlist of file paths. If it does, the new file must not cause that check to fail. Creating an unplanned file that is caught by a verification grep or assertion will block you — the verification whitelist is frozen and cannot be changed during this session.',
];

const buildImplementerCompletionRuleLines = (t: ImplementerToolNames): string[] => [
  'Implement all plan steps — do not stop after core infrastructure when remaining steps exist.',
  `For any file you edit or delete content from as part of a rename, removal, or refactor, use ${t.search} to check whether it still has any remaining importers/callers once your edits land. If it has zero remaining references anywhere in the repo, delete it rather than leaving an orphaned module behind — do not just note it as dead code for a future ticket.`,
  'The returned progress signal reflects a single verification command, not overall plan completion — treat it as a heuristic.',
  'Use verification commands as intermediate checkpoints to catch regressions. After each passing verification, check whether ALL plan steps are done. If any migration or refactoring work remains, continue working.',
  `After verification passes, run ${t.search} to count remaining migration patterns. If any matches remain, keep editing — do not output a summary until the search returns zero matches.`,
  'Stop only when migration search confirms zero remaining instances and all verification commands pass (exit 0), or when no file changes are required. Then output the following summary filled in with actual results.',
];

export const buildImplementerRulesSection = (t: ImplementerToolNames): string =>
  [
    'Rules:',
    ...[...buildImplementerEditingRuleLines(t), ...buildImplementerCompletionRuleLines(t)].map(line => `- ${line}`),
  ].join('\n');

const formatPhaseEntry = (phase: PlanPhase, index: number, planSteps: string[]): string => {
  const stepRange = phase.stepIndices.map(idx => idx + 1).join(', ');
  const stepLabels = phase.stepIndices.map(idx => planSteps[idx]).filter(Boolean)
    .map((s, j) => `  ${phase.stepIndices[j] + 1}. ${s}`).join('\n');
  const verifyLine = phase.verifyAfter?.length ? `  Verify: ${phase.verifyAfter.join(', ')}` : '  Verify: (none)';
  return `Phase ${index + 1}: ${phase.label} (steps ${stepRange})\n${stepLabels}\n${verifyLine}`;
};

const phaseCheckpointHeader = '\n\n## Phase checkpoints\n\nThis plan is organized into phases. After completing all steps in each phase, run the phase\'s verification commands before proceeding to the next phase. If verification fails, fix the issues before moving on.\n';

const buildPhaseCheckpointSection = (phases: PlanPhase[] | undefined, planSteps: string[]): string => {
  if (!phases || phases.length === 0) return '';
  return [phaseCheckpointHeader, ...phases.map((p, i) => formatPhaseEntry(p, i, planSteps))].join('\n');
};

const buildImplementSkillSection = (skillNames: string[] | undefined, figmaContextSection?: string): string => {
  if (!skillNames?.length && !figmaContextSection) return '';
  const lines: string[] = (skillNames ?? []).map(s => `- Skill('${s}')`);
  const skillBlock = lines.length
    ? '\n\nSkill-specific instructions:\nBefore starting work, invoke each of the following skills using the Skill tool:\n'
    + lines.join('\n')
    + '\nFollow each skill\'s instructions fully before proceeding.'
    : '';
  return figmaContextSection ? `${skillBlock}\n\n${figmaContextSection}` : skillBlock;
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
${formatVerificationList(params.verificationScripts)}${formatRisksSection(params.planRisks)}${buildPhaseCheckpointSection(params.phases, params.planSteps)}${buildImplementSkillSection(params.skillNames, params.figmaContextSection)}`;

/**
 * Backward-compatible wrapper that joins the behavioral context and task brief.
 * Existing callers continue to receive the same semantic content.
 *
 * @param params - Plan context parameters
 * @returns Combined behavioral context and task brief
 */
export const buildPlanContext = (params: BuildPlanContextParams): string =>
  buildBehavioralContext(params.repoDir) + '\n\n' + buildTaskBrief(params);

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

const addNonEmptyLines = (lines: string, into: Set<string>): void => {
  for (const line of lines.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) into.add(trimmed);
  }
};

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
