import * as fs from 'fs';
import * as path from 'path';
import {
  detectPriorTickets,
  extractTicketKeywords,
  formatPriorTicketsPromptSection,
  PriorTicketContext,
  PriorTicketSummary,
} from './detect-prior-tickets';

jest.mock('fs');
jest.mock('./wf-paths', () => ({
  getWfHomeDir: () => '/fake/.wf',
}));

const REPO_NAME = 'service-tourv3';
const REPO_DIR = `/fake/.wf/${REPO_NAME}`;
const JIRA_DIR = path.join(REPO_DIR, 'jira');

const mockExistsSync = fs.existsSync as jest.MockedFunction<
  typeof fs.existsSync
>;
const mockReadFileSync = fs.readFileSync as jest.MockedFunction<
  typeof fs.readFileSync
>;
// Cast as jest.Mock to avoid TypeScript overload resolution conflicts with readdirSync signatures
const mockReaddirSync = fs.readdirSync as jest.Mock;
const mockStatSync = fs.statSync as jest.MockedFunction<typeof fs.statSync>;

// --- Factories ---

const createMockTicketMarkdown = (overrides: {
  title?: string;
  summary?: string;
}): string => {
  const title = overrides.title ?? 'Fix pricing service timeout';
  const summary =
    overrides.summary ??
    'The PricingService is throwing ECONNREFUSED when calling src/pricing/pricing.ts';
  return `# ${title}\n\n### Summary\n${summary}\n\n### Details\nSome extra details here.\n`;
};

const createMockPriorTicketSummary = (
  overrides: Partial<PriorTicketSummary> = {},
): PriorTicketSummary => ({
  title: 'Fix pricing service timeout',
  summary:
    'The PricingService is throwing ECONNREFUSED when calling src/pricing/pricing.ts',
  filename: 'TOUR-123-ticket-description.md',
  keywords: [],
  ...overrides,
});

const createMockPriorTicketContext = (
  overrides: Partial<PriorTicketContext> = {},
): PriorTicketContext => ({
  tickets: [],
  repoName: REPO_NAME,
  ...overrides,
});

const createMockDirent = (name: string, isDir: boolean): fs.Dirent =>
  ({ name, isDirectory: () => isDir }) as fs.Dirent;

const createMockStat = (mtimeMs: number): fs.Stats => ({ mtimeMs }) as fs.Stats;

describe('extractTicketKeywords', () => {
  describe('when extracting keywords from ticket text', () => {
    it('extracts file paths from title and summary', () => {
      const result = extractTicketKeywords(
        'Fix pricing service',
        'Error in src/pricing/pricing.ts at line 42',
      );
      expect(result).toContain('src/pricing/pricing.ts');
    });

    it('extracts component names from title and summary', () => {
      const result = extractTicketKeywords(
        'PricingService is broken',
        'The BookingController also throws',
      );
      expect(result).toContain('PricingService');
      expect(result).toContain('BookingController');
    });

    it('extracts error patterns from title and summary', () => {
      const result = extractTicketKeywords(
        'ECONNREFUSED in payment flow',
        'Getting timeout and deadlock errors',
      );
      expect(result).toContain('ECONNREFUSED');
      expect(result).toContain('timeout');
      expect(result).toContain('deadlock');
    });

    it('deduplicates repeated keywords', () => {
      const result = extractTicketKeywords(
        'PricingService Error',
        'PricingService throws Error again',
      );
      const pricingCount = result.filter((k) => k === 'PricingService').length;
      const errorCount = result.filter(
        (k) => k.toLowerCase() === 'error',
      ).length;
      expect(pricingCount).toBe(1);
      expect(errorCount).toBe(1);
    });

    it('extracts multi-dot file paths like pricing.service.ts', () => {
      const result = extractTicketKeywords(
        'Fix pricing service',
        'Error in src/pricing/pricing.service.ts at line 42',
      );
      expect(result).toContain('src/pricing/pricing.service.ts');
    });

    it('returns empty array for text with no matches', () => {
      const result = extractTicketKeywords(
        'update the readme',
        'just a small tweak with no code references',
      );
      expect(result).toEqual([]);
    });
  });
});

