import * as path from 'path';

import { detectRepoConventions } from './detect-repo-conventions';
import type { RepoConventionsContext } from '../types/detection.types';
import type { CrossRepoPattern, CrossRepoContext } from '../types/detection.types';

export type { CrossRepoPattern, CrossRepoContext };

const TEST_FRAMEWORKS = ['jest', 'vitest', 'mocha', 'pytest', 'testify'];

/**
 * Detect the test framework used from keyDependencies.
 *
 * @param keyDependencies - List of key dependency names
 * @returns The matched test framework name, or null if none found
 */
const detectTestFramework = (keyDependencies: string[]): string | null => {
  for (const dep of keyDependencies) {
    for (const framework of TEST_FRAMEWORKS) {
      if (dep === framework || dep.includes(framework)) {
        return framework;
      }
    }
  }
  return null;
};

/**
 * Collect tooling-related deltas: linter, test framework, import style.
 *
 * @param repoName - Human-readable name for the secondary repo
 * @param primary - Conventions context for the primary repo
 * @param secondary - Conventions context for the secondary repo
 * @returns Array of delta description strings
 */
const collectToolingDeltas = (
  repoName: string,
  primary: RepoConventionsContext,
  secondary: RepoConventionsContext,
): string[] => {
  const deltas: string[] = [];
  const primaryLinter = primary.linter?.tool ?? null;
  const secondaryLinter = secondary.linter?.tool ?? null;
  if (secondaryLinter !== primaryLinter) deltas.push(`${repoName} uses ${secondaryLinter} linter (primary uses ${primaryLinter})`);
  const primaryFramework = detectTestFramework(primary.keyDependencies);
  const secondaryFramework = detectTestFramework(secondary.keyDependencies);
  if (secondaryFramework !== primaryFramework) deltas.push(`${repoName} uses ${secondaryFramework} for testing (primary uses ${primaryFramework})`);
  if (secondary.importStyle !== primary.importStyle) deltas.push(`${repoName} uses ${secondary.importStyle} imports (primary uses ${primary.importStyle})`);
  return deltas;
};

/**
 * Collect git hooks delta when the secondary repo uses a different tool than the primary.
 *
 * @param repoName - Human-readable name for the secondary repo
 * @param primary - Conventions context for the primary repo
 * @param secondary - Conventions context for the secondary repo
 * @returns Array containing the git hooks delta string, or empty
 */
const collectGitHooksDeltas = (
  repoName: string,
  primary: RepoConventionsContext,
  secondary: RepoConventionsContext,
): string[] => {
  const primaryTools = [...new Set(primary.gitHooks.map(({ tool }) => tool))].sort();
  const secondaryTools = [...new Set(secondary.gitHooks.map(({ tool }) => tool))].sort();

  if (primaryTools.length === 0 && secondaryTools.length === 0) return [];
  if (secondaryTools.length === 0) {
    return [`${repoName} has no git hooks (primary uses ${primaryTools.join(', ')})`];
  }
  if (primaryTools.length === 0) return [`${repoName} uses ${secondaryTools.join(', ')} git hooks`];
  if (primaryTools.join(', ') === secondaryTools.join(', ')) return [];

  return [`${repoName} uses ${secondaryTools.join(', ')} git hooks (primary uses ${primaryTools.join(', ')})`];
};

/**
 * Collect structure-related deltas: error utilities, naming, NestJS.
 *
 * @param repoName - Human-readable name for the secondary repo
 * @param primary - Conventions context for the primary repo
 * @param secondary - Conventions context for the secondary repo
 * @returns Array of delta description strings
 */
