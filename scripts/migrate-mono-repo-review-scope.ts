import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { supportedPlanExtensions } from '../src/shared/utils/plan-artifact';

interface MigrationOptions {
  rootDir?: string;
  dryRun?: boolean;
}

interface MigrationSummary {
  renamedCount: number;
  skippedMultiRepoCount: number;
  skippedCollisionCount: number;
  failedCount: number;
}

interface ScopedReviewFile {
  directory: string;
  fileName: string;
  stem: string;
  extension: string;
}

const extensionPattern = supportedPlanExtensions.join('|');

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const listArtifactDirectories = (rootDir: string): { repoName: string; directory: string }[] => {
  if (!fs.existsSync(rootDir)) return [];
  return fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(repoEntry => {
      const repoDir = path.join(rootDir, repoEntry.name);
      const trackerDirs = fs
        .readdirSync(repoDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => ({ repoName: repoEntry.name, directory: path.join(repoDir, entry.name) }));
      return [{ repoName: repoEntry.name, directory: repoDir }, ...trackerDirs];
    });
};

const findScopedReviewFiles = (directory: string, repoName: string): ScopedReviewFile[] => {
  const scopedPattern = new RegExp(`^(.+)-${escapeRegExp(repoName)}-review\\.(${extensionPattern})$`);
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .flatMap(entry => {
      const match = scopedPattern.exec(entry.name);
      if (!match) return [];
      return [{ directory, fileName: entry.name, stem: match[1], extension: match[2] }];
    });
};

const hasOtherScopeSibling = (candidate: ScopedReviewFile, repoName: string): boolean => {
  const siblingPattern = new RegExp(
    `^${escapeRegExp(candidate.stem)}-(.+)-review\\.(${extensionPattern})$`
  );
  return fs.readdirSync(candidate.directory).some(name => {
    const match = siblingPattern.exec(name);
    return match !== null && match[1] !== repoName;
  });
};

const hasUnscopedCollision = (candidate: ScopedReviewFile): boolean =>
  supportedPlanExtensions.some(extension =>
    fs.existsSync(path.join(candidate.directory, `${candidate.stem}-review.${extension}`))
  );

const resolveSkipOutcome = (
  candidate: ScopedReviewFile, repoName: string, sourcePath: string
): 'skippedMultiRepoCount' | 'skippedCollisionCount' | null => {
  if (hasOtherScopeSibling(candidate, repoName)) {
    console.log(`skip (multi-repo siblings): ${sourcePath}`);
    return 'skippedMultiRepoCount';
  }
  if (hasUnscopedCollision(candidate)) {
    console.log(`skip (unscoped artifact already exists): ${sourcePath}`);
    return 'skippedCollisionCount';
  }
  return null;
};

const renameReviewFile = (
  candidate: ScopedReviewFile, sourcePath: string, dryRun: boolean
): 'renamedCount' | 'failedCount' => {
  const targetPath = path.join(candidate.directory, `${candidate.stem}-review.${candidate.extension}`);
  try {
    if (!dryRun) fs.renameSync(sourcePath, targetPath);
    console.log(`${dryRun ? 'would rename' : 'renamed'}: ${sourcePath} -> ${targetPath}`);
    return 'renamedCount';
  } catch (error) {
    console.error(`failed: ${sourcePath} (${error instanceof Error ? error.message : String(error)})`);
    return 'failedCount';
  }
};

const migrateFile = (
  candidate: ScopedReviewFile, repoName: string, dryRun: boolean
): keyof MigrationSummary => {
  const sourcePath = path.join(candidate.directory, candidate.fileName);
  return resolveSkipOutcome(candidate, repoName, sourcePath) ?? renameReviewFile(candidate, sourcePath, dryRun);
};

/**
 * Drops the repo-scope suffix from mono-repo review artifacts.
 *
 * Since commit cc05b4a0, the reviewer agent suffixed every review artifact with the repo
 * basename (`<stem>-<repo>-review.<ext>`), even in mono-repo runs where the suffix serves no
 * purpose and desynchronises the artifact from its unscoped commit-description sidecar. The
 * suffix is intentional only for multi-repo runs, where sibling artifacts for the same stem
 * carry different repo scopes; such files are detected and left untouched.
 *
 * @param options.rootDir - wf home directory to migrate; defaults to `~/.wf`
 * @param options.dryRun - report intended renames without touching the filesystem
 * @returns Counts of renamed, skipped, and failed files
 */
const runMigration = (options: MigrationOptions = {}): MigrationSummary => {
  const rootDir = options.rootDir ?? path.join(os.homedir(), '.wf');
  const dryRun = options.dryRun ?? false;
  const summary: MigrationSummary = {
    renamedCount: 0, skippedMultiRepoCount: 0, skippedCollisionCount: 0, failedCount: 0,
  };
  for (const { repoName, directory } of listArtifactDirectories(rootDir)) {
    for (const candidate of findScopedReviewFiles(directory, repoName)) {
      summary[migrateFile(candidate, repoName, dryRun)] += 1;
    }
  }
  return summary;
};

if (require.main === module) {
  const rootArgIndex = process.argv.indexOf('--root');
  const rootDir
    = rootArgIndex >= 0 && process.argv[rootArgIndex + 1]
      ? process.argv[rootArgIndex + 1]
      : undefined;
  const dryRun = process.argv.includes('--dry-run');
  const summary = runMigration({ rootDir, dryRun });
  console.log(
    JSON.stringify({ rootDir: rootDir ?? path.join(os.homedir(), '.wf'), dryRun, ...summary }, null, 2)
  );
}

export { runMigration };
