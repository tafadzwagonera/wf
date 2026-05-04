import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildPlanArtifactFilename,
  buildPlanArtifactManifest,
  readPlanArtifactManifest,
  writePlanArtifactManifest,
} from '../src/shared/utils/plan-artifact';
import type { ResolutionAction } from '../src/agents/interfaces';

const SHORT_HASHED_PLAN_REGEX =
  /^([a-f0-9]+)-(feature|fix|investigate)-plan\.(json|md|yaml|yml)$/i;

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

const runMigration = (options: MigrationOptions = {}): MigrationSummary => {
  const rootDir = options.rootDir ?? path.join(os.homedir(), '.wf');
  const summary: MigrationSummary = {
    convertedCount: 0,
    unchangedCount: 0,
    skippedCount: 0,
    failedCount: 0,
  };

  const candidateFiles = walkFiles(rootDir).filter((filePath) =>
    SHORT_HASHED_PLAN_REGEX.test(path.basename(filePath)),
  );

  for (const sourcePath of candidateFiles) {
    const sourceName = path.basename(sourcePath);
    const match = sourceName.match(SHORT_HASHED_PLAN_REGEX);
    if (!match) continue;

    const [, hash, action, extension] = match as [
      string,
      string,
      ResolutionAction,
      'json' | 'md' | 'yaml' | 'yml',
    ];
    const manifestPath = sourcePath.replace(/\.[^.]+$/, '.sources.json');

    try {
      const createdAt = deriveCreatedAt(sourcePath, manifestPath);
      const targetName = buildPlanArtifactFilename({
        createdAt,
        hash,
        action,
        format: extension,
      });
      const targetPath = path.join(path.dirname(sourcePath), targetName);

      if (targetPath === sourcePath) {
        summary.unchangedCount += 1;
        continue;
      }

      if (fs.existsSync(targetPath)) {
        const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
        const targetContent = fs.readFileSync(targetPath, 'utf-8');
        if (sourceContent !== targetContent) {
          summary.skippedCount += 1;
          continue;
        }

        if (!options.dryRun) {
          fs.unlinkSync(sourcePath);
          if (fs.existsSync(manifestPath)) {
            fs.unlinkSync(manifestPath);
          }
        }
        summary.convertedCount += 1;
        continue;
      }

      const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
      if (!options.dryRun) {
        fs.writeFileSync(targetPath, sourceContent, 'utf-8');
      }

      const existingManifest = readPlanArtifactManifest(manifestPath);
      const sourceKind = existingManifest?.sourceKind ?? 'ticket';
      const sourceToken = existingManifest?.sourceName ?? hash;
      const migratedManifest = buildPlanArtifactManifest(
        targetPath,
        action,
        extension,
        hash,
        sourceToken,
        sourceKind,
        createdAt,
        existingManifest?.platformName,
      );
      if (!options.dryRun) {
        writePlanArtifactManifest(migratedManifest);
        fs.unlinkSync(sourcePath);
        if (fs.existsSync(manifestPath)) {
          fs.unlinkSync(manifestPath);
        }
      }
      summary.convertedCount += 1;
    } catch {
      summary.failedCount += 1;
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
