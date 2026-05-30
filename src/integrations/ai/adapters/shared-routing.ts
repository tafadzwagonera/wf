import { ConfigService } from '@nestjs/config';
import chalk from 'chalk';
import type { ResolutionPlan } from '../ai.service';
import type {
  VerificationScript,
  ModelRouting,
} from '../../../agents/interfaces';

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
export const detectMechanicalTask = (
  plan: ResolutionPlan,
): { isMechanical: boolean; reason: string } => {
  const filesCount = plan.filesAffected?.length ?? 0;
  const stepsCount = plan.steps.length;

  for (const step of plan.steps) {
    const matched = MECHANICAL_STEP_PATTERNS.find((pattern) =>
      pattern.test(step),
    );
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
  primaryModel: string;
  defaultMechanicalModel: string;
  configService: ConfigService;
  plan: ResolutionPlan;
  adapterLabel: string;
}): ModelRoutingResult => {
  const {
    routing,
    primaryModel,
    defaultMechanicalModel,
    configService,
    plan,
    adapterLabel,
  } = params;

  const singleModel = configService.get<string>('stages.implement.model');
  const modelsConfig = configService.get<
    import('../../../config/public-config').WfImplementStageModelsConfig
  >('stages.implement.models');

  if (singleModel && modelsConfig) {
    console.log(
      chalk.yellow(
        `  [${adapterLabel}] Warning: both stages.implement.model and stages.implement.models are set. model takes precedence; models is ignored.`,
      ),
    );
  }

  const mechanicalModel = modelsConfig?.mechanical || defaultMechanicalModel;

  if (routing === 'primary') {
    return {
      model: primaryModel,
      logMessage: `[${adapterLabel}] Model routing: ${primaryModel} (primary — user override)`,
    };
  }

  if (routing === 'mechanical') {
    return {
      model: mechanicalModel,
      logMessage: `[${adapterLabel}] Model routing: ${mechanicalModel} (mechanical — user override)`,
    };
  }

  // auto mode: detect from plan
  const detection = detectMechanicalTask(plan);
  if (detection.isMechanical) {
    return {
      model: mechanicalModel,
      logMessage: `[${adapterLabel}] Model routing: ${mechanicalModel} (auto — mechanical: ${detection.reason})`,
    };
  }

  return {
    model: primaryModel,
    logMessage: `[${adapterLabel}] Model routing: ${primaryModel} (auto — creative: ${detection.reason})`,
  };
};

/**
 * Normalizes a command value to a trimmed string.
 *
 * @param command - The raw command value
 * @returns Trimmed command string, or empty string for non-string input
 */
export const normalizeCommand = (command: unknown): string =>
  typeof command === 'string' ? command.trim() : '';

/**
 * Builds a set of allowed verification commands from the scripts config.
 *
 * @param verificationScripts - Verification script definitions
 * @returns Set of trimmed, non-empty command strings
 */
export const buildAllowedCommands = (
  verificationScripts: VerificationScript[],
): Set<string> =>
  new Set(
    verificationScripts
      .map((script) => script.command.trim())
      .filter((command) => command.length > 0),
  );

/**
 * Formats a list of repo files with repo-name prefix stripping.
 *
 * @param repoFiles - File paths, possibly prefixed with repo name
 * @param repoName - The repo name prefix to strip
 * @returns Formatted file list string
 */
export const formatRepoFileList = (
  repoFiles: string[],
  repoName: string,
): string => {
  if (repoFiles.length === 0) {
    return '  (none listed)';
  }

  return repoFiles
    .map((filePath) => {
      const relativePath =
        repoName && filePath.startsWith(`${repoName}/`)
          ? filePath.slice(repoName.length + 1)
          : filePath;
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
