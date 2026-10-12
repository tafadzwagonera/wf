import {
  parseDiffFileStats,
  formatDiffStatSummary,
  buildPrioritizedDiffExcerpt,
  isDocsOnlyChangeset,
  extractConventionalType,
  declaresDocsOnlyType,
  splitDiffIntoFileSections,
} from './commit-diff-stat';

const buildDiff = (files: { path: string; addedLines: number }[]): string =>
  files
    .map(f => {
      const added = Array.from({ length: f.addedLines }, (_, i) => `+line ${i}`).join('\n');
      return `diff --git a/${f.path} b/${f.path}\n--- a/${f.path}\n+++ b/${f.path}\n@@ -0,0 +1,${f.addedLines} @@\n${added}`;
    })
    .join('\n');

describe('splitDiffIntoFileSections', () => {
  it('maps each destination path to its own diff section', () => {
    const diff = buildDiff([{ path: 'src/a.ts', addedLines: 1 }, { path: 'src/b.ts', addedLines: 2 }]);
    const sections = splitDiffIntoFileSections(diff);

    expect([...sections.keys()]).toEqual(['src/a.ts', 'src/b.ts']);
    expect(sections.get('src/a.ts')).toContain('+line 0');
    expect(sections.get('src/a.ts')).not.toContain('src/b.ts');
  });

  it('returns an empty map when the diff has no file headers', () => {
    expect(splitDiffIntoFileSections('not a real diff').size).toBe(0);
  });
});

describe('parseDiffFileStats', () => {
  it('counts added and removed lines per file, excluding +++/--- headers', () => {
    const diff = buildDiff([{ path: 'src/a.ts', addedLines: 3 }, { path: 'README.md', addedLines: 1 }]);
    const stats = parseDiffFileStats(diff);

    expect(stats).toEqual(
      expect.arrayContaining([
        { file: 'src/a.ts', changedLines: 3 },
        { file: 'README.md', changedLines: 1 },
      ])
    );
  });

  it('returns an empty array for a diff with no file headers', () => {
    expect(parseDiffFileStats('not a real diff')).toEqual([]);
  });
});

describe('formatDiffStatSummary', () => {
  it('orders files by changed lines descending', () => {
    const summary = formatDiffStatSummary([
      { file: 'small.ts', changedLines: 2 },
      { file: 'big.ts', changedLines: 50 },
    ]);
    const bigIndex = summary.indexOf('big.ts');
    const smallIndex = summary.indexOf('small.ts');
    expect(bigIndex).toBeGreaterThanOrEqual(0);
    expect(bigIndex).toBeLessThan(smallIndex);
  });

  it('includes the total file count', () => {
    const summary = formatDiffStatSummary([{ file: 'a.ts', changedLines: 1 }, { file: 'b.ts', changedLines: 2 }]);
    expect(summary).toContain('Files changed (2)');
  });
});

