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
  secondary: RepoConventionsContext
): string[] => {
  const deltas: string[] = [];

  // Different language
  if (secondary.language !== primary.language) {
    deltas.push(`${repoName} uses ${secondary.language} (primary uses ${primary.language})`);
  }

  // Different linter tool
  const primaryLinterTool = primary.linter?.tool ?? null;
  const secondaryLinterTool = secondary.linter?.tool ?? null;
  if (secondaryLinterTool !== primaryLinterTool) {
    deltas.push(`${repoName} uses ${secondaryLinterTool} linter (primary uses ${primaryLinterTool})`);
  }

  // Different test framework
  const primaryFramework = detectTestFramework(primary.keyDependencies);
  const secondaryFramework = detectTestFramework(secondary.keyDependencies);
  if (secondaryFramework !== primaryFramework) {
    deltas.push(`${repoName} uses ${secondaryFramework} for testing (primary uses ${primaryFramework})`);
  }

  // Different import style
  if (secondary.importStyle !== primary.importStyle) {
    deltas.push(`${repoName} uses ${secondary.importStyle} imports (primary uses ${primary.importStyle})`);
  }

  // Error utilities present in secondary but not primary
  for (const errorPath of secondary.errorHandlingPaths) {
    if (!primary.errorHandlingPaths.includes(errorPath)) {
      deltas.push(`${repoName} has error utility at ${errorPath}`);
    }
  }

  // Different naming pattern
  if (secondary.namingPattern !== primary.namingPattern) {
    deltas.push(`${repoName} uses ${secondary.namingPattern} naming (primary uses ${primary.namingPattern})`);
  }

  // NestJS presence differs
  if (secondary.nestjsDetected && !primary.nestjsDetected) {
    deltas.push(`${repoName} uses NestJS`);
  } else if (!secondary.nestjsDetected && primary.nestjsDetected) {
    deltas.push(`${repoName} does not use NestJS (primary does)`);
  }

  // Different TypeScript strictness
  if (
    secondary.typescript !== null &&
    primary.typescript !== null &&
    secondary.typescript.strict !== primary.typescript.strict
  ) {
    if (!secondary.typescript.strict && primary.typescript.strict) {
      deltas.push(`${repoName} uses non-strict TypeScript (primary uses strict)`);
    }
  }

  // Go module info when primary is not Go
  if (secondary.go !== null && primary.language !== 'go') {
    deltas.push(`${repoName} is a Go module: ${secondary.go.modulePath}`);
  }

  // Terraform info when primary is not Terraform
  if (secondary.terraform !== null && primary.language !== 'terraform') {
    const providers = secondary.terraform.providers.join(', ');
    deltas.push(`${repoName} uses Terraform providers: ${providers}`);
  }

  return deltas;
};

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
