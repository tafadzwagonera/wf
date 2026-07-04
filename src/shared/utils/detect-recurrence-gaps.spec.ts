import {
  filterRecurrenceCandidates,
  enrichWithCommitHistory,
  analyzeRecurrenceGaps,
  formatRecurrenceGapsPromptSection,
  CommitEvidence,
  RecurrenceCandidate,
  RecurrenceGapAnalysis,
} from './detect-recurrence-gaps';
import { PriorTicketContext, PriorTicketSummary } from './detect-prior-tickets';

jest.mock('simple-git', () => {
  const mockFn = jest.fn();
  return { __esModule: true, default: mockFn };
});

import simpleGit from 'simple-git';

const mockSimpleGit = simpleGit as jest.MockedFunction<typeof simpleGit>;

// --- Factories ---

const createMockPriorTicketSummary = (overrides: Partial<PriorTicketSummary> = {}): PriorTicketSummary => ({
  title: 'Fix PricingService timeout',
  summary: 'The PricingService throws ECONNREFUSED when calling src/pricing/pricing.ts',
  filename: 'WBP-123-ticket-description.md',
  keywords: ['PricingService', 'ECONNREFUSED', 'src/pricing/pricing.ts'],
  ...overrides,
});

const createMockPriorTicketContext = (overrides: Partial<PriorTicketContext> = {}): PriorTicketContext => ({
  tickets: [],
  repoName: 'service-tourv3',
  ...overrides,
});

const createMockCommitEvidence = (overrides: Partial<CommitEvidence> = {}): CommitEvidence => ({
  hash: 'abc1234',
  message: 'fix: resolve PricingService timeout',
  filesChanged: ['src/pricing/pricing.ts'],
  ...overrides,
});

const createMockRecurrenceCandidate = (overrides: Partial<RecurrenceCandidate> = {}): RecurrenceCandidate => ({
  title: 'Fix PricingService timeout',
  summary: 'The PricingService throws ECONNREFUSED when calling src/pricing/pricing.ts',
  ticketKey: 'WBP-123',
  overlapScore: 0.5,
  sharedKeywords: ['PricingService', 'ECONNREFUSED'],
  commits: [],
  ...overrides,
});

const createMockRecurrenceGapAnalysis = (overrides: Partial<RecurrenceGapAnalysis> = {}): RecurrenceGapAnalysis => ({
  isRecurrence: true,
  candidates: [createMockRecurrenceCandidate()],
  gaps: ['The fix did not address the retry logic'],
  rootCauseHypothesis: 'PricingService lacks circuit breaker',
  ...overrides,
});

const createMockAiExecutor = () => ({
  execute: jest.fn(),
});

// Current ticket content with shared keywords
const CURRENT_CONTENT_WITH_OVERLAP = `# Fix PricingService ECONNREFUSED error

The PricingService is throwing ECONNREFUSED errors when calling src/pricing/pricing.ts.
This needs to be resolved urgently.
`;

const CURRENT_CONTENT_NO_OVERLAP = `# Update README documentation

Just updating the readme with new deployment instructions.
`;

