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

  it('resolves a relative source inside the base directory artifact namespace', () => {
    const artifactDir = path.join(wfHomeDir, '.wf', path.basename(repoOneDir));
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'plan.md'), 'plan');

    expect(resolveCustomSourcePath('plan.md', repoOneDir)).toBe(path.join(artifactDir, 'plan.md'));
  });

  it('does not search the artifact namespace of any other repository', () => {
    const otherArtifactDir = path.join(wfHomeDir, '.wf', path.basename(repoTwoDir));
    fs.mkdirSync(otherArtifactDir, { recursive: true });
    fs.writeFileSync(path.join(otherArtifactDir, 'plan.md'), 'plan');

    expect(() => resolveCustomSourcePath('plan.md', repoOneDir)).toThrow('not found in artifact repository');
  });

  it('throws a not-found AppError when the artifact does not exist anywhere', () => {
    expect(() => resolveCustomSourcePath('missing.md', repoOneDir)).toThrow(
      'not found in artifact repository'
    );
  });
});