describe('buildPrioritizedDiffExcerpt', () => {
  it('includes the most-changed file via its own snippet at realistic budget', () => {
    const diff = buildDiff([
      { path: 'docs/readme-note.md', addedLines: 1 },
      { path: 'src/core-logic.ts', addedLines: 40 },
    ]);
    const stats = parseDiffFileStats(diff);

    const excerpt = buildPrioritizedDiffExcerpt(diff, stats, 200);

    expect(excerpt).toContain('diff --git a/src/core-logic.ts b/src/core-logic.ts');
  });

  it('notes which files were omitted when the budget is exceeded', () => {
    const diff = buildDiff([
      { path: 'src/big-one.ts', addedLines: 100 },
      { path: 'src/small-one.ts', addedLines: 2 },
    ]);
    const stats = parseDiffFileStats(diff);

    const excerpt = buildPrioritizedDiffExcerpt(diff, stats, 50);

    expect(excerpt).toContain('omitted');
    expect(excerpt).toContain('src/small-one.ts');
  });

  it('includes real diff content for small file alongside oversized file at 3000-char budget', () => {
    const bigFileLines = Array.from({ length: 200 }, (_, i) => `+big line ${i}`).join('\n');
    const smallDiff = `diff --git a/small.ts b/small.ts\n--- a/small.ts\n+++ b/small.ts\n@@ -0,0 +1,2 @@\n+One extra line\n+Another line`;
    const bigDiff = `diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n@@ -0,0 +1,200 @@\n${bigFileLines}`;
    const diff = `${smallDiff}\n${bigDiff}`;

    const stats = parseDiffFileStats(diff);
    const excerpt = buildPrioritizedDiffExcerpt(diff, stats, 3000);

    expect(excerpt).toContain('+One extra line');
    expect(excerpt).not.toContain('omitted');
  });

  it('omits files from footer when file count exceeds budget', () => {
    const files = Array.from({ length: 40 }, (_, i) => ({
      path: `file${i}.ts`,
      addedLines: 10,
    }));
    const diff = buildDiff(files);
    const stats = parseDiffFileStats(diff);

    const excerpt = buildPrioritizedDiffExcerpt(diff, stats, 200);

    expect(excerpt).toContain('omitted');
  });

  it('does not exceed maxChars budget when one file is vastly larger than another', () => {
    const tinyDiff = 'diff --git a/tiny.ts b/tiny.ts\n--- a/tiny.ts\n+++ b/tiny.ts\n@@ -0,0 +1,1 @@\n+tiny line';
    const bigLines = Array.from({ length: 5000 }, (_, i) => `+big line number ${i} with some extra padding text`).join('\n');
    const bigDiff = `diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n@@ -0,0 +1,5000 @@\n${bigLines}`;
    const diff = `${tinyDiff}\n${bigDiff}`;
    const stats = parseDiffFileStats(diff);
    const maxChars = 1000;

    const excerpt = buildPrioritizedDiffExcerpt(diff, stats, maxChars);

    expect(excerpt.length).toBeLessThanOrEqual(maxChars + 200);
  });

  it('does not exceed maxChars budget including omission footer', () => {
    const files = Array.from({ length: 20 }, (_, i) => ({
      path: `file${i}.ts`,
      addedLines: 50,
    }));
    const diff = buildDiff(files);
    const stats = parseDiffFileStats(diff);
    const maxChars = 500;

    const excerpt = buildPrioritizedDiffExcerpt(diff, stats, maxChars);

    expect(excerpt.length).toBeLessThanOrEqual(maxChars + 200);
  });

  it('falls back to a plain substring when no file headers are found', () => {
    const excerpt = buildPrioritizedDiffExcerpt('some raw text with no diff headers', [], 10);
    expect(excerpt).toBe('some raw t');
  });
});

describe('isDocsOnlyChangeset', () => {
  it('returns true when every file is a markdown or docs/ path', () => {
    const stats = [{ file: 'README.md', changedLines: 3 }, { file: 'docs/guide.md', changedLines: 1 }];
    expect(isDocsOnlyChangeset(stats)).toBe(true);
  });

  it('returns false when any file is outside docs/markdown', () => {
    const stats = [{ file: 'README.md', changedLines: 3 }, { file: 'src/app.ts', changedLines: 40 }];
    expect(isDocsOnlyChangeset(stats)).toBe(false);
  });

  it('returns false for an empty stat list', () => {
    expect(isDocsOnlyChangeset([])).toBe(false);
  });
});

describe('extractConventionalType', () => {
  it('extracts the type from a type(scope): message', () => {
    expect(extractConventionalType('fix(auth): restore login redirect')).toBe('fix');
  });

  it('extracts the type from a ticket-prefixed message', () => {
    expect(extractConventionalType('WBP-123: docs(issue:review): document the thing')).toBe('docs');
  });

  it('returns null for a freeform message with no type prefix', () => {
    expect(extractConventionalType('Restore login redirect after callback')).toBeNull();
  });
});

describe('declaresDocsOnlyType', () => {
  it('returns true for docs/style/chore prefixes', () => {
    expect(declaresDocsOnlyType('docs(issue:review): document the thing')).toBe(true);
    expect(declaresDocsOnlyType('style(warnings): tidy symbols')).toBe(true);
    expect(declaresDocsOnlyType('chore(deps): bump lodash')).toBe(true);
  });

  it('returns false for feat/fix/refactor prefixes', () => {
    expect(declaresDocsOnlyType('feat(auth): add JWT validation')).toBe(false);
    expect(declaresDocsOnlyType('fix(auth): restore login redirect')).toBe(false);
  });

  it('returns false for freeform messages', () => {
    expect(declaresDocsOnlyType('Restore login redirect after callback')).toBe(false);
  });
});
