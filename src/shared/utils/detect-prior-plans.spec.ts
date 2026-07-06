import * as fs from 'fs';
import * as path from 'path';
import {
  detectPriorPlans,
  extractPlanKeywords,
  extractContentKeywords,
  formatPriorPlansPromptSection,
  correlatePlans,
  correlateWithAiFallback,
  formatPlanCorrelationPromptSection,
  type PriorPlanContext,
  type PriorPlanSummary,
  type PlanCorrelationResult,
  type AiExecutor,
} from './detect-prior-plans';
import { parsePlanArtifact, readPlanArtifactManifest } from './plan-artifact';

jest.mock('fs');
jest.mock('./wf-paths', () => ({
  getWfHomeDir: () => '/fake/.wf',
}));
jest.mock('./plan-artifact', () => {
  const actual = jest.requireActual('./plan-artifact');
  return {
    ...actual,
    parsePlanArtifact: jest.fn(),
    readPlanArtifactManifest: jest.fn(),
  };
});

const REPO_NAME = 'service-tourv3';
const REPO_DIR = `/fake/.wf/${REPO_NAME}`;
const JIRA_DIR = path.join(REPO_DIR, 'jira');
const ARCHIVE_DIR = path.join(REPO_DIR, 'history');
const NESTED_ARCHIVE_DIR = path.join(ARCHIVE_DIR, '2026');

const mockExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
const mockReadFileSync = fs.readFileSync as jest.MockedFunction<typeof fs.readFileSync>;
const mockReaddirSync = fs.readdirSync as jest.Mock;
const mockStatSync = fs.statSync as jest.MockedFunction<typeof fs.statSync>;
const mockParsePlanArtifact = parsePlanArtifact as jest.MockedFunction<typeof parsePlanArtifact>;
const mockReadPlanArtifactManifest = readPlanArtifactManifest as jest.MockedFunction<typeof readPlanArtifactManifest>;

const createMockPlanJson = (overrides: Record<string, unknown> = {}) => ({
  action: 'fix',
  summary: 'Fix PricingService timeout',
  steps: ['Inspect PricingService', 'Patch BookingController timeout handling'],
  estimatedComplexity: 'medium',
  affectedFiles: ['src/pricing/pricing.service.ts'],
  risks: ['ECONNREFUSED can still surface during timeout spikes'],
  ...overrides,
});

const createMockPriorPlanSummary = (overrides: Partial<PriorPlanSummary> = {}): PriorPlanSummary => ({
  title: 'Fix PricingService timeout',
  summary: 'Fix PricingService timeout',
  filename: '2026-07-01-abc123-fix-plan.json',
  artifactPath: `${JIRA_DIR}/2026-07-01-abc123-fix-plan.json`,
  keywords: ['PricingService'],
  steps: ['Inspect PricingService'],
  action: 'fix',
  estimatedComplexity: 'medium',
  ticketKey: 'WBP-123',
  ...overrides,
});

const createMockPriorPlanContext = (overrides: Partial<PriorPlanContext> = {}): PriorPlanContext => ({
  plans: [],
  repoName: REPO_NAME,
  ...overrides,
});

const createMockDirent = (name: string, isDir: boolean): fs.Dirent =>
  ({
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
  }) as fs.Dirent;
const createMockStat = (mtimeMs: number): fs.Stats => ({ mtimeMs }) as fs.Stats;

describe('extractPlanKeywords', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('extracts file paths, component names, and error patterns from plan content', () => {
    const result = extractPlanKeywords(
      createMockPlanJson({
        affectedFiles: ['src/pricing/pricing.service.ts'],
        steps: ['Inspect PricingService and BookingController'],
        risks: ['Timeout can still throw ECONNREFUSED'],
      }) as any
    );

    expect(result).toContain('src/pricing/pricing.service.ts');
    expect(result).toContain('PricingService');
    expect(result).toContain('BookingController');
    expect(result).toContain('timeout');
    expect(result).toContain('ECONNREFUSED');
  });

  it('includes filePath values from FileEntry-shaped affected files', () => {
    const result = extractPlanKeywords(
      createMockPlanJson({
        affectedFiles: [{ filePath: 'src/billing/billing.service.ts', status: 'found' }],
      }) as any
    );

    expect(result).toContain('src/billing/billing.service.ts');
  });

  it('deduplicates repeated keywords', () => {
    const result = extractPlanKeywords(
      createMockPlanJson({
        summary: 'PricingService timeout',
        steps: ['Inspect PricingService'],
        affectedFiles: ['src/pricing/pricing.service.ts', 'src/pricing/pricing.service.ts'],
        risks: ['timeout'],
      }) as any
    );

    expect(result.filter(keyword => keyword === 'PricingService')).toHaveLength(1);
    expect(result.filter(keyword => keyword === 'src/pricing/pricing.service.ts')).toHaveLength(1);
  });
});