const collectStructureDeltas = (
  repoName: string,
  primary: RepoConventionsContext,
  secondary: RepoConventionsContext,
): string[] => {
  const deltas: string[] = [];
  for (const errorPath of secondary.errorHandlingPaths) {
    if (!primary.errorHandlingPaths.includes(errorPath)) deltas.push(`${repoName} has error utility at ${errorPath}`);
  }
  if (secondary.namingPattern !== primary.namingPattern) deltas.push(`${repoName} uses ${secondary.namingPattern} naming (primary uses ${primary.namingPattern})`);
  if (secondary.nestjsDetected && !primary.nestjsDetected) deltas.push(`${repoName} uses NestJS`);
  if (!secondary.nestjsDetected && primary.nestjsDetected) deltas.push(`${repoName} does not use NestJS (primary does)`);
  return deltas;
};

/**
 * Collect ecosystem-related deltas: language, TypeScript strictness, Go, Terraform.
 *
 * @param repoName - Human-readable name for the secondary repo
 * @param primary - Conventions context for the primary repo
 * @param secondary - Conventions context for the secondary repo
 * @returns Array of delta description strings
 */
const collectEcosystemDeltas = (
  repoName: string,
  primary: RepoConventionsContext,
  secondary: RepoConventionsContext,
): string[] => {
  const deltas: string[] = [];
  if (secondary.language !== primary.language) deltas.push(`${repoName} uses ${secondary.language} (primary uses ${primary.language})`);
  const tsNonStrict = secondary.typescript !== null && primary.typescript !== null
    && !secondary.typescript.strict && primary.typescript.strict;
  if (tsNonStrict) deltas.push(`${repoName} uses non-strict TypeScript (primary uses strict)`);
  if (secondary.go !== null && primary.language !== 'go') deltas.push(`${repoName} is a Go module: ${secondary.go.modulePath}`);
  if (secondary.terraform !== null && primary.language !== 'terraform') deltas.push(`${repoName} uses Terraform providers: ${secondary.terraform.providers.join(', ')}`);
  return deltas;
};

/**
 * Compare secondary repo conventions against primary and return meaningful delta strings.
 *
 * @param repoName - Human-readable name for the secondary repo
 * @param primary - Conventions context for the primary repo
 * @param secondary - Conventions context for the secondary repo
 * @returns Array of delta description strings
 */
const computeDeltas = (
  repoName: string,
  primary: RepoConventionsContext,
  secondary: RepoConventionsContext,
): string[] => [
  ...collectEcosystemDeltas(repoName, primary, secondary),
  ...collectToolingDeltas(repoName, primary, secondary),
  ...collectGitHooksDeltas(repoName, primary, secondary),
  ...collectStructureDeltas(repoName, primary, secondary),
];

/**
 * Detect cross-repo patterns by comparing secondary repos' conventions against the primary.
 *
 * @param primaryRepoDir - Absolute path to the primary repository root
 * @param secondaryRepoDirs - Absolute paths to secondary repository roots
 * @returns A CrossRepoContext containing patterns with meaningful deltas
 */
export const detectCrossRepoPatterns = (primaryRepoDir: string, secondaryRepoDirs: string[]): CrossRepoContext => {
  const primary = detectRepoConventions(primaryRepoDir);
  const patterns: CrossRepoPattern[] = [];

  for (const secondaryDir of secondaryRepoDirs) {
    const secondary = detectRepoConventions(secondaryDir);
    const repoName = path.basename(secondaryDir);
    const deltas = computeDeltas(repoName, primary, secondary);

    if (deltas.length > 0) {
      patterns.push({ repoName, deltas });
    }
  }

  return { patterns };
};

/**
 * Format a CrossRepoContext into a prompt section string.
 *
 * @param ctx - The cross-repo context
 * @returns A formatted string for inclusion in an AI prompt, or empty string when no patterns exist
 */
export const formatCrossRepoPatternsPromptSection = (ctx: CrossRepoContext): string => {
  if (ctx.patterns.length === 0) return '';

  const lines: string[] = ['Patterns from related repositories:'];

  for (const pattern of ctx.patterns) {
    lines.push(`${pattern.repoName}:`);
    for (const delta of pattern.deltas) {
      lines.push(`  - ${delta}`);
    }
  }

  return lines.join('\n');
};
