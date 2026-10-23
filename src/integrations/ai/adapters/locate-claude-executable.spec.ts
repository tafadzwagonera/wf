import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { isNodeOnPath, locateClaudeExecutable } from './locate-claude-executable';

jest.mock('node:child_process', () => ({ execFileSync: jest.fn() }));
jest.mock('node:fs', () => ({ ...jest.requireActual('node:fs'), realpathSync: jest.fn() }));

describe('locate-claude-executable', () => {
  const mockExecFileSync = execFileSync as jest.Mock;
  const mockRealpathSync = fs.realpathSync as unknown as jest.Mock;

  afterEach(() => {
    jest.restoreAllMocks();
    mockExecFileSync.mockReset();
    mockRealpathSync.mockReset();
  });

  it('returns the real path of the claude found on PATH', () => {
    mockExecFileSync.mockReturnValue('/usr/local/bin/claude\n');
    mockRealpathSync.mockReturnValue('/opt/claude/bin/claude');

    expect(locateClaudeExecutable()).toBe('/opt/claude/bin/claude');
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync.mock.calls[0][1]).toEqual(['-c', 'command -v claude']);
    expect(mockRealpathSync.mock.calls[0]).toEqual(['/usr/local/bin/claude']);
  });

  it('returns undefined when claude is not on PATH', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('exit 1');
    });

    expect(locateClaudeExecutable()).toBeUndefined();
    expect(mockRealpathSync).not.toHaveBeenCalled();
  });

  it('reports whether node is on PATH', () => {
    mockExecFileSync.mockReturnValueOnce('/usr/bin/node\n');
    expect(isNodeOnPath()).toBe(true);

    mockExecFileSync.mockReturnValueOnce('');
    expect(isNodeOnPath()).toBe(false);
  });
});