describe('extractContentKeywords', () => {
  it('extracts file paths from text', () => {
    const result = extractContentKeywords('Error in src/pricing/pricing.service.ts');
    expect(result).toContain('src/pricing/pricing.service.ts');
  });

  it('extracts component names from text', () => {
    const result = extractContentKeywords('Fix PricingService and BookingController');
    expect(result).toContain('PricingService');
    expect(result).toContain('BookingController');
  });

  it('extracts error patterns from text', () => {
    const result = extractContentKeywords('Got ECONNREFUSED and timeout errors');
    expect(result.some(k => k.toLowerCase() === 'econnrefused')).toBe(true);
    expect(result.some(k => k.toLowerCase() === 'timeout')).toBe(true);
  });

  it('deduplicates results', () => {
    const result = extractContentKeywords('PricingService PricingService PricingService');
    expect(result.filter(k => k === 'PricingService')).toHaveLength(1);
  });
});

describe('detectPriorPlans', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns empty plans when the repo directory does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    expect(detectPriorPlans(REPO_NAME)).toEqual({ plans: [], repoName: REPO_NAME });
  });

  it('finds canonical plan artifacts and extracts manifest ticket keys', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockImplementation((dir: fs.PathLike, opts?: unknown) => {
      const value = String(dir);
      if (value === REPO_DIR && opts && (opts as { withFileTypes?: boolean }).withFileTypes) {
        return [createMockDirent('jira', true), createMockDirent('history', true)];
      }
      if (value === JIRA_DIR) {
        return [];
      }
      if (value === ARCHIVE_DIR && opts && (opts as { withFileTypes?: boolean }).withFileTypes) {
        return [createMockDirent('2026', true)];
      }
      if (value === NESTED_ARCHIVE_DIR) {
        return [createMockDirent('2026-07-01-abc123-fix-plan.json', false), createMockDirent('notes.md', false)];
      }
      return [];
    });
    mockStatSync.mockReturnValue(createMockStat(1000));
    mockReadFileSync.mockReturnValue(JSON.stringify(createMockPlanJson()));
    mockParsePlanArtifact.mockReturnValue(createMockPlanJson() as any);
    mockReadPlanArtifactManifest.mockReturnValue({
      artifactPath: `${JIRA_DIR}/2026-07-01-abc123-fix-plan.json`,
      action: 'fix',
      createdAt: '2026-07-01T00:00:00.000Z',
      format: 'json',
      hash: 'abc123',
      sourceKind: 'ticket',
      sourceName: 'WBP-123',
      ticketKey: 'WBP-123',
    });

    const result = detectPriorPlans(REPO_NAME);

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]).toEqual(
      expect.objectContaining({
        filename: '2026-07-01-abc123-fix-plan.json',
        ticketKey: 'WBP-123',
        steps: ['Inspect PricingService', 'Patch BookingController timeout handling'],
        artifactPath: expect.any(String),
      })
    );
  });

  it('sorts plans by mtime descending and respects limit', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockImplementation((dir: fs.PathLike, opts?: unknown) => {
      const value = String(dir);
      if (value === REPO_DIR && opts && (opts as { withFileTypes?: boolean }).withFileTypes) {
        return [createMockDirent('history', true)];
      }
      if (value === ARCHIVE_DIR && opts && (opts as { withFileTypes?: boolean }).withFileTypes) {
        return [createMockDirent('2026', true)];
      }
      if (value === NESTED_ARCHIVE_DIR) {
        return [
          createMockDirent('2026-07-01-aaa111-fix-plan.json', false),
          createMockDirent('2026-07-02-bbb222-fix-plan.json', false),
          createMockDirent('2026-07-03-ccc333-fix-plan.json', false),
        ];
      }
      return [];
    });
    mockStatSync.mockImplementation((filePath: fs.PathLike) => {
      const value = String(filePath);
      if (value.includes('aaa111')) return createMockStat(1000);
      if (value.includes('bbb222')) return createMockStat(3000);
      if (value.includes('ccc333')) return createMockStat(2000);
      return createMockStat(0);
    });
    mockReadFileSync.mockReturnValue(JSON.stringify(createMockPlanJson()));
    mockParsePlanArtifact.mockImplementation(
      (content: string, filePath: string) =>
        createMockPlanJson({
          summary: path.basename(filePath),
        }) as any
    );
    mockReadPlanArtifactManifest.mockReturnValue(null);

    const result = detectPriorPlans(REPO_NAME, { limit: 2 });

    expect(result.plans).toHaveLength(2);
    expect(result.plans[0].summary).toBe('2026-07-02-bbb222-fix-plan.json');
    expect(result.plans[1].summary).toBe('2026-07-03-ccc333-fix-plan.json');
  });

  it('swallows parse and manifest read errors per file', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockImplementation((dir: fs.PathLike, opts?: unknown) => {
      const value = String(dir);
      if (value === REPO_DIR && opts && (opts as { withFileTypes?: boolean }).withFileTypes) {
        return [createMockDirent('history', true)];
      }
      if (value === ARCHIVE_DIR && opts && (opts as { withFileTypes?: boolean }).withFileTypes) {
        return [createMockDirent('2026', true)];
      }
      if (value === NESTED_ARCHIVE_DIR) {
        return [createMockDirent('2026-07-01-abc123-fix-plan.json', false)];
      }
      return [];
    });
    mockStatSync.mockReturnValue(createMockStat(1000));
    mockReadFileSync.mockReturnValue(JSON.stringify(createMockPlanJson()));
    mockParsePlanArtifact.mockImplementation(() => {
      throw new Error('invalid');
    });

    expect(() => detectPriorPlans(REPO_NAME)).not.toThrow();
    expect(detectPriorPlans(REPO_NAME)).toEqual({ plans: [], repoName: REPO_NAME });
  });
});

