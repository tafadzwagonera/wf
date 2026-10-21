import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildPlanArtifactFilename,
  buildPlanArtifactManifest,
  readPlanArtifactManifest,
  writePlanArtifactManifest,
} from '../src/common/utils/plan-artifact';
import type { ResolutionAction } from '../src/agents/interfaces';

const SHORT_HASHED_PLAN_REGEX
  = /^([a-f0-9]+)-(feature|fix|investigate)-plan\.(json|md|yaml|yml)$/i;

interface MigrationOptions {
  rootDir?: string;
  dryRun?: boolean;
}

interface MigrationSummary {
  convertedCount: number;
  unchangedCount: number;
  skippedCount: number;
  failedCount: number;
}

const walkFiles = (dirPath: string): string[] => {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  return entries.flatMap(entry => {
    const childPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) return walkFiles(childPath);
    return entry.isFile() ? [childPath] : [];
  });
};

const deriveCreatedAt = (
  sourcePath: string,
  manifestPath: string,
): Date => {
  const manifest = readPlanArtifactManifest(manifestPath);
  if (manifest?.createdAt) {
    const parsed = new Date(manifest.createdAt);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return fs.statSync(sourcePath).mtime;
};

type MigrationOutcome = 'converted' | 'unchanged' | 'skipped' | 'failed';

interface ParsedPlanFile {
  hash: string;
  action: ResolutionAction;
  extension: 'json' | 'md' | 'yaml' | 'yml';
  manifestPath: string;
}

const parsePlanFile = (sourcePath: string): ParsedPlanFile | null => {
  const match = SHORT_HASHED_PLAN_REGEX.exec(path.basename(sourcePath));
  if (!match) return null;
  const [, hash, action, extension] = match as unknown as [
    string, string, ResolutionAction, 'json' | 'md' | 'yaml' | 'yml',
  ];
  return { hash, action, extension, manifestPath: sourcePath.replace(/\.[^.]+$/, '.sources.json') };
};

const removeSourceArtifacts = (sourcePath: string, manifestPath: string): void => {
  fs.unlinkSync(sourcePath);
  if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
};

const migrateExistingTarget = (
  sourcePath: string, targetPath: string, manifestPath: string, dryRun: boolean | undefined
): 'converted' | 'skipped' => {
  const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
  const targetContent = fs.readFileSync(targetPath, 'utf-8');
  if (sourceContent !== targetContent) return 'skipped';
  if (!dryRun) removeSourceArtifacts(sourcePath, manifestPath);
  return 'converted';
};

const buildMigratedManifest = (targetPath: string, parsed: ParsedPlanFile, createdAt: Date) => {
  const existingManifest = readPlanArtifactManifest(parsed.manifestPath);
  return buildPlanArtifactManifest({
    artifactPath: targetPath, action: parsed.action, format: parsed.extension, hash: parsed.hash,
    sourceName: existingManifest?.sourceName ?? parsed.hash, sourceKind: existingManifest?.sourceKind ?? 'ticket',
    createdAt, trackerName: existingManifest?.trackerName,
  });
};

const migrateNewTarget = (
  sourcePath: string, targetPath: string, parsed: ParsedPlanFile, createdAt: Date, dryRun: boolean | undefined
): void => {
  const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
  if (!dryRun) fs.writeFileSync(targetPath, sourceContent, 'utf-8');
  if (!dryRun) {
    writePlanArtifactManifest(buildMigratedManifest(targetPath, parsed, createdAt));
    removeSourceArtifacts(sourcePath, parsed.manifestPath);
  }
};

const resolveTargetPath = (sourcePath: string, parsed: ParsedPlanFile, createdAt: Date): string => {
  const targetName = buildPlanArtifactFilename({
    createdAt, hash: parsed.hash, action: parsed.action, format: parsed.extension,
  });
  return path.join(path.dirname(sourcePath), targetName);
};

const migrateResolvedFile = (
  sourcePath: string, parsed: ParsedPlanFile, options: MigrationOptions
): MigrationOutcome => {
  const createdAt = deriveCreatedAt(sourcePath, parsed.manifestPath);
  const targetPath = resolveTargetPath(sourcePath, parsed, createdAt);
  if (targetPath === sourcePath) return 'unchanged';
  if (fs.existsSync(targetPath)) {
    return migrateExistingTarget(sourcePath, targetPath, parsed.manifestPath, options.dryRun);
  }
  migrateNewTarget(sourcePath, targetPath, parsed, createdAt, options.dryRun);
  return 'converted';
};

const migratePlanFile = (sourcePath: string, options: MigrationOptions): MigrationOutcome | null => {
  const parsed = parsePlanFile(sourcePath);
  if (!parsed) return null;
  try {
    return migrateResolvedFile(sourcePath, parsed, options);
  } catch {
    return 'failed';
  }
};

const tallyOutcome = (summary: MigrationSummary, outcome: MigrationOutcome): void => {
  if (outcome === 'converted') summary.convertedCount += 1;
  else if (outcome === 'unchanged') summary.unchangedCount += 1;
  else if (outcome === 'skipped') summary.skippedCount += 1;
  else summary.failedCount += 1;
};

const createEmptySummary = (): MigrationSummary => ({
  convertedCount: 0, unchangedCount: 0, skippedCount: 0, failedCount: 0,
});

const findCandidateFiles = (rootDir: string): string[] =>
  walkFiles(rootDir).filter(filePath => SHORT_HASHED_PLAN_REGEX.test(path.basename(filePath)));

const runMigration = (options: MigrationOptions = {}): MigrationSummary => {
  const rootDir = options.rootDir ?? path.join(os.homedir(), '.wf');
  const summary = createEmptySummary();

  for (const sourcePath of findCandidateFiles(rootDir)) {
    const outcome = migratePlanFile(sourcePath, options);
    if (outcome) tallyOutcome(summary, outcome);
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
    JSON.stringify(
      {
        rootDir: rootDir ?? path.join(os.homedir(), '.wf'),
        dryRun,
        ...summary,
      },
      null,
      2,
    ),
  );
}

export { runMigration };
