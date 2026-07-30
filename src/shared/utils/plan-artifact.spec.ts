import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildPlanArtifactFilename,
  buildPlanArtifactManifestFilename,
  buildPlanArtifactManifestPath,
  resolvePlanArtifactReference,
  parsePlanArtifact,
  deriveReviewArtifactPath,
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
              run: 'yarn test:manual -- test-issue-review',
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
      '/tmp/plan.json'
    ) as any;

    expect(plan.verification).toEqual({
      targeted: [
        {
          id: 'manual-review',
          run: 'yarn test:manual -- test-issue-review',
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

  it('preserves phases when present in plan JSON', () => {
    const plan = parsePlanArtifact(
      JSON.stringify({
        action: 'feature',
        summary: 'Multi-phase plan',
        steps: ['Step A', 'Step B', 'Step C'],
        estimatedComplexity: 'high',
        phases: [
          { label: 'Schema changes', stepIndices: [0, 1], verifyAfter: ['yarn test -- src/shared/'] },
          { label: 'Service updates', stepIndices: [2] },
        ],
      }),
      '/tmp/plan.json'
    ) as any;

    expect(plan.phases).toHaveLength(2);
    expect(plan.phases[0]).toEqual({
      label: 'Schema changes',
      stepIndices: [0, 1],
      verifyAfter: ['yarn test -- src/shared/'],
    });
    expect(plan.phases[1]).toEqual({
      label: 'Service updates',
      stepIndices: [2],
    });
  });

  it('loads plan without phases field (backward compatibility)', () => {
    const plan = parsePlanArtifact(
      JSON.stringify({
        action: 'fix',
        summary: 'Simple fix',
        steps: ['Fix the bug'],
        estimatedComplexity: 'low',
      }),
      '/tmp/plan.json'
    ) as any;

    expect(plan.phases).toBeUndefined();
  });

  it('silently drops malformed phase entries', () => {
    const plan = parsePlanArtifact(
      JSON.stringify({
        action: 'fix',
        summary: 'Plan with bad phases',
        steps: ['Step A'],
        estimatedComplexity: 'low',
        phases: [
          { label: 'Valid', stepIndices: [0] },
          { stepIndices: [0] },
          'not-an-object',
        ],
      }),
      '/tmp/plan.json'
    ) as any;

    expect(plan.phases).toHaveLength(1);
    expect(plan.phases[0].label).toBe('Valid');
  });
});

describe('plan artifact helpers', () => {
  it('builds hashed plan filenames from the hash and action', () => {
    expect(
      buildPlanArtifactFilename({
        createdAt: new Date('2026-04-16T00:00:00.000Z'),
        hash: '1a2b3c4d',
        action: 'fix',
        format: 'json',
      })
    ).toBe('2026-04-16-1a2b3c4d-fix-plan.json');
  });

  it('builds a manifest filename alongside the plan artifact', () => {
    expect(buildPlanArtifactManifestFilename('2026-04-16-1a2b3c4d-fix-plan.json')).toBe(
      '2026-04-16-1a2b3c4d-fix-plan.sources.json'
    );
    expect(buildPlanArtifactManifestPath('/tmp/consumer/.wf/jira/2026-04-16-1a2b3c4d-fix-plan.json')).toBe(
      '/tmp/consumer/.wf/jira/2026-04-16-1a2b3c4d-fix-plan.sources.json'
    );
  });

  it('resolves plan metadata from a hashed manifest', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-plan-'));
    const planPath = path.join(tempDir, '2026-04-16-1a2b3c4d-fix-plan.json');
    const manifestPath = buildPlanArtifactManifestPath(planPath);

    fs.writeFileSync(
      planPath,
      JSON.stringify({
        action: 'fix',
        summary: 'Repair the cached issue plan',
        estimatedComplexity: 'medium',
        steps: ['Apply the fix'],
      })
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
      })
    );

    expect(
      resolvePlanArtifactReference('WBP-123', {
        artifactDir: tempDir,
      })
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

  it('rejects non-canonical short hashed identifiers', () => {
    expect(() =>
      resolvePlanArtifactReference('1a2b3c4d-fix-plan.json', {
        artifactDir: '/tmp',
      })
    ).toThrow('Non-canonical plan identifier');
  });
});

describe('deriveReviewArtifactPath', () => {
  it('strips .md and appends -review.md', () => {
    expect(deriveReviewArtifactPath('WBP-123.md')).toBe('WBP-123-review.md');
  });

  it('strips .json and appends -review.md', () => {
    expect(deriveReviewArtifactPath('2026-06-30-b37ef1d4-fix-plan.json')).toBe(
      '2026-06-30-b37ef1d4-fix-plan-review.md'
    );
  });

  it('strips .yaml and appends -review.md', () => {
    expect(deriveReviewArtifactPath('plan.yaml')).toBe('plan-review.md');
  });

  it('strips .yml and appends -review.md', () => {
    expect(deriveReviewArtifactPath('plan.yml')).toBe('plan-review.md');
  });

  it('appends -review.md when there is no extension', () => {
    expect(deriveReviewArtifactPath('plan')).toBe('plan-review.md');
  });

  it('preserves directory path', () => {
    expect(deriveReviewArtifactPath('/home/user/.wf/jira/WBP-123.md')).toBe('/home/user/.wf/jira/WBP-123-review.md');
  });

  it('only strips the last extension from multi-dot filenames', () => {
    expect(deriveReviewArtifactPath('file.backup.json')).toBe('file.backup-review.md');
  });
});

describe('backward-compatible migration', () => {
  it('parsePlanArtifact accepts legacy filesAffected/filesContext keys', () => {
    const plan = parsePlanArtifact(
      JSON.stringify({
        action: 'fix',
        summary: 'Legacy plan with old field names',
        steps: ['Step 1'],
        estimatedComplexity: 'low',
        filesAffected: [{ filePath: 'repo-a/src/auth.ts', status: 'found' }],
        filesContext: [{ filePath: 'repo-a/package.json', status: 'found' }],
      }),
      '/tmp/legacy-plan.json'
    );

    expect(plan.affectedFiles).toEqual([{ filePath: 'repo-a/src/auth.ts', status: 'found' }]);
    expect(plan.affectedFilesContext).toEqual([{ filePath: 'repo-a/package.json', status: 'found' }]);
  });

  it('prefers new field names over legacy when both are present', () => {
    const plan = parsePlanArtifact(
      JSON.stringify({
        action: 'fix',
        summary: 'Plan with both old and new field names',
        steps: ['Step 1'],
        estimatedComplexity: 'low',
        affectedFiles: [{ filePath: 'repo-a/src/new.ts', status: 'found' }],
        filesAffected: [{ filePath: 'repo-a/src/old.ts', status: 'found' }],
        affectedFilesContext: [{ filePath: 'repo-a/new-pkg.json', status: 'found' }],
        filesContext: [{ filePath: 'repo-a/old-pkg.json', status: 'found' }],
      }),
      '/tmp/dual-plan.json'
    );

    expect(plan.affectedFiles).toEqual([{ filePath: 'repo-a/src/new.ts', status: 'found' }]);
    expect(plan.affectedFilesContext).toEqual([{ filePath: 'repo-a/new-pkg.json', status: 'found' }]);
  });
});