describe('detectPriorTickets', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('when repo directory does not exist', () => {
    it('returns empty tickets array', () => {
      mockExistsSync.mockReturnValue(false);

      const result = detectPriorTickets(REPO_NAME);

      expect(result).toEqual({ tickets: [], repoName: REPO_NAME });
    });
  });

  describe('when scanning tracker subdirectories', () => {
    it('finds ticket files in tracker subdirectories', () => {
      mockExistsSync.mockReturnValue(true);

      mockReaddirSync.mockImplementation((dir: fs.PathLike, opts?: unknown) => {
        const s = String(dir);
        if (
          s === REPO_DIR &&
          opts &&
          (opts as { withFileTypes?: boolean }).withFileTypes
        ) {
          return [createMockDirent('jira', true)];
        }
        if (s === JIRA_DIR) {
          return ['TOUR-123-ticket-description.md'];
        }
        return [];
      });

      mockStatSync.mockReturnValue(createMockStat(1000));

      mockReadFileSync.mockReturnValue(
        createMockTicketMarkdown({
          title: 'Fix pricing service timeout',
          summary: 'The PricingService is throwing ECONNREFUSED',
        }),
      );

      const result = detectPriorTickets(REPO_NAME);

      expect(result.repoName).toBe(REPO_NAME);
      expect(result.tickets).toHaveLength(1);
      expect(result.tickets[0].filename).toBe('TOUR-123-ticket-description.md');
    });

    it('ignores non-markdown files in tracker directories', () => {
      mockExistsSync.mockReturnValue(true);

      mockReaddirSync.mockImplementation((dir: fs.PathLike, opts?: unknown) => {
        const s = String(dir);
        if (
          s === REPO_DIR &&
          opts &&
          (opts as { withFileTypes?: boolean }).withFileTypes
        ) {
          return [createMockDirent('jira', true)];
        }
        if (s === JIRA_DIR) {
          return ['state.json', 'TOUR-123-ticket-description.md'];
        }
        return [];
      });

      mockStatSync.mockReturnValue(createMockStat(1000));
      mockReadFileSync.mockReturnValue(createMockTicketMarkdown({}));

      const result = detectPriorTickets(REPO_NAME);

      expect(result.tickets).toHaveLength(1);
    });
  });

  describe('when sorting and limiting results', () => {
    it('sorts ticket files by mtime descending and respects limit', () => {
      mockExistsSync.mockReturnValue(true);

      mockReaddirSync.mockImplementation((dir: fs.PathLike, opts?: unknown) => {
        const s = String(dir);
        if (
          s === REPO_DIR &&
          opts &&
          (opts as { withFileTypes?: boolean }).withFileTypes
        ) {
          return [createMockDirent('jira', true)];
        }
        if (s === JIRA_DIR) {
          return [
            'TOUR-100-ticket-description.md',
            'TOUR-200-ticket-description.md',
            'TOUR-300-ticket-description.md',
          ];
        }
        return [];
      });

      mockStatSync.mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        if (s.includes('TOUR-100')) return createMockStat(1000);
        if (s.includes('TOUR-200')) return createMockStat(3000);
        if (s.includes('TOUR-300')) return createMockStat(2000);
        return createMockStat(0);
      });

      mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        const s = String(p);
        const num = s.match(/TOUR-(\d+)/)?.[1] ?? '000';
        return createMockTicketMarkdown({ title: `Ticket ${num}` });
      });

      const result = detectPriorTickets(REPO_NAME, { limit: 2 });

      expect(result.tickets).toHaveLength(2);
      expect(result.tickets[0].title).toBe('Ticket 200');
      expect(result.tickets[1].title).toBe('Ticket 300');
    });
  });

  describe('when extracting ticket content', () => {
    it('extracts title, summary, and keywords from ticket markdown', () => {
      mockExistsSync.mockReturnValue(true);

      mockReaddirSync.mockImplementation((dir: fs.PathLike, opts?: unknown) => {
        const s = String(dir);
        if (
          s === REPO_DIR &&
          opts &&
          (opts as { withFileTypes?: boolean }).withFileTypes
        ) {
          return [createMockDirent('jira', true)];
        }
        if (s === JIRA_DIR) {
          return ['TOUR-123-ticket-description.md'];
        }
        return [];
      });

      mockStatSync.mockReturnValue(createMockStat(1000));

      mockReadFileSync.mockReturnValue(
        createMockTicketMarkdown({
          title: 'Fix PricingService timeout',
          summary:
            'The PricingService throws ECONNREFUSED in src/pricing/pricing.ts',
        }),
      );

      const result = detectPriorTickets(REPO_NAME);
      const ticket = result.tickets[0];

      expect(ticket.title).toBe('Fix PricingService timeout');
      expect(ticket.summary).toContain('PricingService throws ECONNREFUSED');
      expect(ticket.keywords).toContain('PricingService');
      expect(ticket.keywords).toContain('ECONNREFUSED');
      expect(ticket.keywords).toContain('src/pricing/pricing.ts');
    });
  });

  describe('when fs operations fail', () => {
    it('never throws on fs errors — returns empty tickets', () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation(() => {
        throw new Error('permission denied');
      });

      expect(() => detectPriorTickets(REPO_NAME)).not.toThrow();
      const result = detectPriorTickets(REPO_NAME);
      expect(result.tickets).toEqual([]);
    });
  });
});