describe('filterRecurrenceCandidates', () => {
  describe('when current ticket shares keywords with prior tickets', () => {
    it('returns candidates above 0.2 Jaccard threshold', () => {
      const priorTickets = createMockPriorTicketContext({
        tickets: [createMockPriorTicketSummary()],
      });

      const result = filterRecurrenceCandidates(CURRENT_CONTENT_WITH_OVERLAP, priorTickets);

      expect(result).toHaveLength(1);
      expect(result[0].overlapScore).toBeGreaterThanOrEqual(0.2);
    });

    it('returns empty array when no overlap with prior tickets', () => {
      const priorTickets = createMockPriorTicketContext({
        tickets: [createMockPriorTicketSummary()],
      });

      const result = filterRecurrenceCandidates(CURRENT_CONTENT_NO_OVERLAP, priorTickets);

      expect(result).toEqual([]);
    });

    it('returns empty array when prior tickets list is empty', () => {
      const priorTickets = createMockPriorTicketContext({ tickets: [] });

      const result = filterRecurrenceCandidates(CURRENT_CONTENT_WITH_OVERLAP, priorTickets);

      expect(result).toEqual([]);
    });
  });

  describe('when extracting ticket key from filename', () => {
    it('extracts ticket key from filename like WBP-123-ticket-description.md', () => {
      const priorTickets = createMockPriorTicketContext({
        tickets: [
          createMockPriorTicketSummary({
            filename: 'WBP-456-ticket-description.md',
          }),
        ],
      });

      const result = filterRecurrenceCandidates(CURRENT_CONTENT_WITH_OVERLAP, priorTickets);

      expect(result[0].ticketKey).toBe('WBP-456');
    });

    it('sets ticketKey to null when filename does not match pattern', () => {
      const priorTickets = createMockPriorTicketContext({
        tickets: [
          createMockPriorTicketSummary({
            filename: 'random-file.md',
          }),
        ],
      });

      const result = filterRecurrenceCandidates(CURRENT_CONTENT_WITH_OVERLAP, priorTickets);

      expect(result[0].ticketKey).toBeNull();
    });

    it('prefers an explicit ticketKey on the prior ticket summary', () => {
      const priorTickets = createMockPriorTicketContext({
        tickets: [
          createMockPriorTicketSummary({
            filename: '2026-07-01-abc123-fix-plan.json',
            ticketKey: 'WBP-789',
          }),
        ],
      });

      const result = filterRecurrenceCandidates(CURRENT_CONTENT_WITH_OVERLAP, priorTickets);

      expect(result[0].ticketKey).toBe('WBP-789');
    });
  });

  describe('when sorting candidates', () => {
    it('sorts candidates by overlapScore descending', () => {
      const priorTickets = createMockPriorTicketContext({
        tickets: [
          createMockPriorTicketSummary({
            title: 'Low overlap ticket',
            keywords: ['PricingService'],
            filename: 'WBP-100-ticket-description.md',
          }),
          createMockPriorTicketSummary({
            title: 'High overlap ticket',
            keywords: ['PricingService', 'ECONNREFUSED', 'src/pricing/pricing.ts', 'timeout'],
            filename: 'WBP-200-ticket-description.md',
          }),
        ],
      });

      const result = filterRecurrenceCandidates(CURRENT_CONTENT_WITH_OVERLAP, priorTickets);

      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result[0].overlapScore).toBeGreaterThanOrEqual(result[1].overlapScore);
    });
  });

  describe('when candidates are initialized', () => {
    it('initializes commits as empty array', () => {
      const priorTickets = createMockPriorTicketContext({
        tickets: [createMockPriorTicketSummary()],
      });

      const result = filterRecurrenceCandidates(CURRENT_CONTENT_WITH_OVERLAP, priorTickets);

      expect(result[0].commits).toEqual([]);
    });
  });
});

describe('enrichWithCommitHistory', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('when git log returns commits for ticket key', () => {
    it('populates commit evidence from git log', async () => {
      const mockGit = {
        raw: jest.fn(),
      };

      mockSimpleGit.mockReturnValue(mockGit as any);

      mockGit.raw
        .mockResolvedValueOnce('abc1234 fix: resolve PricingService timeout\ndef5678 fix: retry logic\n')
        .mockResolvedValueOnce('src/pricing/pricing.ts\nsrc/pricing/pricing.service.ts\n')
        .mockResolvedValueOnce('src/pricing/retry.ts\n');

      const candidates = [createMockRecurrenceCandidate({ ticketKey: 'WBP-123' })];

      const result = await enrichWithCommitHistory(candidates, '/fake/repo');

      expect(result[0].commits).toHaveLength(2);
      expect(result[0].commits[0].hash).toBe('abc1234');
      expect(result[0].commits[0].message).toBe('fix: resolve PricingService timeout');
      expect(result[0].commits[0].filesChanged).toContain('src/pricing/pricing.ts');
      expect(result[0].commits[1].hash).toBe('def5678');
    });
  });

  describe('when git fails', () => {
    it('returns candidates unchanged when simpleGit throws', async () => {
      mockSimpleGit.mockImplementation(() => {
        throw new Error('not a git repository');
      });

      const candidates = [createMockRecurrenceCandidate()];

      const result = await enrichWithCommitHistory(candidates, '/not-a-repo');

      expect(result).toEqual(candidates);
    });

    it('returns candidates unchanged when git log throws for a candidate', async () => {
      const mockGit = {
        raw: jest.fn().mockRejectedValue(new Error('git log failed')),
      };

      mockSimpleGit.mockReturnValue(mockGit as any);

      const candidates = [createMockRecurrenceCandidate({ ticketKey: 'WBP-123' })];

      const result = await enrichWithCommitHistory(candidates, '/fake/repo');

      expect(result[0].commits).toEqual([]);
    });
  });

  describe('when candidate has null ticketKey', () => {
    it('skips git lookup and returns candidate unchanged', async () => {
      const mockGit = {
        raw: jest.fn(),
      };

      mockSimpleGit.mockReturnValue(mockGit as any);

      const candidates = [createMockRecurrenceCandidate({ ticketKey: null })];

      const result = await enrichWithCommitHistory(candidates, '/fake/repo');

      expect(mockGit.raw).not.toHaveBeenCalled();
      expect(result[0].commits).toEqual([]);
    });
  });
});

