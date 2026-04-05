import { parsePlanArtifact } from './plan-artifact';

describe('parsePlanArtifact', () => {
  it('parses plan verification targeted checks and waivers from JSON artifacts', () => {
    const plan = parsePlanArtifact(
      JSON.stringify({
        action: 'fix',
        summary: 'Add targeted verification',
        steps: ['Update verification flow'],
        estimatedComplexity: 'medium',
        verification: {
          targeted: [
            {
              id: 'manual-review',
              run: 'npm run test:manual -- test-issue-review',
              policy: 'enforced',
              reason: 'Covers review regressions',
            },
          ],
          waivers: [
            {
              id: 'e2e',
              reason: 'Docs-only change',
            },
          ],
        },
      }),
      '/tmp/plan.json',
    ) as any;

    expect(plan.verification).toEqual({
      targeted: [
        {
          id: 'manual-review',
          run: 'npm run test:manual -- test-issue-review',
          policy: 'enforced',
          reason: 'Covers review regressions',
        },
      ],
      waivers: [
        {
          id: 'e2e',
          reason: 'Docs-only change',
        },
      ],
    });
  });
});
