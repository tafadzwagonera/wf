import { Test } from '@nestjs/testing';
import { AiService } from '../../integrations/ai/ai.service';
import { ReviewStageService } from './review-stage.service';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('ReviewStageService', () => {
  const mockReview = {
    summary: 'Looks good overall',
    issues: [],
    traceProvenance: 'best-effort',
    callStack: ['ticket lookup', 'PR discovery', 'diff review'],
    stateTransition: {
      from: 'ticket-resolved',
      to: 'reviewed',
      steps: [
        { state: 'ticket-resolved', next: 'pull-requests-found' },
        { state: 'pull-requests-found', next: 'reviewed' },
      ],
    },
    suggestions: ['Add one more regression test'],
    approved: true,
  };

  const buildService = async () => {
    const module = await Test.createTestingModule({
      providers: [
        ReviewStageService,
        {
          provide: AiService,
          useValue: {
            reviewCode: jest.fn().mockResolvedValue(mockReview),
          },
        },
      ],
    }).compile();

    return {
      service: module.get(ReviewStageService),
      aiService: module.get(AiService),
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
    expect(reviewMarkdown.indexOf('## Call Stack')).toBeLessThan(
      reviewMarkdown.indexOf('## State Transition'),
    );
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
});
