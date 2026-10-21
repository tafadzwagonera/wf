import * as fs from 'fs';
import * as path from 'path';
import { sessionStateSchema } from '../src/common/schemas/session.schema';
import { buildSessionFileName } from '../src/common/utils/session-file-name';
import { getWfSessionDir } from '../src/common/utils/wf-paths';

interface MigrationOptions {
  rootDir?: string;
  dryRun?: boolean;
}

interface MigrationSummary {
  converted: number;
  unchanged: number;
  skipped: number;
  failed: number;
}

type MigrationOutcome = keyof MigrationSummary;

const sessionIdentitySchema = sessionStateSchema.pick({ ticketKey: true, sessionId: true });

const isSessionFileName = (fileName: string): boolean =>
  fileName.endsWith('.json') && !fileName.endsWith('.items.json');

const deriveCreatedAt = (filePath: string, content: { createdAt?: unknown }): string => {
  if (typeof content.createdAt === 'string' && !Number.isNaN(new Date(content.createdAt).getTime())) {
    return content.createdAt;
  }
  return fs.statSync(filePath).mtime.toISOString();
};

const skip = (fileName: string, reason: string): MigrationOutcome => {
  console.warn(`Skipped ${fileName}: ${reason}`);
  return 'skipped';
};

const migrateFile = (rootDir: string, fileName: string, dryRun: boolean | undefined): MigrationOutcome => {
  const sourcePath = path.join(rootDir, fileName);
  const content = JSON.parse(fs.readFileSync(sourcePath, 'utf-8'));
  const identity = sessionIdentitySchema.safeParse(content);
  if (!identity.success) return skip(fileName, 'missing ticketKey or sessionId');

  const targetName = buildSessionFileName({ ...identity.data, createdAt: deriveCreatedAt(sourcePath, content) });
  if (targetName === fileName) return 'unchanged';

  const targetPath = path.join(rootDir, targetName);
  if (fs.existsSync(targetPath)) return skip(fileName, `${targetName} already exists`);
  if (!dryRun) fs.renameSync(sourcePath, targetPath);
  return 'converted';
};

const safeMigrateFile = (rootDir: string, fileName: string, dryRun: boolean | undefined): MigrationOutcome => {
  try {
    return migrateFile(rootDir, fileName, dryRun);
  } catch (error) {
    console.error(`Failed to migrate ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
    return 'failed';
  }
};

const runMigration = (options: MigrationOptions = {}): MigrationSummary => {
  const rootDir = options.rootDir ?? getWfSessionDir();
  const summary: MigrationSummary = { converted: 0, unchanged: 0, skipped: 0, failed: 0 };
  if (!fs.existsSync(rootDir)) return summary;

  for (const fileName of fs.readdirSync(rootDir).filter(isSessionFileName)) {
    summary[safeMigrateFile(rootDir, fileName, options.dryRun)] += 1;
  }
  return summary;
};

if (require.main === module) {
  const rootArgIndex = process.argv.indexOf('--root');
  const rootDir = rootArgIndex >= 0 && process.argv[rootArgIndex + 1]
    ? process.argv[rootArgIndex + 1]
    : undefined;
  const dryRun = process.argv.includes('--dry-run');
  const summary = runMigration({ rootDir, dryRun });
  console.log(JSON.stringify({ rootDir: rootDir ?? getWfSessionDir(), dryRun, ...summary }, null, 2));
}

export { runMigration };
