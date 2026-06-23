import { buildPlanContext } from './shared-routing';
import { normalizeFileEntries } from '../ai.service';
import type { VerificationScript } from '../../../agents/interfaces';

describe('normalizeFileEntries', () => {
  it('converts string entries to FileEntry with status found', () => {
    const result = normalizeFileEntries(['src/a.ts', 'src/b.ts']);
    expect(result).toEqual([
      { filePath: 'src/a.ts', status: 'found' },
      { filePath: 'src/b.ts', status: 'found' },
    ]);
  });

  it('passes through FileEntry objects unchanged', () => {
    const entries = [
      { filePath: 'src/a.ts', status: 'found' as const },
      { filePath: 'src/b.ts', status: 'to-create' as const },
    ];
    const result = normalizeFileEntries(entries);
    expect(result).toEqual(entries);
  });

  it('handles mixed string and FileEntry arrays', () => {
    const result = normalizeFileEntries([
      'src/a.ts',
      { filePath: 'src/b.ts', status: 'to-create' as const },
    ]);
    expect(result).toEqual([
      { filePath: 'src/a.ts', status: 'found' },
      { filePath: 'src/b.ts', status: 'to-create' },
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(normalizeFileEntries([])).toEqual([]);
  });
});

describe('buildPlanContext', () => {
  const baseParams = {
    ticketKey: 'WBP-1',
    repoDir: '/tmp/repo-a',
    repoName: 'repo-a',
    repoFiles: ['repo-a/src/example.ts'],
    trackedFilePaths: ['repo-a/src/example.ts'],
    verificationScripts: [
      { id: 'build', command: 'yarn build', policy: 'enforced' },
    ] as VerificationScript[],
    planSteps: ['Update source file', 'Add tests'],
    planSummary: 'Fix the widget',
    planAction: 'fix' as const,
  };

  it('produces correct output with all fields', () => {
    const result = buildPlanContext({
      ...baseParams,
      contextFiles: ['repo-a/package.json'],
      planRisks: ['May break build'],
    });

    expect(result).toContain('Repository directory: /tmp/repo-a');
    expect(result).toContain('Ticket key: WBP-1');
    expect(result).toContain('Fix the widget');
    expect(result).toContain('1. Update source file');
    expect(result).toContain('2. Add tests');
    expect(result).toContain('src/example.ts');
    expect(result).toContain('yarn build');
    expect(result).toContain('bug fix');
  });

  it('omits context files section when empty', () => {
    const result = buildPlanContext({ ...baseParams, contextFiles: [] });
    expect(result).not.toContain('Files for context');
  });

  it('omits context files section when undefined', () => {
    const result = buildPlanContext(baseParams);
    expect(result).not.toContain('Files for context');
  });

  it('includes context files section when non-empty', () => {
    const result = buildPlanContext({
      ...baseParams,
      contextFiles: ['repo-a/package.json', 'repo-a/tsconfig.json'],
    });
    expect(result).toContain(
      'Files for context (read-only — do NOT edit these):',
    );
    expect(result).toContain('package.json');
    expect(result).toContain('tsconfig.json');
  });

  it('renders feature action description', () => {
    const result = buildPlanContext({
      ...baseParams,
      planAction: 'feature',
    });
    expect(result).toContain('new feature');
  });

  it('renders not specified for unknown action', () => {
    const result = buildPlanContext({
      ...baseParams,
      planAction: undefined,
    });
    expect(result).toContain('(not specified)');
  });

  it('shows (none) when planSummary is empty', () => {
    const result = buildPlanContext({
      ...baseParams,
      planSummary: undefined,
    });
    expect(result).toContain('Plan summary:\n(none)');
  });
});
