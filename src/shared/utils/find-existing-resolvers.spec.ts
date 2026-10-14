import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendToLogFile } from '../logger/log-file-writer';
import { findConfigReadClusters, findFunctionsByName, gitRunner } from './find-existing-resolvers';

jest.mock('../logger/log-file-writer', () => ({ appendToLogFile: jest.fn() }));

const RESOLVER_SOURCE = [
  'export class Resolver {',
  '  private resolveStageProvider(stage: string) {',
  '    const primary = this.configService.get<string>(`stages.${stage}.provider`);',
  '    return primary ?? this.configService.get<string>(`ai.stages.${stage}.provider`);',
  '  }',
  '}',
  '',
].join('\n');

const git = (cwd: string, args: string[]): void => {
  childProcess.execFileSync('git', args, { cwd, stdio: 'ignore' });
};

const writeFile = (repoDir: string, relativePath: string, content: string): void => {
  const target = path.join(repoDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
};

const createRepo = (): string => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-resolvers-'));
  git(repoDir, ['init', '-q']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  return repoDir;
};

const commitAll = (repoDir: string): void => {
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-q', '-m', 'init']);
};

describe('finding existing config-read resolvers', () => {
  const dirs: string[] = [];
  const track = (dir: string): string => {
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    jest.restoreAllMocks();
    jest.mocked(appendToLogFile).mockClear();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports a cluster for a resolver that reads two keys ending in the leaf', async () => {
    const repoDir = track(createRepo());
    writeFile(repoDir, 'src/resolver.ts', RESOLVER_SOURCE);
    commitAll(repoDir);

    const clusters = await findConfigReadClusters(repoDir, ['provider']);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].file).toBe('src/resolver.ts');
    expect(clusters[0].line).toBe(3);
    expect(clusters[0].count).toBeGreaterThanOrEqual(2);
  });

  it('leaves spec files out of the result', async () => {
    const repoDir = track(createRepo());
    writeFile(repoDir, 'src/resolver.spec.ts', RESOLVER_SOURCE);
    writeFile(repoDir, 'src/other.ts', 'export const a = 1;\n');
    commitAll(repoDir);

    expect(await findConfigReadClusters(repoDir, ['provider'])).toEqual([]);
  });

  it('includes untracked files', async () => {
    const repoDir = track(createRepo());
    writeFile(repoDir, 'src/other.ts', 'export const a = 1;\n');
    commitAll(repoDir);
    writeFile(repoDir, 'src/untracked.ts', RESOLVER_SOURCE);

    const clusters = await findConfigReadClusters(repoDir, ['provider']);

    expect(clusters.map(cluster => cluster.file)).toEqual(['src/untracked.ts']);
  });

  it('returns an empty list for a directory that is not a git repository', async () => {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-nogit-')));
    writeFile(dir, 'src/resolver.ts', RESOLVER_SOURCE);

    expect(await findConfigReadClusters(dir, ['provider'])).toEqual([]);
  });

  it('returns an empty list for a git repository with no commits', async () => {
    const repoDir = track(createRepo());

    expect(await findConfigReadClusters(repoDir, ['provider'])).toEqual([]);
  });

  it('fails open and logs the error message when git fails', async () => {
    const repoDir = track(createRepo());
    jest.spyOn(gitRunner, 'run').mockRejectedValue(new Error('git exploded'));

    const clusters = await findConfigReadClusters(repoDir, ['provider']);

    expect(clusters).toEqual([]);
    expect(appendToLogFile).toHaveBeenCalledTimes(1);
    expect(jest.mocked(appendToLogFile).mock.calls[0][0]).toBe('DEBUG');
    expect(jest.mocked(appendToLogFile).mock.calls[0][1]).toContain('git exploded');
  });

  it('finds the exact-name function definition with its line', async () => {
    const repoDir = track(createRepo());
    writeFile(repoDir, 'src/resolver.ts', RESOLVER_SOURCE);
    commitAll(repoDir);

    const readers = await findFunctionsByName(repoDir, ['resolveStageProvider']);

    expect(readers).toEqual([{ file: 'src/resolver.ts', line: 2, name: 'resolveStageProvider' }]);
  });

  it('returns an empty list for an unknown function name', async () => {
    const repoDir = track(createRepo());
    writeFile(repoDir, 'src/resolver.ts', RESOLVER_SOURCE);
    commitAll(repoDir);

    expect(await findFunctionsByName(repoDir, ['resolveNothing'])).toEqual([]);
  });
});
