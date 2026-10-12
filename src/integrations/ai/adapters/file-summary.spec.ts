import { logFileSummary } from './file-summary';

describe('logFileSummary', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  const loggedLines = (): string[] => logSpy.mock.calls.map(([line]) => String(line));

  it('logs a File summary heading with sorted updated-file entries', () => {
    logFileSummary(new Set(['src/b.ts', 'src/a.ts']));

    expect(loggedLines()).toEqual([
      '\n  File summary:',
      '    - updated: src/a.ts',
      '    - updated: src/b.ts',
    ]);
  });

  it('logs that no file changes were made when the set is empty', () => {
    logFileSummary(new Set());

    expect(loggedLines()).toEqual(['\n  File summary: no file changes were made.']);
  });

  it('renders declared-only entries distinctly', () => {
    logFileSummary(new Set(['src/a.ts']), new Set(['src/b.ts']));

    expect(loggedLines()).toEqual([
      '\n  File summary:',
      '    - updated: src/a.ts',
      '    - no change required (agent-declared): src/b.ts',
    ]);
  });

  it('lets touched entries win on overlap', () => {
    logFileSummary(new Set(['src/a.ts']), new Set(['src/a.ts']));

    expect(loggedLines()).toEqual(['\n  File summary:', '    - updated: src/a.ts']);
  });

  it('prints the summary when only declarations exist', () => {
    logFileSummary(new Set(), new Set(['src/b.ts']));

    expect(loggedLines()).toEqual(['\n  File summary:', '    - no change required (agent-declared): src/b.ts']);
  });
});
