import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readPlanArtifactManifest, writePlanArtifactManifest } from '../src/common/utils/plan-artifact';
import type { PlanArtifactManifest } from '../src/common/utils/plan-artifact';

const knownTrackerDirs = new Set(['jira', 'bitbucket']);
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

  return fs.readdirSync(dirPath, { withFileTypes: true }).flatMap(entry => {
    const childPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) return walkFiles(childPath);
    return entry.isFile() ? [childPath] : [];
  });
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
  return segments.length >= 3 && knownTrackerDirs.has(segments[1]);
};

const toCustomManifest = (manifest: PlanArtifactManifest): PlanArtifactManifest => ({
  ...manifest,
  sourceKind: 'custom',
  ticketKey: undefined,
  customArtifactName: manifest.sourceName,
});

const migrateManifest = (manifestPath: string, dryRun: boolean): MigrationDetail => {
  const manifest = readPlanArtifactManifest(manifestPath);
  if (!manifest) return { manifestPath, status: 'skipped', reason: 'unreadable or invalid manifest' };
  if (manifest.sourceKind === 'custom') return { manifestPath, status: 'already_correct' };
  if (manifest.sourceKind !== 'ticket') {
    return { manifestPath, status: 'skipped', reason: `unexpected sourceKind: ${manifest.sourceKind}` };
  }
  if (!dryRun) writePlanArtifactManifest(toCustomManifest(manifest));
  return { manifestPath, status: 'updated' };
};

const migrateManifestSafely = (manifestPath: string, dryRun: boolean): MigrationDetail => {
  try {
    return migrateManifest(manifestPath, dryRun);
  } catch (error) {
    return { manifestPath, status: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
};

const countByStatus = (details: MigrationDetail[], status: MigrationDetail['status']): number =>
  details.filter(detail => detail.status === status).length;

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
  const details = walkFiles(rootDir)
    .filter(filePath => filePath.endsWith(PLAN_MANIFEST_SUFFIX) && !isUnderTrackerDir(filePath, rootDir))
    .map(manifestPath => migrateManifestSafely(manifestPath, options.dryRun ?? false));
  return {
    updatedCount: countByStatus(details, 'updated'),
    skippedCount: countByStatus(details, 'skipped'),
    alreadyCorrectCount: countByStatus(details, 'already_correct'),
    failedCount: countByStatus(details, 'failed'),
    details,
  };
};

if (require.main === module) {
  const rootArgIndex = process.argv.indexOf('--root');
  const rootDir
    = rootArgIndex >= 0 && process.argv[rootArgIndex + 1]
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
