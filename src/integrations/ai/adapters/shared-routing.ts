import { ConfigService } from '@nestjs/config';
import chalk from 'chalk';
import { exec } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import type { ResolutionPlan } from '../ai.service';
import type { VerificationScript, ModelRouting } from '../../../agents/interfaces';

const execAsync = promisify(exec);

const MECHANICAL_STEP_PATTERNS = [
  /migrate all/i,
  /replace every/i,
  /update each/i,
  /same pattern across/i,
  /rename all/i,
  /add .+ to every/i,
];

/**
 * Detects whether a plan describes a mechanical (repetitive, pattern-based) task.
 *
 * @param plan - The resolution plan to evaluate
 * @returns True when the plan appears mechanical, with a human-readable reason
 */
export const detectMechanicalTask = (plan: ResolutionPlan): { isMechanical: boolean; reason: string } => {
  const filesCount = plan.affectedFiles?.length ?? 0;
  const stepsCount = plan.steps.length;

  for (const step of plan.steps) {
    const matched = MECHANICAL_STEP_PATTERNS.find(pattern => pattern.test(step));
    if (matched) {
      return {
        isMechanical: true,
        reason: `pattern: "${matched.source}" in step "${step.slice(0, 60)}"`,
      };
    }
  }

  if (stepsCount > 0 && filesCount > 3 && filesCount / stepsCount > 3) {
    return {
      isMechanical: true,
      reason: `high file-to-step ratio: ${filesCount} files / ${stepsCount} steps`,
    };
  }

  if (plan.estimatedComplexity === 'low' && filesCount >= 20) {
    return {
      isMechanical: true,
      reason: `low complexity with ${filesCount} files`,
    };
  }

  return { isMechanical: false, reason: 'creative task' };
};

export type ModelRoutingResult = {
  model: string;
  defaultModel: string;
  logMessage: string;
};

/**
 * Resolves the model to use based on routing mode, config, and mechanical detection.
 *
 * @param params - Routing context including the adapter label for log messages
 * @returns Selected model and an observability log message
 */
export const resolveModelRouting = (params: {
  routing: ModelRouting;
  fallbackDefaultModel: string;
  defaultMechanicalModel: string;
  configService: ConfigService;
  plan: ResolutionPlan;
  adapterLabel: string;
}): ModelRoutingResult => {
  const { routing, fallbackDefaultModel, defaultMechanicalModel, configService, plan, adapterLabel } = params;

  const singleModel = configService.get<string>('stages.implement.model');
  const modelsConfig =
    configService.get<import('../../../config/public-config').WfImplementStageModelsConfig>('stages.implement.models');

  // models is more specific than model — it takes precedence when both are set.
  const defaultModel = modelsConfig?.default || singleModel || fallbackDefaultModel;
  const mechanicalModel = modelsConfig?.mechanical || defaultMechanicalModel;

  if (singleModel && modelsConfig) {
    throw new Error(
      'stages.implement.model and stages.implement.models are mutually exclusive.\n' +
        '  Use stages.implement.model for a single model, or\n' +
        '  Use stages.implement.models for routing-aware model selection (default + mechanical).'
    );
  }

  if (routing === 'default') {
    return {
      model: defaultModel,
      defaultModel,
      logMessage: `[${adapterLabel}] Model routing: ${defaultModel} (default — user override)`,
    };
  }

  if (routing === 'mechanical') {
    return {
      model: mechanicalModel,
      defaultModel,
      logMessage: `[${adapterLabel}] Model routing: ${mechanicalModel} (mechanical — user override)`,
    };
  }

  // auto mode: detect from plan
  const detection = detectMechanicalTask(plan);
  if (detection.isMechanical) {
    return {
      model: mechanicalModel,
      defaultModel,
      logMessage: `[${adapterLabel}] Model routing: ${mechanicalModel} (auto — mechanical: ${detection.reason})`,
    };
  }

  return {
    model: defaultModel,
    defaultModel,
    logMessage: `[${adapterLabel}] Model routing: ${defaultModel} (auto — creative: ${detection.reason})`,
  };
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
      const relativePath =
        repoName && filePath.startsWith(`${repoName}/`) ? filePath.slice(repoName.length + 1) : filePath;
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
 * Builds the shared plan-context portion of the system prompt used by all
 * implementer adapters. Contains everything from the role description through
 * the verification commands list. Adapter-specific tool names, rules, and
 * summary templates are appended by each adapter separately.
 *
 * @param params - Plan context parameters
 * @returns Formatted plan-context prompt string
 */
export const buildPlanContext = (params: {
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
}): string => {
  const fileList = formatRepoFileList(params.repoFiles, params.repoName);
  const trackedIdentical =
    params.repoFiles.length === params.trackedFilePaths.length &&
    params.repoFiles.every((f, i) => f === params.trackedFilePaths[i]);
  const trackedFileList = trackedIdentical
    ? '  (same as files to implement)'
    : formatRepoFileList(params.trackedFilePaths, params.repoName);
  const verificationList =
    params.verificationScripts.length > 0
      ? params.verificationScripts.map(script => `  - ${script.command}`).join('\n')
      : '  (none configured)';
  const planStepList =
    params.planSteps.length > 0
      ? params.planSteps.map((step, i) => `  ${i + 1}. ${step}`).join('\n')
      : '  (none listed)';

  const contextFileSection =
    params.contextFiles && params.contextFiles.length > 0
      ? `\n\nFiles for context (read-only — do NOT edit these):\n${formatRepoFileList(params.contextFiles, params.repoName)}`
      : '';

  return `You are an expert software engineer implementing code changes inside a repository.

Repository directory: ${params.repoDir}
Ticket key: ${params.ticketKey}

Plan summary:
${params.planSummary || '(none)'}

Action: ${(() => {
    switch (params.planAction) {
      case 'fix':
        return 'This is a bug fix. Make minimal, targeted changes that resolve the issue without altering unrelated behavior.';
      case 'feature':
        return 'This is a new feature. Extend the codebase following existing patterns and conventions.';
      default:
        return '(not specified)';
    }
  })()}

Plan steps:
${planStepList}

Files to implement:
${fileList}${contextFileSection}

Tracked files:
${trackedFileList}

Verification commands:
${verificationList}`;
};

const readOptionalFile = async (filePath: string): Promise<string | null> => {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
};

const warnMissingClaudeFile = (filePath: string): void => {
  console.log(chalk.yellow(`⚠️ Missing CLAUDE.md file at ${filePath}`));
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
  const [rootClaude, dotClaude] = await Promise.all([
    readOptionalFile(globalClaudePath),
    readOptionalFile(repoClaudePath),
  ]);

  if (rootClaude === null) {
    warnMissingClaudeFile(globalClaudePath);
  }

  if (dotClaude === null) {
    warnMissingClaudeFile(repoClaudePath);
  }

  const sections = [
    rootClaude && `## ~/.claude/CLAUDE.md\n${rootClaude.trimEnd()}`,
    dotClaude && `## CLAUDE.md\n${dotClaude.trimEnd()}`,
  ].filter(Boolean);

  return sections.join('\n\n');
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
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) {
        existing.add(trimmed);
      }
    }
  } catch (error) {
    console.log(
      chalk.gray(`  git file discovery unavailable: ${error instanceof Error ? error.message : 'unknown error'}`)
    );
  }
  return existing;
};
