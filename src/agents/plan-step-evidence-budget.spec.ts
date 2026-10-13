import {
  allocateEvidence,
  buildEvidenceCompletenessSection,
  buildStepResponseShapeLines,
  computeEvidenceBudget,
  gapAwareStatusRules,
  hasEvidenceGaps,
  partitionStepsForPhasedAssessment,
  sliceHeadTail,
  unverifiableRule,
  type EvidenceBudgetReport,
  type EvidenceSection,
} from './plan-step-evidence-budget';

const createMockSection = (overrides: Partial<EvidenceSection> & { path: string }): EvidenceSection => ({
  kind: 'tracked',
  content: 'x'.repeat(1_000),
  mentioned: false,
  ...overrides,
});

const createMockReport = (overrides: Partial<EvidenceBudgetReport> = {}): EvidenceBudgetReport => ({
  totalMeasured: 0,
  budget: 0,
  truncated: [],
  omitted: [],
  ...overrides,
});

const gapReport = createMockReport({
  truncated: [{ path: 'a.ts', shownChars: 10, fullChars: 100 }],
  omitted: ['b.ts'],
});

describe('plan step evidence budget', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('computeEvidenceBudget', () => {
    const base = { nameStatusLength: 100, floor: 60_000, ceiling: 240_000 };

    it('returns the measured total for mid-size diffs so the fits-whole path fires', () => {
      expect(computeEvidenceBudget({ ...base, measuredTotal: 100_000 })).toBe(100_000);
    });

    it('returns the floor minus nameStatus for small diffs', () => {
      expect(computeEvidenceBudget({ ...base, measuredTotal: 500 })).toBe(59_900);
    });

    it('returns the ceiling minus nameStatus for huge diffs', () => {
      expect(computeEvidenceBudget({ ...base, measuredTotal: 900_000 })).toBe(239_900);
    });

    it('never goes negative when nameStatus exceeds the ceiling', () => {
      expect(computeEvidenceBudget({ ...base, nameStatusLength: 300_000, measuredTotal: 10 })).toBe(0);
    });
  });

  describe('sliceHeadTail', () => {
    it('returns content untouched when within the limit', () => {
      expect(sliceHeadTail('abc', 10)).toBe('abc');
    });

    it('keeps both head and the original tail around a gap marker within the limit', () => {
      const content = `HEAD${'m'.repeat(5_000)}TAIL`;
      const sliced = sliceHeadTail(content, 1_000);
      expect(sliced.length).toBeLessThanOrEqual(1_000);
      expect(sliced.startsWith('HEAD')).toBe(true);
      expect(sliced.endsWith('TAIL')).toBe(true);
      expect(sliced).toMatch(/\[\.\.\. evidence gap: \d+ chars omitted \.\.\.\]/);
    });

    it('biases toward the tail less than the head (about 60/40)', () => {
      const content = `${'h'.repeat(5_000)}${'t'.repeat(5_000)}`;
      const sliced = sliceHeadTail(content, 1_000);
      const headCount = (sliced.match(/h/g) ?? []).length;
      const tailCount = (sliced.match(/t/g) ?? []).length;
      expect(headCount).toBeGreaterThan(tailCount);
      expect(tailCount).toBeGreaterThan(0);
    });

    it('returns an empty string when the limit cannot hold the marker', () => {
      expect(sliceHeadTail('x'.repeat(5_000), 5)).toBe('');
    });
  });

  describe('allocateEvidence', () => {
    it('renders every section whole when the total fits the budget', () => {
      const sections = [
        createMockSection({ path: 'a.ts', content: 'a'.repeat(20_000) }),
        createMockSection({ path: 'b.ts', content: 'b'.repeat(20_000) }),
      ];
      const { rendered, report } = allocateEvidence(sections, 60_000);
      expect(rendered.get('a.ts')).toBe(`### a.ts\n${'a'.repeat(20_000)}`);
      expect(rendered.get('b.ts')?.length).toBe(`### b.ts\n${'b'.repeat(20_000)}`.length);
      expect(report.truncated).toEqual([]);
      expect(report.omitted).toEqual([]);
      expect(report.totalMeasured).toBe(40_000);
    });

    it('wraps untracked content in a fenced block', () => {
      const { rendered } = allocateEvidence([createMockSection({ path: 'n.ts', kind: 'untracked', content: 'hi' })], 100);
      expect(rendered.get('n.ts')).toBe('### n.ts\n```\nhi\n```');
    });

    it('truncates oversized sections to baseline and reports them', () => {
      const sections = [
        createMockSection({ path: 'a.ts', content: 'a'.repeat(10_000) }),
        createMockSection({ path: 'b.ts', content: 'b'.repeat(10_000) }),
      ];
      const { rendered, report } = allocateEvidence(sections, 8_000);
      expect(report.truncated.map(t => t.path).sort()).toEqual(['a.ts', 'b.ts']);
      expect(rendered.get('a.ts')).toContain('evidence gap');
      expect(report.truncated[0].fullChars).toBe(10_000);
    });

    it('redistributes surplus from small sections to the largest truncated section', () => {
      const sections = [
        createMockSection({ path: 'small.ts', content: 's'.repeat(100) }),
        createMockSection({ path: 'big.ts', content: 'b'.repeat(50_000) }),
        createMockSection({ path: 'mid.ts', content: 'm'.repeat(10_000) }),
      ];
      const { report } = allocateEvidence(sections, 20_000);
      const big = report.truncated.find(t => t.path === 'big.ts');
      const mid = report.truncated.find(t => t.path === 'mid.ts');
      expect(big?.shownChars).toBeGreaterThan(10_000);
      expect(mid?.shownChars ?? 10_000).toBeLessThanOrEqual(10_000);
      expect(report.truncated.find(t => t.path === 'small.ts')).toBeUndefined();
    });

    it('funds mentioned sections before unmentioned ones', () => {
      const sections = [
        createMockSection({ path: 'other.ts', content: 'o'.repeat(10_000) }),
        createMockSection({ path: 'named.ts', content: 'n'.repeat(3_000), mentioned: true }),
      ];
      const { rendered, report } = allocateEvidence(sections, 6_000);
      expect(rendered.get('named.ts')).toBe(`### named.ts\n${'n'.repeat(3_000)}`);
      expect(report.truncated.map(t => t.path)).toContain('other.ts');
    });

    it('falls back to whole-section greedy fill in priority order for many tiny budgets', () => {
      const sections = Array.from({ length: 20 }, (_, i) =>
        createMockSection({ path: `f${i}.ts`, content: 'x'.repeat(200), mentioned: i === 19 }));
      const { rendered, report } = allocateEvidence(sections, 1_000);
      expect(rendered.has('f19.ts')).toBe(true);
      expect(report.omitted.length).toBeGreaterThan(0);
      expect(report.truncated).toEqual([]);
      for (const text of rendered.values()) expect(text).not.toContain('evidence gap');
    });

    it('renders binary placeholders whole and never reports them as gaps', () => {
      const sections = [
        createMockSection({ path: 'img.png', kind: 'untracked', content: '[binary file, 9 bytes]', binary: true }),
        createMockSection({ path: 'a.ts', content: 'a'.repeat(10_000) }),
      ];
      const { rendered, report } = allocateEvidence(sections, 2_000);
      expect(rendered.get('img.png')).toBe('### img.png\n[binary file, 9 bytes]');
      expect(report.omitted).not.toContain('img.png');
      expect(report.truncated.map(t => t.path)).not.toContain('img.png');
    });

    it('handles empty input and zero budget', () => {
      expect(allocateEvidence([], 0).rendered.size).toBe(0);
      const { report } = allocateEvidence([createMockSection({ path: 'a.ts' })], 0);
      expect(report.omitted).toEqual(['a.ts']);
    });
  });

  describe('buildEvidenceCompletenessSection', () => {
    it('is empty when there are no gaps', () => {
      expect(buildEvidenceCompletenessSection(createMockReport())).toBe('');
      expect(hasEvidenceGaps(createMockReport())).toBe(false);
    });

    it('lists truncated and omitted paths when gaps exist', () => {
      const section = buildEvidenceCompletenessSection(gapReport);
      expect(hasEvidenceGaps(gapReport)).toBe(true);
      expect(section).toContain('## Evidence completeness');
      expect(section).toContain('a.ts (10 of 100 chars shown)');
      expect(section).toContain('b.ts');
    });
  });

  describe('unverifiableRule and gapAwareStatusRules', () => {
    it('builds the shared base rule for a subject', () => {
      expect(unverifiableRule('evidence')).toBe(
        '- unverifiable: ONLY for temporal, process, or investigation claims that evidence cannot in principle prove or disprove (requires missing field)',
      );
      expect(unverifiableRule('repository state')).toContain('that repository state cannot in principle');
    });

    it('returns the plain rules unchanged when there are no gaps', () => {
      const rules = gapAwareStatusRules(createMockReport(), [0, 1]);
      expect(rules).toContain(unverifiableRule('evidence'));
      expect(rules.join('\n')).not.toContain('evidence gap');
    });

    it('swaps only the unverifiable line when gaps exist', () => {
      const plain = gapAwareStatusRules(createMockReport(), [0, 1]);
      const gapped = gapAwareStatusRules(gapReport, [0, 1]);
      expect(gapped).toHaveLength(plain.length);
      const changed = gapped.filter((line, i) => line !== plain[i]);
      expect(changed).toHaveLength(1);
      expect(changed[0]).toContain('disclosed evidence gap');
      expect(changed[0].startsWith(unverifiableRule('evidence').replace(' (requires missing field)', ''))).toBe(true);
    });
  });

  describe('buildStepResponseShapeLines', () => {
    it('renders the example from the first two real indices', () => {
      const text = buildStepResponseShapeLines([5, 6, 8, 9]).join('\n');
      expect(text).toContain('{"statuses":[{"index":5,"status":"done"},{"index":6,"status":"partially-done","missing":"…"}]}');
      expect(text).toContain('Use the exact N from each [Plan step N] tag — never renumber from 0.');
    });

    it('renders only the single index when one step is assessed', () => {
      const text = buildStepResponseShapeLines([7]).join('\n');
      expect(text).toContain('{"statuses":[{"index":7,"status":"done"}]}');
      expect(text).not.toContain('partially-done","missing":"…"}]}');
    });
  });

  describe('partitionStepsForPhasedAssessment', () => {
    const steps = [
      { index: 0, text: 'edit a.ts' },
      { index: 1, text: 'edit b.ts' },
      { index: 2, text: 'edit a.ts again and c.ts' },
      { index: 3, text: 'no file mentioned' },
    ];
    const sections = [
      createMockSection({ path: 'a.ts', content: 'a'.repeat(60_000) }),
      createMockSection({ path: 'b.ts', content: 'b'.repeat(60_000) }),
      createMockSection({ path: 'c.ts', content: 'c'.repeat(30_000) }),
      createMockSection({ path: 'spare.ts', content: 's'.repeat(1_000) }),
    ];

    it('places every step in exactly one group', () => {
      const groups = partitionStepsForPhasedAssessment(steps, sections, 130_000);
      const indices = groups.flatMap(g => g.steps.map(s => s.index)).sort();
      expect(indices).toEqual([0, 1, 2, 3]);
    });

    it('keeps each group under the ceiling and duplicates shared files across groups', () => {
      const groups = partitionStepsForPhasedAssessment(steps, sections, 130_000);
      for (const group of groups) {
        const total = group.sections.reduce((sum, s) => sum + s.content.length, 0);
        expect(total).toBeLessThanOrEqual(130_000);
      }
      expect(groups.length).toBeGreaterThan(1);
      const groupsWithA = groups.filter(g => g.sections.some(s => s.path === 'a.ts'));
      expect(groupsWithA.length).toBeGreaterThanOrEqual(1);
    });

    it('gives each group the full sections of the files its steps mention', () => {
      const groups = partitionStepsForPhasedAssessment(steps, sections, 130_000);
      for (const group of groups) {
        for (const step of group.steps) {
          for (const section of sections.filter(s => step.text.includes(s.path))) {
            expect(group.sections.map(s => s.path)).toContain(section.path);
          }
        }
      }
    });

    it('lands no-mention steps and unmentioned sections in the group with the most spare budget', () => {
      const groups = partitionStepsForPhasedAssessment(steps, sections, 130_000);
      const withNoMention = groups.find(g => g.steps.some(s => s.index === 3));
      expect(withNoMention?.steps.map(s => s.index)).toContain(2);
      expect(withNoMention?.sections.map(s => s.path)).toContain('spare.ts');
    });

    it('places leftover sections flagged as mentioned before other leftovers', () => {
      const leftovers = [
        createMockSection({ path: 'plain.ts', content: 'p'.repeat(100_000) }),
        createMockSection({ path: 'planned.ts', content: 'q'.repeat(100_000), mentioned: true }),
      ];
      const groups = partitionStepsForPhasedAssessment([{ index: 0, text: 'no file' }], leftovers, 130_000);
      expect(groups[0].sections.map(s => s.path)).toEqual(['planned.ts']);
    });

    it('returns a single group when everything fits', () => {
      const groups = partitionStepsForPhasedAssessment(steps, sections, 1_000_000);
      expect(groups).toHaveLength(1);
      expect(groups[0].steps).toHaveLength(4);
    });

    it('returns a single empty-section group for no sections', () => {
      const groups = partitionStepsForPhasedAssessment(steps, [], 100);
      expect(groups).toHaveLength(1);
      expect(groups[0].sections).toEqual([]);
    });
  });
});
