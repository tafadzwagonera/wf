import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readPlanArtifactManifest, writePlanArtifactManifest } from '../src/shared/utils/plan-artifact';

const KNOWN_TRACKER_DIRS = new Set(['jira', 'bitbucket']);
const PLAN_MANIFEST_SUFFIX = '.sources.json';

interface MigrationOptions {
  rootDir?: string;
  dryRun?: boolean;
}

interface MigrationSummary {
  updatedCount: number;
  skippedCount: number;
  alreadyCorrectCount: number;
  failedCount: number;
  details: MigrationDetail[];
}

interface MigrationDetail {
  manifestPath: string;
  status: 'updated' | 'skipped' | 'already_correct' | 'failed';
  reason?: string;
}

/**
 * Walk a directory tree and return all file paths.
 *
 * @param dirPath - Root directory to walk
 * @returns All file paths found recursively
 */
const walkFiles = (dirPath: string): string[] => {
  if (!fs.existsSync(dirPath)) return [];

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const childPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(childPath));
      continue;
    }
    if (entry.isFile()) {
      files.push(childPath);
    }
  }
  return files;
};

/**
 * Determine whether a manifest lives under a known tracker subdirectory.
 *
 * Layout:
 *   ~/.wf/<repo>/jira/<manifest>      → tracker-sourced (ticket)
 *   ~/.wf/<repo>/bitbucket/<manifest>  → tracker-sourced (ticket)
 *   ~/.wf/<repo>/<manifest>            → custom-sourced
 *
 * @param manifestPath - Absolute path to the manifest file
 * @param rootDir - The ~/.wf root directory
 * @returns True when the manifest is inside a tracker subdirectory
 */
const isUnderTrackerDir = (manifestPath: string, rootDir: string): boolean => {
  const relative = path.relative(rootDir, manifestPath);
  const segments = relative.split(path.sep);
  // segments: [<repo>, <trackerOrFile>, ...] or [<repo>, <tracker>, <file>]
  return segments.length >= 3 && KNOWN_TRACKER_DIRS.has(segments[1]);
};

/**
 * Migrate custom plan manifests that were incorrectly stamped with
 * `sourceKind: 'ticket'` to `sourceKind: 'custom'`.
 *
 * The bug: `PlanStageService.createPlanArtifact` hardcodes `'ticket'` as the
 * `sourceKind` regardless of whether the ticket artifact was synthetic (built
 * from `--custom-plan`). Custom plan artifacts live directly under
 * `~/.wf/<repo>/` (not under a tracker subdirectory like `jira/`), so we use
 * directory position as the source of truth.
 *
 * @param options - Migration options
 * @returns Summary of what was migrated
 */
const runMigration = (options: MigrationOptions = {}): MigrationSummary => {
  const rootDir = options.rootDir ?? path.join(os.homedir(), '.wf');
  const summary: MigrationSummary = {
    updatedCount: 0,
    skippedCount: 0,
    alreadyCorrectCount: 0,
    failedCount: 0,
    details: [],
  };

  const manifestPaths = walkFiles(rootDir).filter(
    filePath => filePath.endsWith(PLAN_MANIFEST_SUFFIX) && !isUnderTrackerDir(filePath, rootDir),
  );

  for (const manifestPath of manifestPaths) {
    try {
      const manifest = readPlanArtifactManifest(manifestPath);
      if (!manifest) {
        summary.skippedCount += 1;
        summary.details.push({ manifestPath, status: 'skipped', reason: 'unreadable or invalid manifest' });
        continue;
      }

      if (manifest.sourceKind === 'custom') {
        summary.alreadyCorrectCount += 1;
        summary.details.push({ manifestPath, status: 'already_correct' });
        continue;
      }

      if (manifest.sourceKind !== 'ticket') {
        summary.skippedCount += 1;
        summary.details.push({ manifestPath, status: 'skipped', reason: `unexpected sourceKind: ${manifest.sourceKind}` });
        continue;
      }

      const corrected = {
        ...manifest,
        sourceKind: 'custom' as const,
        ticketKey: undefined,
        customArtifactName: manifest.sourceName,
      };

      if (!options.dryRun) {
        writePlanArtifactManifest(corrected);
      }

      summary.updatedCount += 1;
      summary.details.push({ manifestPath, status: 'updated' });
    } catch (error) {
      summary.failedCount += 1;
      summary.details.push({
        manifestPath,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
};

if (require.main === module) {
  const rootArgIndex = process.argv.indexOf('--root');
  const rootDir =
    rootArgIndex >= 0 && process.argv[rootArgIndex + 1]
      ? process.argv[rootArgIndex + 1]
      : undefined;
  const dryRun = process.argv.includes('--dry-run');
  const verbose = process.argv.includes('--verbose');

  const summary = runMigration({ rootDir, dryRun });

  const output: Record<string, unknown> = {
    rootDir: rootDir ?? path.join(os.homedir(), '.wf'),
    dryRun,
    updatedCount: summary.updatedCount,
    alreadyCorrectCount: summary.alreadyCorrectCount,
    skippedCount: summary.skippedCount,
    failedCount: summary.failedCount,
  };

  if (verbose) {
    output.details = summary.details;
  }

  console.log(JSON.stringify(output, null, 2));
}

export { runMigration };
