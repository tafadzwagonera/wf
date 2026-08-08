import * as fs from 'node:fs';
import { discoverDirAgentConfigs, PROVIDER_CONFIG_FILENAMES } from './discover-dir-agent-configs';

jest.mock('node:fs');

const mockExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;

beforeEach(() => {
  mockExistsSync.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('PROVIDER_CONFIG_FILENAMES', () => {
  it('maps each provider to expected filename', () => {
    expect(PROVIDER_CONFIG_FILENAMES).toEqual({
      anthropic: 'CLAUDE.md',
      openai: 'AGENTS.md',
      google: 'GEMINI.md',
      deepseek: 'DEEPSEEK.md',
    });
  });
});

describe('discoverDirAgentConfigs', () => {
  const repoBaseDir = '/projects';

  it('returns empty array when filePaths is empty', () => {
    expect(discoverDirAgentConfigs([], 'anthropic', repoBaseDir)).toEqual([]);
    expect(mockExistsSync).not.toHaveBeenCalled();
  });

  it('discovers CLAUDE.md in subdirectory for anthropic provider', () => {
    mockExistsSync.mockReturnValue(true);
    const result = discoverDirAgentConfigs(
      ['wf/src/agents/planner.ts'],
      'anthropic',
      repoBaseDir,
    );
    expect(result).toEqual([
      { filePath: 'wf/src/agents/CLAUDE.md', status: 'found' },
    ]);
    expect(mockExistsSync).toHaveBeenCalledWith('/projects/wf/src/agents/CLAUDE.md');
  });

  it('discovers AGENTS.md for openai provider', () => {
    mockExistsSync.mockReturnValue(true);
    const result = discoverDirAgentConfigs(
      ['wf/src/commands/plan.ts'],
      'openai',
      repoBaseDir,
    );
    expect(result).toEqual([
      { filePath: 'wf/src/commands/AGENTS.md', status: 'found' },
    ]);
  });

  it('discovers GEMINI.md for google provider', () => {
    mockExistsSync.mockReturnValue(true);
    const result = discoverDirAgentConfigs(
      ['wf/src/utils/helper.ts'],
      'google',
      repoBaseDir,
    );
    expect(result).toEqual([
      { filePath: 'wf/src/utils/GEMINI.md', status: 'found' },
    ]);
  });

  it('discovers DEEPSEEK.md for deepseek provider', () => {
    mockExistsSync.mockReturnValue(true);
    const result = discoverDirAgentConfigs(
      ['wf/src/shared/types/config.ts'],
      'deepseek',
      repoBaseDir,
    );
    expect(result).toEqual([
      { filePath: 'wf/src/shared/types/DEEPSEEK.md', status: 'found' },
    ]);
  });

  it('excludes repo-root directory', () => {
    mockExistsSync.mockReturnValue(true);
    const result = discoverDirAgentConfigs(
      ['wf/README.md'],
      'anthropic',
      repoBaseDir,
    );
    expect(result).toEqual([]);
    expect(mockExistsSync).not.toHaveBeenCalled();
  });

  it('excludes config files that do not exist on disk', () => {
    mockExistsSync.mockReturnValue(false);
    const result = discoverDirAgentConfigs(
      ['wf/src/agents/planner.ts'],
      'anthropic',
      repoBaseDir,
    );
    expect(result).toEqual([]);
  });

  it('sorts deepest-first', () => {
    mockExistsSync.mockReturnValue(true);
    const result = discoverDirAgentConfigs(
      ['wf/src/file.ts', 'wf/src/agents/deep/nested/file.ts'],
      'anthropic',
      repoBaseDir,
    );
    expect(result.map(e => e.filePath)).toEqual([
      'wf/src/agents/deep/nested/CLAUDE.md',
      'wf/src/CLAUDE.md',
    ]);
  });

  it('applies alphabetical tiebreaker at same depth', () => {
    mockExistsSync.mockReturnValue(true);
    const result = discoverDirAgentConfigs(
      ['wf/src/zebra/file.ts', 'wf/src/alpha/file.ts'],
      'anthropic',
      repoBaseDir,
    );
    expect(result.map(e => e.filePath)).toEqual([
      'wf/src/alpha/CLAUDE.md',
      'wf/src/zebra/CLAUDE.md',
    ]);
  });

  it('deduplicates directories from multiple files in same dir', () => {
    mockExistsSync.mockReturnValue(true);
    const result = discoverDirAgentConfigs(
      ['wf/src/agents/a.ts', 'wf/src/agents/b.ts'],
      'anthropic',
      repoBaseDir,
    );
    expect(result).toEqual([
      { filePath: 'wf/src/agents/CLAUDE.md', status: 'found' },
    ]);
    expect(mockExistsSync).toHaveBeenCalledTimes(1);
  });
});