describe('correlatePlans', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns empty matches when no prior plans exist', () => {
    const result = correlatePlans('Fix PricingService timeout', createMockPriorPlanContext(), '/tmp/repo');
    expect(result.matches).toHaveLength(0);
    expect(result.repoName).toBe(REPO_NAME);
  });

  it('filters plans below Jaccard threshold', () => {
    const plans = createMockPriorPlanContext({
      plans: [
        createMockPriorPlanSummary({
          keywords: ['CompletelyUnrelatedKeyword', 'AnotherUnrelatedThing'],
        }),
      ],
    });

    const result = correlatePlans('Fix login page rendering issue', plans, '/tmp/repo');
    expect(result.matches).toHaveLength(0);
  });

  it('returns matches sorted by score descending', () => {
    const plans = createMockPriorPlanContext({
      plans: [
        createMockPriorPlanSummary({
          summary: 'Low overlap plan',
          filename: 'low.json',
          artifactPath: '/fake/low.json',
          keywords: ['PricingService'],
        }),
        createMockPriorPlanSummary({
          summary: 'High overlap plan',
          filename: 'high.json',
          artifactPath: '/fake/high.json',
          keywords: ['PricingService', 'timeout', 'ECONNREFUSED'],
        }),
      ],
    });

    mockReadFileSync.mockImplementation(() => {
      throw new Error('not found');
    });

    const result = correlatePlans('Fix PricingService timeout ECONNREFUSED error', plans, '/tmp/repo');

    if (result.matches.length >= 2) {
      expect(result.matches[0].overlapScore).toBeGreaterThanOrEqual(result.matches[1].overlapScore);
    }
  });

  it('loads source code from affected files in repoDir', () => {
    const artifactPath = '/fake/plan.json';
    const plans = createMockPriorPlanContext({
      plans: [
        createMockPriorPlanSummary({
          keywords: ['PricingService', 'timeout'],
          artifactPath,
        }),
      ],
    });

    mockReadFileSync.mockImplementation((input: fs.PathOrFileDescriptor) => {
      const filePath = String(input);
      if (filePath === artifactPath) {
        return JSON.stringify(createMockPlanJson());
      }
      if (filePath.includes('pricing.service.ts')) {
        return 'export class PricingService {}';
      }
      throw new Error('not found');
    });
    mockParsePlanArtifact.mockReturnValue(createMockPlanJson() as any);
    mockExistsSync.mockReturnValue(true);

    const result = correlatePlans('Fix PricingService timeout issues', plans, '/tmp/repo');

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchSource).toBe('keyword');
    expect(result.matches[0].affectedFiles).toContain('src/pricing/pricing.service.ts');
  });

  it('skips files that do not exist', () => {
    const artifactPath = '/fake/plan.json';
    const plans = createMockPriorPlanContext({
      plans: [
        createMockPriorPlanSummary({
          keywords: ['PricingService'],
          artifactPath,
        }),
      ],
    });

    mockReadFileSync.mockImplementation((input: fs.PathOrFileDescriptor) => {
      if (String(input) === artifactPath) {
        return JSON.stringify(createMockPlanJson());
      }
      throw new Error('not found');
    });
    mockParsePlanArtifact.mockReturnValue(createMockPlanJson() as any);
    mockExistsSync.mockImplementation((input: fs.PathLike) => {
      return !String(input).includes('pricing.service.ts');
    });

    const result = correlatePlans('Fix PricingService timeout', plans, '/tmp/repo');

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].sourceSnippets).toHaveLength(0);
  });

  it('skips binary files with null bytes', () => {
    const artifactPath = '/fake/plan.json';
    const plans = createMockPriorPlanContext({
      plans: [
        createMockPriorPlanSummary({
          keywords: ['PricingService'],
          artifactPath,
        }),
      ],
    });

    mockReadFileSync.mockImplementation((input: fs.PathOrFileDescriptor) => {
      if (String(input) === artifactPath) {
        return JSON.stringify(createMockPlanJson());
      }
      return 'binary\0content';
    });
    mockParsePlanArtifact.mockReturnValue(createMockPlanJson() as any);
    mockExistsSync.mockReturnValue(true);

    const result = correlatePlans('Fix PricingService timeout', plans, '/tmp/repo');

    expect(result.matches[0].sourceSnippets).toHaveLength(0);
  });

  it('respects maxTotalChars limit', () => {
    const artifactPath = '/fake/plan.json';
    const plans = createMockPriorPlanContext({
      plans: [
        createMockPriorPlanSummary({
          keywords: ['PricingService'],
          artifactPath,
        }),
      ],
    });

    mockReadFileSync.mockImplementation((input: fs.PathOrFileDescriptor) => {
      if (String(input) === artifactPath) {
        return JSON.stringify(
          createMockPlanJson({
            affectedFiles: ['src/a.ts', 'src/b.ts'],
          })
        );
      }
      return 'x'.repeat(100);
    });
    mockParsePlanArtifact.mockReturnValue(createMockPlanJson({ affectedFiles: ['src/a.ts', 'src/b.ts'] }) as any);
    mockExistsSync.mockReturnValue(true);

    const result = correlatePlans('Fix PricingService', plans, '/tmp/repo', {
      maxTotalChars: 50,
    });

    const totalContent = result.matches[0].sourceSnippets.reduce((sum, s) => sum + s.content.length, 0);
    expect(totalContent).toBeLessThanOrEqual(50);
  });
});

