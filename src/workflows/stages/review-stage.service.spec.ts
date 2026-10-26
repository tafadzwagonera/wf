import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AiService } from '../../integrations/ai/ai.service';
import { ReviewStageService } from './review-stage.service';
import { StageAgentService } from '../../integrations/ai/stage-agent.service';
import { codeReviewSchema } from '../../common/schemas/review.schema';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AiProviderError } from '../../common/utils/errors';
import { createTempDir as createManagedTempDir } from '../../common/testing/temp-dir';

describe('ReviewStageService', () => {
  const mockReview = {
    summary: 'Looks good overall',
    issues: [],
    traceProvenance: 'best-effort',
    callStack: [
      {
        frame: 'TripcomController.syncProduct(productCode, slug)',
        children: [
          {
            frame: 'TripcomService.syncProductContent(productCode, slug)',
            children: [
              {
                frame: 'TripcomService.getTourBySlug(slug)',
                children: [
                  {
                    frame: 'AgentApiClient.fetchAgentApiData()',
                    children: [
                      {
                        frame: 'HttpClient.get(GET https://agentapi.expatexplore.com/agent/1.0/data)',
                      },
                    ],
                  },
                ],
              },
              {
                frame: 'TripcomMapper.mapAgentApiToTripcom(productCode, tour)',
                children: [
                  {
                    frame: 'TripcomMapper.mapGalleryToMedias(tour.gallery, tour.title)',
                    children: [
                      {
                        frame: 'Array.prototype.slice(0, 10)',
                      },
                    ],
                  },
                  {
                    frame: 'TripcomMapper.mapItineraryToTourInfoList(tour)',
                  },
                  {
                    frame: 'TripcomMapper.mapIncludedToClauses(tour)',
                  },
                ],
              },
              {
                frame: 'TripcomApiClient.syncProduct(mappedProduct)',
                children: [
                  {
                    frame: 'HttpClient.post(POST {TRIPCOM_API_URL}/syncProduct)',
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    stateTransition: {
      from: 'canonicalCustomerId',
      to: 'ProfileResponse.linkedProfiles',
      steps: [
        {
          frame: 'CanonicalProfileRepository.findLinkedProfiles(canonicalCustomerId)',
          captured: [
            { name: 'canonicalCustomerId', value: '123' },
          ],
          changes: [
            {
              name: 'firstName.dep',
              after: {
                version: 1,
                subs: 'Link_1',
                subsHead: 'Link_1',
                sc: 1,
              },
            },
          ],
          children: [
            {
              frame:
                'CanonicalLinkRepository.find({ where: { canonicalCustomerId, linkStatus: CanonicalLinkStatus.Merged } })',
              changes: [
                {
                  name: 'lastName.dep',
                  after: {
                    version: 1,
                    subs: 'Link_2',
                    subsHead: 'Link_2',
                    sc: 1,
                  },
                },
              ],
              children: [
                {
                  frame:
                    'CanonicalProfileRepository.findLinkedProfiles(...): In([...customerIds]) -> AppGoldenCustomerProfile[]',
                  changes: [
                    {
                      name: 'fullName.dep',
                      before: {
                        version: 1,
                      },
                      after: {
                        version: 0,
                        subs: 'Link_3',
                        subsHead: 'Link_3',
                        computed: 'fullName',
                        sc: 1,
                      },
                    },
                  ],
                  children: [
                    {
                      frame: 'ProfileResponseDto.linkedProfiles',
                      captured: [
                        { name: 'fullName._value', value: 'Jane Smith' },
                      ],
                      children: [
                        {
                          frame: 'LinkedProfileSummaryDto',
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    suggestions: ['Add one more regression test'],
    approved: true,
  };

  const buildService = async ({
    agentEnabled = false,
    reviewBackend,
    reviewSkills,
    mockStageExecutionMode = 'agent',
  }: {
    agentEnabled?: boolean;
    reviewBackend?: 'agent' | 'cli' | 'standard';
    reviewSkills?: string[];
    mockStageExecutionMode?: 'agent' | 'cli';
  } = {}) => {
    const module = await Test.createTestingModule({
      providers: [
        ReviewStageService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, fallback?: unknown) => {
              if (key === 'stages.review.backend') return reviewBackend ?? fallback;
              if (key === 'stages.review.skills') return reviewSkills;
              return fallback;
            }),
          },
        },
        {
          provide: AiService,
          useValue: {
            reviewCode: jest.fn().mockResolvedValue(mockReview),
            execute: jest.fn().mockResolvedValue({ content: '- summary item' }),
          },
        },
        {
          provide: StageAgentService,
          useValue: {
            isEnabledForStage: jest.fn().mockReturnValue(agentEnabled),
            reviewCode: jest.fn().mockResolvedValue({
              review: {
                ...mockReview,
                executionMode: mockStageExecutionMode,
              },
            }),
            chatTurn: jest.fn().mockResolvedValue({ content: '- agent summary', session: {} }),
          },
        },
      ],
    }).compile();

    return {
      service: module.get(ReviewStageService),
      aiService: module.get(AiService),
      stageAgentService: module.get(StageAgentService),
    };
  };

  afterEach(() => jest.restoreAllMocks());

  it('builds default review guidelines around the provided context', async () => {
    const { service, aiService } = await buildService();

    await service.reviewDiff('diff --git a/file b/file', {
      context: 'ticket WBP-123: Fix auth callback',
      extraCriteria: ['Accessibility: keyboard flow still works'],
    });

    expect(aiService.reviewCode).toHaveBeenCalledWith(
      'diff --git a/file b/file',
      expect.arrayContaining([
        expect.stringContaining('Clarity'),
        expect.stringContaining('Scope & necessity'),
        expect.stringContaining('ticket WBP-123: Fix auth callback'),
        'Accessibility: keyboard flow still works',
      ]),
      undefined
    );
  });

  it.each(['Contracts', 'Ripple effects', 'Documentation', 'Testing', 'Accessibility', 'Scope & necessity'])(
    'includes the %s criterion in the assembled guidelines',
    async criterion => {
      const { service, aiService } = await buildService();

      await service.reviewDiff('diff --git a/file b/file', {
        context: 'ticket WBP-200: Smoke test',
      });

      expect(aiService.reviewCode).toHaveBeenCalledWith(
        'diff --git a/file b/file',
        expect.arrayContaining([expect.stringContaining(criterion)]),
        undefined
      );
    }
  );

  it('keeps ticket and Sonar context when replaceCriteria is enabled', async () => {
    const { service, aiService } = await buildService();

    await service.reviewDiff('diff --git a/file b/file', {
      context: 'ticket WBP-200: Smoke test',
      additionalContextSections: ['SonarQube analyze findings:\nRule hit'],
      extraCriteria: ['Only check this'],
      replaceCriteria: true,
    });

    expect(aiService.reviewCode).toHaveBeenCalledWith(
      'diff --git a/file b/file',
      expect.arrayContaining([
        expect.stringContaining('ticket WBP-200: Smoke test'),
        expect.stringContaining('SonarQube analyze findings'),
        'Only check this',
      ]),
      undefined
    );
  });

  it('writes a markdown review artifact for workflow review stage consumers', async () => {
    const { service } = await buildService();
    const tempDir = createManagedTempDir('review');
    const ticketPath = path.join(tempDir, 'WBP-123.md');
    fs.writeFileSync(ticketPath, '# WBP-123: Fix auth callback');

    const artifact = service.createReviewArtifact(
      {
        ticketKey: 'WBP-123',
        content: '# WBP-123: Fix auth callback',
        path: ticketPath,
      },
      mockReview as any
    );

    expect(fs.readFileSync(path.join(tempDir, 'WBP-123-review.md'), 'utf-8')).toContain('# Code Review: WBP-123');

    const reviewMarkdown = fs.readFileSync(path.join(tempDir, 'WBP-123-review.md'), 'utf-8');
    expect(reviewMarkdown.indexOf('## Summary')).toBeLessThan(reviewMarkdown.indexOf('## Issues'));
    expect(reviewMarkdown.indexOf('## Issues')).toBeLessThan(reviewMarkdown.indexOf('## Call Stack'));
    expect(reviewMarkdown).toContain('Provenance: best-effort');
    expect(reviewMarkdown).toContain('Execution mode: standard');
    expect(reviewMarkdown.indexOf('## Call Stack')).toBeLessThan(reviewMarkdown.indexOf('## State Transition'));
    expect(reviewMarkdown).toContain('TripcomController.syncProduct(productCode, slug)');
    expect(reviewMarkdown).toContain('CanonicalProfileRepository.findLinkedProfiles(canonicalCustomerId)');
    expect(reviewMarkdown).toContain('firstName.dep =');
    expect(reviewMarkdown).toContain('fullName._value = Jane Smith');
    expect(reviewMarkdown.indexOf('## State Transition')).toBeLessThan(reviewMarkdown.indexOf('## Suggestions'));
    expect(reviewMarkdown.indexOf('## Suggestions')).toBeLessThan(reviewMarkdown.indexOf('## Approval Status'));
    expect(reviewMarkdown).toContain('Provenance: best-effort');
    expect(artifact.path).toBe(path.join(tempDir, 'WBP-123-review.md'));
    expect(artifact.approved).toBe(true);
  });

  it('renders issue-local suggestions and leaves unmatched extras in a trailing section', async () => {
    const { service } = await buildService();
    const tempDir = createManagedTempDir('review');
    const ticketPath = path.join(tempDir, 'WBP-125.md');
    fs.writeFileSync(ticketPath, '# WBP-125: Review formatting');

    const artifact = service.createReviewArtifact(
      {
        ticketKey: 'WBP-125',
        content: '# WBP-125: Review formatting',
        path: ticketPath,
      },
      {
        ...mockReview,
        issues: [
          {
            severity: 'warning',
            message: 'First issue',
            file: 'src/first.ts',
            line: 10,
            suggestion: 'First suggestion',
          },
          {
            severity: 'error',
            message: 'Second issue',
            file: 'src/second.ts',
            line: 20,
            suggestion: 'Second suggestion',
          },
        ],
        suggestions: ['Trailing idea'],
      } as any
    );

    const reviewMarkdown = fs.readFileSync(artifact.path, 'utf-8');
    expect(reviewMarkdown).toContain('- [warning] First issue (src/first.ts:10)');
    expect(reviewMarkdown).toContain('  - Suggestion: First suggestion');
    expect(reviewMarkdown.indexOf('First issue')).toBeLessThan(reviewMarkdown.indexOf('Suggestion: First suggestion'));
    expect(reviewMarkdown.indexOf('Suggestion: First suggestion')).toBeLessThan(reviewMarkdown.indexOf('Second issue'));
    expect(reviewMarkdown).toContain('## Suggestions');
    expect(reviewMarkdown).toContain('- Trailing idea');
  });

  it('renders the risk and risk-adjusted severity on persisted issue rows', async () => {
    const { service } = await buildService();
    const tempDir = createManagedTempDir('review');
    const ticketPath = path.join(tempDir, 'WBP-126.md');
    fs.writeFileSync(ticketPath, '# WBP-126: Risk-adjusted rows');

    const artifact = service.createReviewArtifact(
      {
        ticketKey: 'WBP-126',
        content: '# WBP-126: Risk-adjusted rows',
        path: ticketPath,
      },
      {
        ...mockReview,
        issues: [
          { severity: 'error', risk: 0.5, message: 'Unlikely regression', file: 'src/first.ts', line: 10 },
        ],
      } as any
    );

    const reviewMarkdown = fs.readFileSync(artifact.path, 'utf-8');
    expect(reviewMarkdown).toContain('- [error → warning (risk 0.5)] Unlikely regression (src/first.ts:10)');
  });

  it('marks agent-backed traces as evidence-based when trace payload exists', async () => {
    const { service, aiService, stageAgentService } = await buildService({
      agentEnabled: true,
      reviewBackend: 'agent',
    });
    const { review } = await service.reviewDiff('diff --git a/file b/file', {
      context: 'ticket WBP-124: Agent-backed review',
      repoDir: '/tmp/repo',
    });

    const tempDir = createManagedTempDir('review-agent');
    const ticketPath = path.join(tempDir, 'WBP-124.md');
    fs.writeFileSync(ticketPath, '# WBP-124: Agent-backed review');

    const artifact = service.createReviewArtifact(
      {
        ticketKey: 'WBP-124',
        content: '# WBP-124: Agent-backed review',
        path: ticketPath,
      },
      review
    );

    const reviewMarkdown = fs.readFileSync(artifact.path, 'utf-8');
    expect(stageAgentService.reviewCode).toHaveBeenCalled();
    expect(stageAgentService.reviewCode).toHaveBeenCalledWith(
      'diff --git a/file b/file',
      expect.any(Array),
      '/tmp/repo',
      undefined,
      undefined,
      undefined,
      { skillNames: undefined, forkSession: undefined }
    );
    expect(aiService.reviewCode).not.toHaveBeenCalled();
    expect(review.executionMode).toBe('agent');
    expect(reviewMarkdown).toContain('Execution mode: agent');
    expect(reviewMarkdown).toContain('Provenance: evidence-based');
  });

  it('marks cli-backed traces as evidence-based when trace payload exists', async () => {
    const { service, aiService, stageAgentService } = await buildService({
      agentEnabled: true,
      reviewBackend: 'cli',
      mockStageExecutionMode: 'cli',
    });
    const { review } = await service.reviewDiff('diff --git a/file b/file', {
      context: 'ticket WBP-129: CLI-backed review',
      repoDir: '/tmp/repo',
    });

    const tempDir = createManagedTempDir('review-cli');
    const ticketPath = path.join(tempDir, 'WBP-129.md');
    fs.writeFileSync(ticketPath, '# WBP-129: CLI-backed review');

    const artifact = service.createReviewArtifact(
      {
        ticketKey: 'WBP-129',
        content: '# WBP-129: CLI-backed review',
        path: ticketPath,
      },
      review
    );

    const reviewMarkdown = fs.readFileSync(artifact.path, 'utf-8');
    expect(stageAgentService.reviewCode).toHaveBeenCalled();
    expect(stageAgentService.reviewCode).toHaveBeenCalledWith(
      'diff --git a/file b/file',
      expect.any(Array),
      '/tmp/repo',
      undefined,
      undefined,
      undefined,
      { skillNames: undefined, forkSession: undefined }
    );
    expect(aiService.reviewCode).not.toHaveBeenCalled();
    expect(review.executionMode).toBe('cli');
    expect(reviewMarkdown).toContain('Execution mode: cli');
    expect(reviewMarkdown).toContain('Provenance: evidence-based');
  });

  it('preserves agent execution mode when the review backend is inferred', async () => {
    const { service, aiService, stageAgentService } = await buildService({
      agentEnabled: true,
    });

    const { review } = await service.reviewDiff('diff --git a/file b/file', {
      context: 'ticket WBP-127: Inferred agent review',
      repoDir: '/tmp/repo',
    });

    const tempDir = createManagedTempDir('review-agent-default');
    const ticketPath = path.join(tempDir, 'WBP-127.md');
    fs.writeFileSync(ticketPath, '# WBP-127: Inferred agent review');

    const artifact = service.createReviewArtifact(
      {
        ticketKey: 'WBP-127',
        content: '# WBP-127: Inferred agent review',
        path: ticketPath,
      },
      review
    );

    const reviewMarkdown = fs.readFileSync(artifact.path, 'utf-8');
    expect(stageAgentService.reviewCode).toHaveBeenCalled();
    expect(aiService.reviewCode).not.toHaveBeenCalled();
    expect(review.executionMode).toBe('agent');
    expect(reviewMarkdown).toContain('Execution mode: agent');
    expect(reviewMarkdown).toContain('Provenance: evidence-based');
  });

  it.each(['standard', 'agent', 'cli'] as const)('accepts executionMode "%s" in codeReviewSchema', mode => {
    const result = codeReviewSchema.safeParse({
      summary: 'OK',
      issues: [],
      suggestions: [],
      approved: true,
      executionMode: mode,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown executionMode in codeReviewSchema', () => {
    const result = codeReviewSchema.safeParse({
      summary: 'OK',
      issues: [],
      suggestions: [],
      approved: true,
      executionMode: 'unknown',
    });
    expect(result.success).toBe(false);
  });

  it('propagates empty-response AI errors from the standard review path', async () => {
    const { service, aiService } = await buildService();
    (aiService.reviewCode as jest.Mock).mockRejectedValueOnce(
      new AiProviderError('AI provider returned an empty review response', {
        provider: 'google',
        model: 'gemini-2.5-pro',
      })
    );

    await expect(
      service.reviewDiff('diff --git a/file b/file', {
        context: 'ticket WBP-126: Empty AI review response',
      })
    ).rejects.toMatchObject({
      message: 'AI provider returned an empty review response',
      details: expect.objectContaining({
        provider: 'google',
        model: 'gemini-2.5-pro',
      }),
    });
  });

  it('should invoke onProgress during diff summarisation when threshold exceeded', async () => {
    const { service } = await buildService({ agentEnabled: false });
    const onProgress = jest.fn();
    const largeFile = 'x'.repeat(50000);
    const diff = `diff --git a/file b/file
--- a/file
+++ b/file
@@ -1 +1 @@
-${largeFile}
+${largeFile}y`;

    await service.reviewDiff(diff, {
      context: 'test context',
      onProgress,
    });

    expect(onProgress).toHaveBeenCalledWith(expect.stringMatching(/Summarising changes in/));
  });

  it('logs and reports a failed diff summarisation attempt before continuing with the raw patch', async () => {
    const { service, aiService } = await buildService({ agentEnabled: false });
    const onProgress = jest.fn();
    const appendSpy = jest.spyOn(require('../../common/logger/log-file-writer'), 'appendToLogFile').mockImplementation(() => {});
    (aiService.execute as jest.Mock).mockRejectedValueOnce(new Error('summary offline'));
    const diff = `diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-${'x'.repeat(50000)}\n+${'x'.repeat(50000)}y`;

    await service.reviewDiff(diff, { context: 'test context', onProgress });

    expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('Review diff summarisation failed for file'));
    expect(appendSpy).toHaveBeenCalledWith(
      'WARN',
      expect.stringContaining('Review diff summarisation failed for file (original='),
      'review-stage'
    );
    expect(aiService.reviewCode).toHaveBeenCalledWith(expect.stringContaining('diff --git a/file b/file'), expect.any(Array), onProgress);
  });

  it('bounds successful summaries so the diff does not remain oversized', async () => {
    const { service, aiService } = await buildService({ agentEnabled: false });
    const onProgress = jest.fn();
    const appendSpy = jest.spyOn(require('../../common/logger/log-file-writer'), 'appendToLogFile').mockImplementation(() => {});
    (aiService.execute as jest.Mock).mockResolvedValue({ content: '- ' + 'y'.repeat(90000) });
    const diff = `diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-${'x'.repeat(50000)}\n+${'x'.repeat(50000)}y`;

    await service.reviewDiff(diff, { context: 'test context', onProgress });

    expect(onProgress).not.toHaveBeenCalledWith(expect.stringContaining('Review diff remains oversized after summarisation'));
    expect(appendSpy).not.toHaveBeenCalledWith(
      'WARN',
      expect.stringContaining('Review diff remains oversized after summarisation'),
      'review-stage'
    );
  });

  it('uses stages.review.maxDiffLength from config as the diff threshold', async () => {
    const customThreshold = 200;
    const module = await Test.createTestingModule({
      providers: [
        ReviewStageService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, fallback?: unknown) => {
              if (key === 'stages.review.maxDiffLength') return customThreshold;
              if (key === 'stages.review.backend') return fallback;
              if (key === 'stages.review.skills') return [];
              return fallback;
            }),
          },
        },
        {
          provide: AiService,
          useValue: {
            reviewCode: jest.fn().mockResolvedValue(mockReview),
            execute: jest.fn().mockResolvedValue({ content: '- '.repeat(200) }),
          },
        },
        {
          provide: StageAgentService,
          useValue: {
            isEnabledForStage: jest.fn().mockReturnValue(false),
            reviewCode: jest.fn().mockResolvedValue({ review: mockReview }),
            chatTurn: jest.fn(),
          },
        },
      ],
    }).compile();

    const service = module.get(ReviewStageService);
    const onProgress = jest.fn();
    const appendSpy = jest.spyOn(require('../../common/logger/log-file-writer'), 'appendToLogFile').mockImplementation(() => {});
    const diff = `diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-${'x'.repeat(500)}\n+${'x'.repeat(500)}y`;

    await service.reviewDiff(diff, { context: 'test context', onProgress });

    expect(onProgress).toHaveBeenCalledWith(expect.stringContaining(`/${customThreshold} chars`));
    expect(appendSpy).toHaveBeenCalledWith('WARN', expect.stringContaining(`/${customThreshold} chars`), 'review-stage');
  });

  it('batches oversized file summarisation into a single stageAgentService.chatTurn call with batch prompt format', async () => {
    const { service, stageAgentService, aiService } = await buildService({ agentEnabled: true, reviewBackend: 'agent' });
    const largeDiff = `diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-${'x'.repeat(50000)}\n+${'x'.repeat(50000)}y`;
    (stageAgentService as any).chatTurn.mockResolvedValue({
      content: '=== FILE: file ===\n- agent summary',
      session: {},
    });

    await service.reviewDiff(largeDiff, { context: 'test context' });

    expect((stageAgentService as any).chatTurn).toHaveBeenCalledTimes(1);
    const call = (stageAgentService as any).chatTurn.mock.calls[0][0];
    expect(call.userMessage).toMatch(/summarise only/i);
    expect(call.userMessage).toContain('File: file');
    expect(call.systemPrompt).toContain('=== FILE: <path> ===');
    expect(typeof call.jsonSchema).toBe('string');
    expect(call.jsonSchema).toContain('summaries');
    expect(call.responseValidator).toEqual(expect.objectContaining({ label: 'batch summary' }));
    expect((aiService as any).execute).not.toHaveBeenCalled();
  });

  it('applies summaries from structured JSON batch responses', async () => {
    const { service, stageAgentService } = await buildService({ agentEnabled: true, reviewBackend: 'agent' });
    const largeDiff = `diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-${'x'.repeat(50000)}\n+${'x'.repeat(50000)}y`;
    (stageAgentService as any).chatTurn.mockResolvedValue({
      content: JSON.stringify({ summaries: [{ file: 'file', summary: '- structured summary' }] }),
      session: {},
    });

    await service.reviewDiff(largeDiff, { context: 'test context' });

    const reviewedDiff = (stageAgentService as any).reviewCode.mock.calls[0][0] as string;
    expect(reviewedDiff).toContain('- structured summary');
    expect(reviewedDiff).toContain('(summarised)');
  });

  it('falls back to delimiter parsing when the batch response is not structured JSON', async () => {
    const { service, stageAgentService } = await buildService({ agentEnabled: true, reviewBackend: 'agent' });
    const largeDiff = `diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-${'x'.repeat(50000)}\n+${'x'.repeat(50000)}y`;
    (stageAgentService as any).chatTurn.mockResolvedValue({
      content: '=== FILE: file ===\n- delimiter summary',
      session: {},
    });

    await service.reviewDiff(largeDiff, { context: 'test context' });

    const reviewedDiff = (stageAgentService as any).reviewCode.mock.calls[0][0] as string;
    expect(reviewedDiff).toContain('- delimiter summary');
  });

  it('returns an empty Map without logging a parse miss when the structured response has no entries', async () => {
    const { service, stageAgentService } = await buildService({ agentEnabled: true, reviewBackend: 'agent' });
    const appendSpy = jest.spyOn(require('../../common/logger/log-file-writer'), 'appendToLogFile').mockImplementation(() => {});
    const largeDiff = `diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-${'x'.repeat(50000)}\n+${'x'.repeat(50000)}y`;
    (stageAgentService as any).chatTurn.mockResolvedValue({ content: '{"summaries":[]}', session: {} });

    await service.reviewDiff(largeDiff, { context: 'test context' });

    expect(appendSpy).not.toHaveBeenCalledWith('DEBUG', expect.stringContaining('batch_summary_parse_miss'), expect.anything());
  });

  it('logs a DEBUG parse miss with the raw content head when the batch response is unusable', async () => {
    const { service, stageAgentService } = await buildService({ agentEnabled: true, reviewBackend: 'agent' });
    const appendSpy = jest.spyOn(require('../../common/logger/log-file-writer'), 'appendToLogFile').mockImplementation(() => {});
    const largeDiff = `diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-${'x'.repeat(50000)}\n+${'x'.repeat(50000)}y`;
    (stageAgentService as any).chatTurn.mockResolvedValue({ content: 'no delimiters here', session: {} });

    await service.reviewDiff(largeDiff, { context: 'test context' });

    expect(appendSpy).toHaveBeenCalledWith(
      'DEBUG',
      expect.stringContaining('review-stage.batch_summary_parse_miss contentChars=18'),
      'review-stage'
    );
    expect(appendSpy).toHaveBeenCalledWith(
      'DEBUG',
      expect.stringContaining('head=no delimiters here'),
      'review-stage'
    );
  });

  it('sends a single chatTurn call for multiple oversized files when they fit within one chunk', async () => {
    const { service, stageAgentService } = await buildService({ agentEnabled: true, reviewBackend: 'agent' });
    const patch = 'x'.repeat(20_000);
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
    const diff = files.map(f => `diff --git a/${f} b/${f}\n${patch}`).join('\n');
    (stageAgentService as any).chatTurn.mockResolvedValue({
      content: files.map(f => `=== FILE: ${f} ===\n- changed ${f}`).join('\n'),
      session: {},
    });

    await service.reviewDiff(diff, { context: 'test context' });

    expect((stageAgentService as any).chatTurn).toHaveBeenCalledTimes(1);
    const call = (stageAgentService as any).chatTurn.mock.calls[0][0];
    expect(call.userMessage).toContain('File: a.ts');
    expect(call.userMessage).toContain('File: b.ts');
  });

  it('calls chatTurn once per chunk when selected segments span multiple chunks', async () => {
    const { service, stageAgentService } = await buildService({ agentEnabled: true, reviewBackend: 'agent' });
    const patch = 'x'.repeat(20_000);
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'];
    const diff = files.map(f => `diff --git a/${f} b/${f}\n${patch}`).join('\n');
    (stageAgentService as any).chatTurn
      .mockResolvedValueOnce({
        content: ['a.ts', 'b.ts'].map(f => `=== FILE: ${f} ===\n- changed ${f}`).join('\n'),
        session: {},
      })
      .mockResolvedValueOnce({
        content: ['c.ts', 'd.ts'].map(f => `=== FILE: ${f} ===\n- changed ${f}`).join('\n'),
        session: {},
      });

    await service.reviewDiff(diff, { context: 'test context' });

    expect((stageAgentService as any).chatTurn).toHaveBeenCalledTimes(2);
  });

  it('should forward onProgress to stageAgentService.reviewCode when agent backend is enabled', async () => {
    const { service, stageAgentService } = await buildService({ agentEnabled: true });
    const onProgress = jest.fn();

    await service.reviewDiff('diff --git a/file b/file', {
      context: 'test context',
      onProgress,
    });

    expect(stageAgentService.reviewCode).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      undefined,
      undefined,
      undefined,
      onProgress,
      { skillNames: undefined, forkSession: undefined }
    );
  });

  it('should forward onProgress to aiService.reviewCode when agent backend is disabled', async () => {
    const { service, aiService } = await buildService({ agentEnabled: false });
    const onProgress = jest.fn();

    await service.reviewDiff('diff --git a/file b/file', {
      context: 'test context',
      onProgress,
    });

    expect(aiService.reviewCode).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      onProgress
    );
  });

  describe('agent parse-error recovery', () => {
    it('recovers a valid review via validateReviewJson when the agent throws a parse AiProviderError', async () => {
      const recoveredReview = {
        ...mockReview,
        executionMode: 'standard' as const,
        repairStrategy: 'validation' as const,
      };
      const { service, stageAgentService, aiService } = await buildService({
        agentEnabled: true,
        reviewBackend: 'agent',
      });
      (stageAgentService.reviewCode as jest.Mock).mockRejectedValueOnce(
        new AiProviderError('Review JSON could not be corrected', {
          response: JSON.stringify({
            summary: mockReview.summary,
            issues: [],
            suggestions: mockReview.suggestions,
            approved: mockReview.approved,
          }),
        }, true, 'parse')
      );
      const svc = aiService as unknown as Record<string, unknown>;
      svc.validateReviewJson = jest.fn().mockResolvedValue(recoveredReview);

      const { review } = await service.reviewDiff('diff --git a/file b/file', {
        context: 'ticket WBP-REC: Recovery test',
        repoDir: '/tmp/repo',
      });

      expect(review.executionMode).toBe('standard');
      expect(review.repairStrategy).toBe('validation');
      expect(svc.validateReviewJson).toHaveBeenCalledWith(
        expect.any(String),
        'diff --git a/file b/file'
      );
    });

    it('rethrows non-parse AiProviderErrors from the agent without recovery', async () => {
      const { service, stageAgentService } = await buildService({
        agentEnabled: true,
        reviewBackend: 'agent',
      });
      (stageAgentService.reviewCode as jest.Mock).mockRejectedValueOnce(
        new AiProviderError('API rate limit exceeded', {}, false, 'api')
      );

      await expect(
        service.reviewDiff('diff --git a/file b/file', {
          context: 'ticket WBP-NREC: Non-recoverable',
          repoDir: '/tmp/repo',
        })
      ).rejects.toMatchObject({ message: 'API rate limit exceeded' });
    });
  });

  describe('reviewViaAgent', () => {
    it('surfaces sessionId from agent backend on success', async () => {
      const { service, stageAgentService } = await buildService({ agentEnabled: true });
      (stageAgentService.reviewCode as jest.Mock).mockResolvedValue({
        review: { ...mockReview, executionMode: 'agent' as const },
        sessionId: 'review-sess-1',
      });

      const result = await service.reviewDiff('diff', { context: 'ticket WBP-SID: Session ID test' });

      expect(result.sessionId).toBe('review-sess-1');
    });

    it('preserves sessionId through parse error recovery', async () => {
      const { service, stageAgentService, aiService } = await buildService({
        agentEnabled: true,
        reviewBackend: 'agent',
      });
      (stageAgentService.reviewCode as jest.Mock).mockRejectedValueOnce(
        new AiProviderError('parse fail', {
          response: JSON.stringify({ summary: 'ok', issues: [], suggestions: [], approved: true }),
          sessionId: 'review-sess-2',
        }, true, 'parse')
      );
      const svc = aiService as unknown as Record<string, unknown>;
      svc.validateReviewJson = jest.fn().mockResolvedValue({ ...mockReview, executionMode: 'standard' as const });

      const result = await service.reviewDiff('diff', { context: 'ticket WBP-SID2: Session ID recovery' });

      expect(result.sessionId).toBe('review-sess-2');
    });
  });

  describe('Comments guideline and commentPolicyEnabled suppression', () => {
    it('includes the Comments guideline when commentPolicyEnabled is not set', async () => {
      const { service, aiService } = await buildService();

      await service.reviewDiff('diff --git a/file b/file', { context: 'ctx' });

      expect(aiService.reviewCode).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([expect.stringContaining('Comments:')]),
        undefined
      );
    });

    it('includes the Comments guideline when commentPolicyEnabled is false', async () => {
      const { service, aiService } = await buildService();

      await service.reviewDiff('diff --git a/file b/file', { context: 'ctx', commentPolicyEnabled: false });

      expect(aiService.reviewCode).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([expect.stringContaining('Comments:')]),
        undefined
      );
    });

    it('excludes only the Comments guideline when commentPolicyEnabled is true', async () => {
      const { service, aiService } = await buildService();

      await service.reviewDiff('diff --git a/file b/file', { context: 'ctx', commentPolicyEnabled: true });

      const guidelines: string[] = (aiService.reviewCode as jest.Mock).mock.calls[0][1];
      expect(guidelines.filter(g => g.startsWith('Comments:'))).toEqual([]);
      expect(guidelines.some(g => g.startsWith('Clarity:'))).toBe(true);
      expect(guidelines.length).toBeGreaterThan(0);
    });
  });

  describe('buildReviewArtifact', () => {
    afterEach(() => jest.restoreAllMocks());

    it('includes repoScope in the artifact path when provided', async () => {
      const { service } = await buildService();
      const artifact = service.buildReviewArtifact(
        { ticketKey: 'WBP-300', content: '# WBP-300', path: '/tmp/.wf/WBP-300.md' },
        { summary: 'ok', issues: [], suggestions: [], approved: true } as any,
        undefined,
        'api-gateway-v1',
      );

      expect(artifact.path).toBe('/tmp/.wf/WBP-300-api-gateway-v1-review.md');
    });

    it('omits repoScope suffix when repoScope is absent', async () => {
      const { service } = await buildService();
      const artifact = service.buildReviewArtifact(
        { ticketKey: 'WBP-301', content: '# WBP-301', path: '/tmp/.wf/WBP-301.md' },
        { summary: 'ok', issues: [], suggestions: [], approved: true } as any,
      );

      expect(artifact.path).toBe('/tmp/.wf/WBP-301-review.md');
    });
  });
});
