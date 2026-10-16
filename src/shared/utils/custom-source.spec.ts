import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveCustomSourcePath } from './custom-source';
import * as wfPaths from './wf-paths';
import { createTempDir as createManagedTempDir } from '../testing/temp-dir';

describe('resolveCustomSourcePath', () => {
  let wfHomeDir: string;
  let repoOneDir: string;
  let repoTwoDir: string;

  beforeEach(() => {
    wfHomeDir = createManagedTempDir('home');
    repoOneDir = createManagedTempDir('repo-one');
    repoTwoDir = createManagedTempDir('repo-two');
    jest.spyOn(wfPaths, 'getWfHomeDir').mockReturnValue(path.join(wfHomeDir, '.wf'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(wfHomeDir, { recursive: true, force: true });
    fs.rmSync(repoOneDir, { recursive: true, force: true });
    fs.rmSync(repoTwoDir, { recursive: true, force: true });
  });

  it('returns an existing absolute source path unchanged', () => {
    const absoluteSource = path.join(repoOneDir, 'plan.md');
    fs.writeFileSync(absoluteSource, 'plan');

    expect(resolveCustomSourcePath(absoluteSource, repoOneDir)).toBe(absoluteSource);
  });

  it('throws a not-found AppError when an absolute source does not exist', () => {
    const absoluteSource = path.join(repoOneDir, 'missing.md');

    expect(() => resolveCustomSourcePath(absoluteSource, repoOneDir)).toThrow(
      `Custom source not found: ${absoluteSource}`
    );
  });

  it('resolves a filename-only source against the single matching repo', () => {
    const repoOneName = path.basename(repoOneDir);
    const artifactDir = path.join(wfHomeDir, '.wf', repoOneName);
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'plan.md'), 'plan');

    const resolved = resolveCustomSourcePath('plan.md', repoOneDir, [repoOneDir]);

    expect(resolved).toBe(path.join(artifactDir, 'plan.md'));
  });

  it('throws an AppError when the source matches multiple repositories', () => {
    const repoOneName = path.basename(repoOneDir);
    const repoTwoName = path.basename(repoTwoDir);
    const artifactDirOne = path.join(wfHomeDir, '.wf', repoOneName);
    const artifactDirTwo = path.join(wfHomeDir, '.wf', repoTwoName);
    fs.mkdirSync(artifactDirOne, { recursive: true });
    fs.mkdirSync(artifactDirTwo, { recursive: true });
    fs.writeFileSync(path.join(artifactDirOne, 'plan.md'), 'plan');
    fs.writeFileSync(path.join(artifactDirTwo, 'plan.md'), 'plan');

    expect(() => resolveCustomSourcePath('plan.md', repoOneDir, [repoOneDir, repoTwoDir])).toThrow(
      /matches multiple repositories/
    );
  });

  it('falls back to the base directory artifact dir when no repo matches', () => {
    const baseArtifactDir = path.join(wfHomeDir, '.wf', path.basename(repoOneDir));
    fs.mkdirSync(baseArtifactDir, { recursive: true });
    fs.writeFileSync(path.join(baseArtifactDir, 'plan.md'), 'plan');

    const resolved = resolveCustomSourcePath('plan.md', repoOneDir, [repoTwoDir]);

    expect(resolved).toBe(path.join(baseArtifactDir, 'plan.md'));
  });

  it('throws a not-found AppError when the artifact does not exist anywhere', () => {
    const baseArtifactDir = path.join(wfHomeDir, '.wf', path.basename(repoOneDir));

    expect(() => resolveCustomSourcePath('missing.md', repoOneDir)).toThrow(
      'not found in artifact repository'
    );
  });
});