describe('correlateWithAiFallback', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const createMockAiExecutor = (response?: string): AiExecutor => ({
    execute: jest.fn().mockResolvedValue({ content: response ?? '[]' }),
  });

  it('returns keyword matches without calling AI when Jaccard succeeds', async () => {
    const aiExecutor = createMockAiExecutor();
    const plans = createMockPriorPlanContext({
      plans: [
        createMockPriorPlanSummary({
          keywords: ['PricingService', 'timeout'],
        }),
      ],
    });

    mockReadFileSync.mockImplementation(() => {
      throw new Error('not found');
    });

    const result = await correlateWithAiFallback(
      'Fix PricingService timeout ECONNREFUSED',
      plans,
      '/tmp/repo',
      aiExecutor
    );

    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0].matchSource).toBe('keyword');
    expect(aiExecutor.execute).not.toHaveBeenCalled();
  });

  it('calls AI when zero keyword matches and parses response indices', async () => {
    const aiExecutor = createMockAiExecutor('[{"index": 0, "reason": "both address billing retries"}]');
    const plans = createMockPriorPlanContext({
      plans: [
        createMockPriorPlanSummary({
          summary: 'Add BillingService retries',
          keywords: ['BillingService', 'retries'],
        }),
      ],
    });

    mockReadFileSync.mockImplementation(() => {
      throw new Error('not found');
    });

    const result = await correlateWithAiFallback(
      'Completely unrelated login page content',
      plans,
      '/tmp/repo',
      aiExecutor
    );

    expect(aiExecutor.execute).toHaveBeenCalled();
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchSource).toBe('ai');
    expect(result.matches[0].aiReason).toBe('both address billing retries');
    expect(result.matches[0].overlapScore).toBe(0);
    expect(result.matches[0].sharedKeywords).toEqual([]);
  });

  it('handles AI failure gracefully and returns empty result', async () => {
    const aiExecutor: AiExecutor = {
      execute: jest.fn().mockRejectedValue(new Error('API error')),
    };
    const plans = createMockPriorPlanContext({
      plans: [
        createMockPriorPlanSummary({
          keywords: ['CompletelyDifferent'],
        }),
      ],
    });

    const result = await correlateWithAiFallback('Unrelated content about login', plans, '/tmp/repo', aiExecutor);

    expect(result.matches).toHaveLength(0);
  });

  it('returns empty when no prior plans exist', async () => {
    const aiExecutor = createMockAiExecutor();

    const result = await correlateWithAiFallback('Some content', createMockPriorPlanContext(), '/tmp/repo', aiExecutor);

    expect(result.matches).toHaveLength(0);
    expect(aiExecutor.execute).not.toHaveBeenCalled();
  });
});