describe('analyzeRecurrenceGaps', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('when AI responds successfully', () => {
    it('calls AI with correct prompt and parses response', async () => {
      const mockAiExecutor = createMockAiExecutor();
      mockAiExecutor.execute.mockResolvedValue({
        content: JSON.stringify({
          isRecurrence: true,
          gaps: ['The fix did not address the retry logic'],
          rootCauseHypothesis: 'PricingService lacks circuit breaker',
        }),
      });

      const candidates = [createMockRecurrenceCandidate()];

      const result = await analyzeRecurrenceGaps(CURRENT_CONTENT_WITH_OVERLAP, candidates, mockAiExecutor);

      expect(mockAiExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          maxTokens: 1024,
          stage: 'plan',
          prompt: expect.stringContaining('Fix PricingService timeout'),
        })
      );
      expect(result).not.toBeNull();
      expect(result!.isRecurrence).toBe(true);
      expect(result!.gaps).toContain('The fix did not address the retry logic');
      expect(result!.rootCauseHypothesis).toBe('PricingService lacks circuit breaker');
      expect(result!.candidates).toEqual(candidates);
    });

    it('parses response wrapped in code fences', async () => {
      const mockAiExecutor = createMockAiExecutor();
      mockAiExecutor.execute.mockResolvedValue({
        content: '```json\n{"isRecurrence":true,"gaps":["gap1"],"rootCauseHypothesis":null}\n```',
      });

      const result = await analyzeRecurrenceGaps(
        CURRENT_CONTENT_WITH_OVERLAP,
        [createMockRecurrenceCandidate()],
        mockAiExecutor
      );

      expect(result).not.toBeNull();
      expect(result!.isRecurrence).toBe(true);
    });
  });

  describe('when AI fails', () => {
    it('returns null on AI network error', async () => {
      const mockAiExecutor = createMockAiExecutor();
      mockAiExecutor.execute.mockRejectedValue(new Error('network error'));

      const result = await analyzeRecurrenceGaps(
        CURRENT_CONTENT_WITH_OVERLAP,
        [createMockRecurrenceCandidate()],
        mockAiExecutor
      );

      expect(result).toBeNull();
    });

    it('returns null when AI returns invalid JSON', async () => {
      const mockAiExecutor = createMockAiExecutor();
      mockAiExecutor.execute.mockResolvedValue({ content: 'not valid json' });

      const result = await analyzeRecurrenceGaps(
        CURRENT_CONTENT_WITH_OVERLAP,
        [createMockRecurrenceCandidate()],
        mockAiExecutor
      );

      expect(result).toBeNull();
    });

    it('returns null when candidates list is empty', async () => {
      const mockAiExecutor = createMockAiExecutor();

      const result = await analyzeRecurrenceGaps(CURRENT_CONTENT_WITH_OVERLAP, [], mockAiExecutor);

      expect(result).toBeNull();
      expect(mockAiExecutor.execute).not.toHaveBeenCalled();
    });
  });
});

describe('formatRecurrenceGapsPromptSection', () => {
  describe('when analysis indicates a recurrence', () => {
    it('formats correctly with all sections', () => {
      const analysis = createMockRecurrenceGapAnalysis({
        candidates: [
          createMockRecurrenceCandidate({
            commits: [createMockCommitEvidence()],
          }),
        ],
      });

      const result = formatRecurrenceGapsPromptSection(analysis);

      expect(result).toContain('Recurring issue detected:');
      expect(result).toContain('1 prior tickets in this repository:');
      expect(result).toContain('Fix PricingService timeout');
      expect(result).toContain('shared: PricingService, ECONNREFUSED');
      expect(result).toContain('abc1234');
      expect(result).toContain('fix: resolve PricingService timeout');
      expect(result).toContain('changed: src/pricing/pricing.ts');
      expect(result).toContain('Implementation gaps identified in prior attempts:');
      expect(result).toContain('The fix did not address the retry logic');
      expect(result).toContain('Root cause hypothesis: PricingService lacks circuit breaker');
      expect(result).toContain('IMPORTANT: Address the identified gaps');
    });

    it('omits gaps section when gaps array is empty', () => {
      const analysis = createMockRecurrenceGapAnalysis({ gaps: [] });

      const result = formatRecurrenceGapsPromptSection(analysis);

      expect(result).not.toContain('Implementation gaps identified');
    });

    it('omits root cause section when rootCauseHypothesis is null', () => {
      const analysis = createMockRecurrenceGapAnalysis({
        rootCauseHypothesis: null,
      });

      const result = formatRecurrenceGapsPromptSection(analysis);

      expect(result).not.toContain('Root cause hypothesis:');
    });
  });

  describe('when analysis is not a recurrence', () => {
    it('returns empty string when isRecurrence is false', () => {
      const analysis = createMockRecurrenceGapAnalysis({ isRecurrence: false });

      const result = formatRecurrenceGapsPromptSection(analysis);

      expect(result).toBe('');
    });
  });
});
