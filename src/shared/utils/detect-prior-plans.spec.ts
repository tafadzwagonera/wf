import * as fs from 'fs';
import * as path from 'path';
import {
  detectPriorPlans,
  extractPlanKeywords,
  formatPriorPlansPromptSection,
  mergePriorContexts,
  type PriorPlanContext,
  type PriorPlanSummary,
} from './detect-prior-plans';
import { parsePlanArtifact, readPlanArtifactManifest } from './plan-artifact';
import type { PriorTicketContext } from '../types/detection.types';

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

const createMockPriorTicketContext = (overrides: Partial<PriorTicketContext> = {}): PriorTicketContext => ({
  tickets: [],
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

describe('mergePriorContexts', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the existing ticket context when no plans are present', () => {
    const tickets = createMockPriorTicketContext({
      tickets: [{ title: 'Existing ticket', summary: 'Existing ticket', filename: 'WBP-1.md', keywords: ['x'] }],
    });

    expect(mergePriorContexts(tickets, createMockPriorPlanContext())).toEqual(tickets);
  });

  it('adds plan summaries and deduplicates by ticket key', () => {
    const tickets = createMockPriorTicketContext({
      tickets: [
        {
          title: 'WBP-123 existing ticket',
          summary: 'WBP-123 existing ticket',
          filename: 'WBP-123-ticket-description.md',
          keywords: ['PricingService'],
        },
      ],
    });
    const plans = createMockPriorPlanContext({
      plans: [
        createMockPriorPlanSummary({ ticketKey: 'WBP-123' }),
        createMockPriorPlanSummary({
          filename: '2026-07-02-def456-feature-plan.json',
          summary: 'Add BillingService retries',
          keywords: ['BillingService'],
          action: 'feature',
          ticketKey: null,
        }),
      ],
    });

    const result = mergePriorContexts(tickets, plans);

    expect(result.tickets).toHaveLength(2);
    expect(result.tickets[0].filename).toBe('WBP-123-ticket-description.md');
    expect(result.tickets[1]).toEqual(
      expect.objectContaining({
        title: 'Add BillingService retries',
        filename: '2026-07-02-def456-feature-plan.json',
      })
    );
  });

  it('preserves manifest ticket keys on synthetic ticket summaries', () => {
    const result = mergePriorContexts(
      createMockPriorTicketContext(),
      createMockPriorPlanContext({
        plans: [createMockPriorPlanSummary({ filename: '2026-07-02-def456-fix-plan.json', ticketKey: 'WBP-456' })],
      })
    );

    expect(result.tickets[0]).toEqual(
      expect.objectContaining({
        filename: '2026-07-02-def456-fix-plan.json',
        ticketKey: 'WBP-456',
      })
    );
  });

  it('deduplicates markdown plan files already discovered as prior tickets', () => {
    const tickets = createMockPriorTicketContext({
      tickets: [
        {
          title: 'Fix PricingService timeout',
          summary: 'Fix PricingService timeout',
          filename: '2026-07-01-abc123-fix-plan.md',
          keywords: ['PricingService'],
        },
      ],
    });

    const result = mergePriorContexts(
      tickets,
      createMockPriorPlanContext({
        plans: [createMockPriorPlanSummary({ filename: '2026-07-01-abc123-fix-plan.md', ticketKey: null })],
      })
    );

    expect(result.tickets).toHaveLength(1);
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
