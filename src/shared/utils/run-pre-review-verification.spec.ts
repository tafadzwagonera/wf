import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

jest.mock('node:child_process', () => ({ execSync: jest.fn() }));
jest.mock('./post-pull-install', () => ({
  runPostPullDependencyInstall: jest.fn().mockResolvedValue(undefined),
}));

import { execSync } from 'node:child_process';
import { runPostPullDependencyInstall } from './post-pull-install';
import { runPreReviewVerification } from './run-pre-review-verification';
import { createTempDir as createManagedTempDir } from '../testing/temp-dir';

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockInstall = runPostPullDependencyInstall as jest.MockedFunction<typeof runPostPullDependencyInstall>;

describe('runPreReviewVerification', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createManagedTempDir('pre-verify');
    mockInstall.mockResolvedValue(undefined);
    mockExecSync.mockReturnValue(Buffer.from(''));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('returns empty string when no package.json exists', async () => {
    const result = await runPreReviewVerification(tmpDir, { silent: true });
    expect(result).toBe('');
  });

  it('returns empty string when package.json has no standard verification scripts', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    const result = await runPreReviewVerification(tmpDir, { silent: true });
    expect(result).toBe('');
  });

  it('runs available verification scripts and returns a labelled summary', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit' } })
    );

    const result = await runPreReviewVerification(tmpDir, { silent: true });

    expect(result).toMatch(/^Pre-review verification:/);
    expect(result).toContain('lint');
    expect(result).toContain('typecheck');
    expect(mockExecSync).toHaveBeenCalledTimes(2);
  });

  it('marks a failed command with ✗', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' } }));
    mockExecSync.mockImplementation(() => {
      throw new Error('command failed');
    });

    const result = await runPreReviewVerification(tmpDir, { silent: true });

    expect(result).toContain('✗');
    expect(result).not.toContain('✓');
  });

  it('marks a passing command with ✓', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' } }));
    mockExecSync.mockReturnValue(Buffer.from(''));

    const result = await runPreReviewVerification(tmpDir, { silent: true });

    expect(result).toContain('✓');
    expect(result).not.toContain('✗');
  });

  it('calls runPostPullDependencyInstall before running verification commands', async () => {
    const callOrder: string[] = [];
    mockInstall.mockImplementation(async () => {
      callOrder.push('install');
    });
    mockExecSync.mockImplementation(() => {
      callOrder.push('verify');
      return Buffer.from('');
    });
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' } }));

    await runPreReviewVerification(tmpDir, { silent: true });

    expect(callOrder).toEqual(['install', 'verify']);
  });

  it('only runs lint, typecheck, and test scripts — ignores other scripts', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc', start: 'node .', lint: 'eslint .' } })
    );

    await runPreReviewVerification(tmpDir, { silent: true });

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    const [cmd] = mockExecSync.mock.calls[0] as [string, ...unknown[]];
    expect(cmd).toContain('lint');
  });
});