describe('formatPriorTicketsPromptSection', () => {
  describe('when tickets list is empty', () => {
    it('returns empty string', () => {
      const ctx = createMockPriorTicketContext({ tickets: [] });
      expect(formatPriorTicketsPromptSection(ctx)).toBe('');
    });
  });

  describe('when tickets are present', () => {
    it('produces a formatted section with title and repo name', () => {
      const ctx = createMockPriorTicketContext({
        tickets: [
          createMockPriorTicketSummary({
            title: 'Fix pricing timeout',
            summary: 'The service keeps timing out',
            keywords: ['src/pricing/pricing.service.ts', 'PricingService'],
          }),
        ],
      });

      const result = formatPriorTicketsPromptSection(ctx);

      expect(result).toContain(`Related prior tickets (${REPO_NAME}):`);
      expect(result).toContain('Fix pricing timeout');
      expect(result).toContain('The service keeps timing out');
      expect(result).toContain(
        'keywords: src/pricing/pricing.service.ts, PricingService',
      );
    });

    it('caps output at 5 tickets even when more are provided', () => {
      const tickets = Array.from({ length: 8 }, (_, i) =>
        createMockPriorTicketSummary({
          title: `Ticket ${i + 1}`,
          summary: `Summary for ticket ${i + 1}`,
          filename: `ticket-${i + 1}.md`,
          keywords: [],
        }),
      );

      const ctx = createMockPriorTicketContext({ tickets });
      const result = formatPriorTicketsPromptSection(ctx);

      // Count occurrences of "- Ticket" lines
      const ticketLines = result
        .split('\n')
        .filter((line) => line.startsWith('- Ticket'));
      expect(ticketLines).toHaveLength(5);
      expect(result).not.toContain('Ticket 6');
      expect(result).not.toContain('Ticket 7');
      expect(result).not.toContain('Ticket 8');
    });

    it('omits keywords section when keywords array is empty', () => {
      const ctx = createMockPriorTicketContext({
        tickets: [
          createMockPriorTicketSummary({
            title: 'Simple ticket',
            summary: 'A plain summary',
            keywords: [],
          }),
        ],
      });

      const result = formatPriorTicketsPromptSection(ctx);
      expect(result).not.toContain('keywords:');
    });
  });
});