describe('formatPlanCorrelationPromptSection', () => {
  it('returns empty string when no matches', () => {
    expect(formatPlanCorrelationPromptSection({ matches: [], repoName: 'test' })).toBe('');
  });

  it('includes action, overlap score, and shared keywords for keyword matches', () => {
    const result: PlanCorrelationResult = {
      matches: [
        {
          summary: 'Fix PricingService timeout',
          filename: 'plan.json',
          action: 'fix',
          estimatedComplexity: 'medium',
          overlapScore: 0.45,
          sharedKeywords: ['PricingService', 'timeout'],
          matchSource: 'keyword',
          affectedFiles: ['src/pricing.ts'],
          sourceSnippets: [],
        },
      ],
      repoName: 'test-repo',
    };

    const output = formatPlanCorrelationPromptSection(result);
    expect(output).toContain('Prior plan correlation (test-repo):');
    expect(output).toContain('[fix] Fix PricingService timeout');
    expect(output).toContain('overlap: 0.45');
    expect(output).toContain('shared: PricingService, timeout');
    expect(output).toContain('Affected: src/pricing.ts');
  });

  it('includes aiReason for AI matches', () => {
    const result: PlanCorrelationResult = {
      matches: [
        {
          summary: 'Add BillingService retries',
          filename: 'plan.json',
          action: 'feature',
          overlapScore: 0,
          sharedKeywords: [],
          matchSource: 'ai',
          aiReason: 'both address retry logic in payment flow',
          sourceSnippets: [],
        },
      ],
      repoName: 'test-repo',
    };

    const output = formatPlanCorrelationPromptSection(result);
    expect(output).toContain('(semantic match: both address retry logic in payment flow)');
  });

  it('includes source snippets', () => {
    const result: PlanCorrelationResult = {
      matches: [
        {
          summary: 'Fix timeout',
          filename: 'plan.json',
          action: 'fix',
          overlapScore: 0.5,
          sharedKeywords: ['timeout'],
          matchSource: 'keyword',
          sourceSnippets: [{ filePath: 'src/service.ts', content: 'export class Service {}' }],
        },
      ],
      repoName: 'test',
    };

    const output = formatPlanCorrelationPromptSection(result);
    expect(output).toContain('Source (src/service.ts):');
    expect(output).toContain('export class Service {}');
  });

  it('caps at 5 matches', () => {
    const matches = Array.from({ length: 7 }, (_, i) => ({
      summary: `Plan ${i + 1}`,
      filename: `plan-${i}.json`,
      action: 'fix' as const,
      overlapScore: 0.5,
      sharedKeywords: ['k'],
      matchSource: 'keyword' as const,
      sourceSnippets: [],
    }));

    const output = formatPlanCorrelationPromptSection({ matches, repoName: 'test' });
    expect(output).toContain('Plan 5');
    expect(output).not.toContain('Plan 6');
  });
});

describe('formatPriorPlansPromptSection', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns an empty string when no plans are present', () => {
    expect(formatPriorPlansPromptSection(createMockPriorPlanContext())).toBe('');
  });

  it('formats action, complexity, keywords, and steps', () => {
    const result = formatPriorPlansPromptSection(
      createMockPriorPlanContext({
        plans: [
          createMockPriorPlanSummary({
            action: 'fix',
            estimatedComplexity: 'medium',
            keywords: ['PricingService', 'timeout'],
            steps: ['Inspect PricingService', 'Patch BookingController timeout handling'],
          }),
        ],
      })
    );

    expect(result).toContain('Related prior plans (service-tourv3):');
    expect(result).toContain(
      '[fix] Fix PricingService timeout (complexity: medium, keywords: PricingService, timeout)'
    );
    expect(result).toContain('Steps: 1. Inspect PricingService; 2. Patch BookingController timeout handling');
  });

  it('caps the output at five plans', () => {
    const plans = Array.from({ length: 6 }, (_, index) =>
      createMockPriorPlanSummary({
        filename: `2026-07-0${index + 1}-abc${index}-fix-plan.json`,
        summary: `Plan ${index + 1}`,
      })
    );

    const result = formatPriorPlansPromptSection(createMockPriorPlanContext({ plans }));

    expect(result).toContain('Plan 5');
    expect(result).not.toContain('Plan 6');
  });
});
