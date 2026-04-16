import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildPlanArtifactFilename,
  buildPlanArtifactManifestFilename,
  buildPlanArtifactManifestPath,
  resolvePlanArtifactReference,
  parsePlanArtifact,
} from './plan-artifact';

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

describe('plan artifact helpers', () => {
  it('builds hashed plan filenames from the hash and action', () => {
    expect(
      buildPlanArtifactFilename({
        hash: '1a2b3c4d',
        action: 'fix',
        format: 'json',
      }),
    ).toBe('1a2b3c4d-fix-plan.json');
  });

  it('builds a manifest filename alongside the plan artifact', () => {
    expect(buildPlanArtifactManifestFilename('1a2b3c4d-fix-plan.json')).toBe(
      '1a2b3c4d-fix-plan.sources.json',
    );
    expect(
      buildPlanArtifactManifestPath(
        '/tmp/consumer/.wf/jira/1a2b3c4d-fix-plan.json',
      ),
    ).toBe('/tmp/consumer/.wf/jira/1a2b3c4d-fix-plan.sources.json');
  });

  it('resolves plan metadata from a hashed manifest', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-plan-'));
    const planPath = path.join(tempDir, '1a2b3c4d-fix-plan.json');
    const manifestPath = buildPlanArtifactManifestPath(planPath);

    fs.writeFileSync(
      planPath,
      JSON.stringify({
        action: 'fix',
        summary: 'Repair the cached issue plan',
        estimatedComplexity: 'medium',
        steps: ['Apply the fix'],
      }),
    );
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        artifactPath: planPath,
        createdAt: new Date('2026-04-16T00:00:00.000Z').toISOString(),
        format: 'json',
        hash: '1a2b3c4d',
        action: 'fix',
        sourceKind: 'ticket',
        ticketKey: 'WBP-123',
        sourceName: 'WBP-123',
      }),
    );

    expect(
      resolvePlanArtifactReference('WBP-123', {
        artifactDir: tempDir,
      }),
    ).toMatchObject({
      action: 'fix',
      artifactPath: planPath,
      hash: '1a2b3c4d',
      ticketKey: 'WBP-123',
      sourceKind: 'ticket',
      sourceName: 'WBP-123',
      isLegacy: false,
    });
  });
});
