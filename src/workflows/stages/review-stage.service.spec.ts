import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AiService } from '../../integrations/ai/ai.service';
import { ReviewStageService } from './review-stage.service';
import { StageAgentService } from '../../integrations/ai/stage-agent.service';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
                        frame:
                          'HttpClient.get(GET https://agentapi.expatexplore.com/agent/1.0/data)',
                      },
                    ],
                  },
                ],
              },
              {
                frame: 'TripcomMapper.mapAgentApiToTripcom(productCode, tour)',
                children: [
                  {
                    frame:
                      'TripcomMapper.mapGalleryToMedias(tour.gallery, tour.title)',
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
                    frame:
                      'HttpClient.post(POST {TRIPCOM_API_URL}/syncProduct)',
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
          frame:
            'CanonicalProfileRepository.findLinkedProfiles(canonicalCustomerId)',
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

  const buildService = async (agentEnabled: boolean = false) => {
    const module = await Test.createTestingModule({
      providers: [
        ReviewStageService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, fallback?: unknown) => {
              if (key === 'stages.review.agent') return agentEnabled;
              return fallback;
            }),
          },
        },
        {
          provide: AiService,
          useValue: {
            reviewCode: jest.fn().mockResolvedValue(mockReview),
          },
        },
        {
          provide: StageAgentService,
          useValue: {
            isEnabledForStage: jest.fn().mockReturnValue(agentEnabled),
            reviewCode: jest.fn().mockResolvedValue({
              ...mockReview,
              executionMode: 'agent',
            }),
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
        expect.stringContaining('ticket WBP-123: Fix auth callback'),
        'Accessibility: keyboard flow still works',
      ]),
    );
  });

  it('writes a markdown review artifact for workflow review stage consumers', async () => {
    const { service } = await buildService();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-review-'));
    const ticketPath = path.join(tempDir, 'WBP-123.md');
    fs.writeFileSync(ticketPath, '# WBP-123: Fix auth callback');

    const artifact = service.createReviewArtifact(
      {
        ticketKey: 'WBP-123',
        content: '# WBP-123: Fix auth callback',
        path: ticketPath,
      },
      mockReview as any,
    );

    expect(
      fs.readFileSync(path.join(tempDir, 'WBP-123-review.md'), 'utf-8'),
    ).toContain('# Code Review: WBP-123');

    const reviewMarkdown = fs.readFileSync(
      path.join(tempDir, 'WBP-123-review.md'),
      'utf-8',
    );
    expect(reviewMarkdown.indexOf('## Summary')).toBeLessThan(
      reviewMarkdown.indexOf('## Issues'),
    );
    expect(reviewMarkdown.indexOf('## Issues')).toBeLessThan(
      reviewMarkdown.indexOf('## Call Stack'),
    );
    expect(reviewMarkdown).toContain('Provenance: best-effort');
    expect(reviewMarkdown).toContain('Execution mode: standard');
    expect(reviewMarkdown.indexOf('## Call Stack')).toBeLessThan(
      reviewMarkdown.indexOf('## State Transition'),
    );
    expect(reviewMarkdown).toContain(
      'TripcomController.syncProduct(productCode, slug)',
    );
    expect(reviewMarkdown).toContain(
      'CanonicalProfileRepository.findLinkedProfiles(canonicalCustomerId)',
    );
    expect(reviewMarkdown).toContain('firstName.dep =');
    expect(reviewMarkdown).toContain('fullName._value = Jane Smith');
    expect(reviewMarkdown.indexOf('## State Transition')).toBeLessThan(
      reviewMarkdown.indexOf('## Suggestions'),
    );
    expect(reviewMarkdown.indexOf('## Suggestions')).toBeLessThan(
      reviewMarkdown.indexOf('## Approval Status'),
    );
    expect(reviewMarkdown).toContain('Provenance: best-effort');
    expect(artifact.path).toBe(path.join(tempDir, 'WBP-123-review.md'));
    expect(artifact.approved).toBe(true);
  });

  it('renders issue-local suggestions and leaves unmatched extras in a trailing section', async () => {
    const { service } = await buildService();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-review-'));
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
      } as any,
    );

    const reviewMarkdown = fs.readFileSync(artifact.path, 'utf-8');
    expect(reviewMarkdown).toContain(
      '- [warning] First issue (src/first.ts:10)',
    );
    expect(reviewMarkdown).toContain('  - Suggestion: First suggestion');
    expect(reviewMarkdown.indexOf('First issue')).toBeLessThan(
      reviewMarkdown.indexOf('Suggestion: First suggestion'),
    );
    expect(reviewMarkdown.indexOf('Suggestion: First suggestion')).toBeLessThan(
      reviewMarkdown.indexOf('Second issue'),
    );
    expect(reviewMarkdown).toContain('## Suggestions');
    expect(reviewMarkdown).toContain('- Trailing idea');
  });

  it('marks agent-backed traces as evidence-based when trace payload exists', async () => {
    const { service, aiService, stageAgentService } = await buildService(true);
    const review = await service.reviewDiff('diff --git a/file b/file', {
      context: 'ticket WBP-124: Agent-backed review',
      repoDir: '/tmp/repo',
    });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-review-agent-'));
    const ticketPath = path.join(tempDir, 'WBP-124.md');
    fs.writeFileSync(ticketPath, '# WBP-124: Agent-backed review');

    const artifact = service.createReviewArtifact(
      {
        ticketKey: 'WBP-124',
        content: '# WBP-124: Agent-backed review',
        path: ticketPath,
      },
      review,
    );

    const reviewMarkdown = fs.readFileSync(artifact.path, 'utf-8');
    expect(stageAgentService.reviewCode).toHaveBeenCalled();
    expect(stageAgentService.reviewCode).toHaveBeenCalledWith(
      'diff --git a/file b/file',
      expect.any(Array),
      '/tmp/repo',
    );
    expect(aiService.reviewCode).not.toHaveBeenCalled();
    expect(review.executionMode).toBe('agent');
    expect(reviewMarkdown).toContain('Execution mode: agent');
    expect(reviewMarkdown).toContain('Provenance: evidence-based');
  });
});
