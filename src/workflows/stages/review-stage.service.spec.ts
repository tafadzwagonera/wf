import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AiService } from '../../integrations/ai/ai.service';
import { ReviewStageService } from './review-stage.service';
import { StageAgentService } from '../../integrations/ai/stage-agent.service';
import { codeReviewSchema } from '../../shared/schemas/review.schema';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AiProviderError } from '../../shared/utils/errors';
import { KNOWN_SKILLS, registerSkill } from '../../skills/skill-registry';
import type { SkillDefinition } from '../../skills/skill.types';
import { createTempDir as createManagedTempDir } from '../../shared/testing/temp-dir';

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
          captured: {
            canonicalCustomerId: '123',
          },
          changes: {
            'firstName.dep': {
              after: {
                version: 1,
                subs: 'Link_1',
                subsHead: 'Link_1',
                sc: 1,
              },
            },
          },
          children: [
            {
              frame:
                'CanonicalLinkRepository.find({ where: { canonicalCustomerId, linkStatus: CanonicalLinkStatus.Merged } })',
              changes: {
                'lastName.dep': {
                  after: {
                    version: 1,
                    subs: 'Link_2',
                    subsHead: 'Link_2',
                    sc: 1,
                  },
                },
              },
              children: [
                {
                  frame:
                    'CanonicalProfileRepository.findLinkedProfiles(...): In([...customerIds]) -> AppGoldenCustomerProfile[]',
                  changes: {
                    'fullName.dep': {
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
                  },
                  children: [
                    {
                      frame: 'ProfileResponseDto.linkedProfiles',
                      captured: {
                        'fullName._value': 'Jane Smith',
                      },
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

  afterEach(() => {
    jest.restoreAllMocks();
  });

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
    const appendSpy = jest.spyOn(require('../../shared/logger/log-file-writer'), 'appendToLogFile').mockImplementation(() => {});
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

  it('reports when the diff remains oversized after summarisation', async () => {
    const { service, aiService } = await buildService({ agentEnabled: false });
    const onProgress = jest.fn();
    const appendSpy = jest.spyOn(require('../../shared/logger/log-file-writer'), 'appendToLogFile').mockImplementation(() => {});
    (aiService.execute as jest.Mock).mockResolvedValue({ content: '- ' + 'y'.repeat(90000) });
    const diff = `diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-${'x'.repeat(50000)}\n+${'x'.repeat(50000)}y`;

    await service.reviewDiff(diff, { context: 'test context', onProgress });

    expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('Review diff remains oversized after summarisation'));
    expect(appendSpy).toHaveBeenCalledWith(
      'WARN',
      expect.stringContaining('Review diff remains oversized after summarisation'),
      'review-stage'
    );
  });

  it('routes diff summarisation through stageAgentService.chatTurn when review backend is agent', async () => {
    const { service, stageAgentService, aiService } = await buildService({ agentEnabled: true, reviewBackend: 'agent' });
    const largeDiff = `diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-${'x'.repeat(50000)}\n+${'x'.repeat(50000)}y`;

    await service.reviewDiff(largeDiff, { context: 'test context' });

    expect((stageAgentService as any).chatTurn).toHaveBeenCalledWith(expect.objectContaining({ stage: 'review' }));
    expect((aiService as any).execute).not.toHaveBeenCalled();
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

  describe('skill integration', () => {
    const createMockReviewSkill = (id: string): SkillDefinition => ({ id, stages: ['review'] });
    let savedSkills: Map<string, SkillDefinition>;

    beforeEach(() => {
      savedSkills = new Map(KNOWN_SKILLS);
      KNOWN_SKILLS.clear();
    });

    afterEach(() => {
      KNOWN_SKILLS.clear();
      for (const [k, v] of savedSkills) KNOWN_SKILLS.set(k, v);
    });

    it('passes resolved skillNames to stageAgentService.reviewCode when agent backend is enabled', async () => {
      registerSkill(createMockReviewSkill('receiving-code-review'));
      const { service, stageAgentService } = await buildService({
        agentEnabled: true,
        reviewSkills: ['receiving-code-review'],
      });

      await service.reviewDiff('diff --git a/file b/file', {
        context: 'ticket WBP-SKILL: Skill review',
        repoDir: '/tmp/repo',
      });

      expect(stageAgentService.reviewCode).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        '/tmp/repo',
        undefined,
        undefined,
        undefined,
        { skillNames: ['receiving-code-review'], forkSession: undefined }
      );
    });

    it('passes undefined skillNames to agent when no skills are configured', async () => {
      const { service, stageAgentService } = await buildService({ agentEnabled: true });

      await service.reviewDiff('diff --git a/file b/file', {
        context: 'ticket WBP-NO-SKILL: No skills',
        repoDir: '/tmp/repo',
      });

      expect(stageAgentService.reviewCode).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        '/tmp/repo',
        undefined,
        undefined,
        undefined,
        { skillNames: undefined, forkSession: undefined }
      );
    });

    it('throws ConfigurationError when a skill does not support the review stage', async () => {
      registerSkill({ id: 'plan-only-skill', stages: ['plan'] });
      const { service } = await buildService({
        agentEnabled: true,
        reviewSkills: ['plan-only-skill'],
      });

      await expect(
        service.reviewDiff('diff --git a/file b/file', { context: 'mismatch test' })
      ).rejects.toThrow('does not support the "review" stage');
    });

    it('surfaces sessionId from agent backend on success', async () => {
      const { service, stageAgentService } = await buildService({ agentEnabled: true });
      (stageAgentService.reviewCode as jest.Mock).mockResolvedValue({
        review: { summary: 'ok', issues: [], suggestions: [], approved: true, executionMode: 'cli' },
        sessionId: 'review-sess-1',
      });

      const result = await service.reviewDiff('diff', { context: 'test' });
      expect(result.sessionId).toBe('review-sess-1');
    });

    it('preserves sessionId through parse error recovery', async () => {
      const { service, stageAgentService, aiService } = await buildService({
        agentEnabled: true,
        reviewBackend: 'agent',
      });
      (stageAgentService.reviewCode as jest.Mock).mockRejectedValueOnce(
        new AiProviderError('parse fail', { response: '{"summary":"ok","issues":[],"suggestions":[],"approved":true}', sessionId: 'review-sess-2' }, true, 'parse')
      );
      const svc = aiService as unknown as Record<string, unknown>;
      svc.validateReviewJson = jest.fn().mockResolvedValue({
        summary: 'ok', issues: [], suggestions: [], approved: true,
      });

      const result = await service.reviewDiff('diff', { context: 'test' });
      expect(result.sessionId).toBe('review-sess-2');
    });
  });
});
