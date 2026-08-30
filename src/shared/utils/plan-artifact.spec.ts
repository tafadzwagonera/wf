import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildPlanArtifactFilename,
  buildPlanArtifactManifestFilename,
  buildPlanArtifactManifestPath,
  resolvePlanArtifactReference,
  parsePlanArtifact,
  deriveReviewArtifactPath,
  buildPlanArtifactManifest,
  writePlanArtifactManifest,
  readPlanArtifactManifest,
  updatePlanArtifactManifestSourceBranch,
  updatePlanArtifactManifestFigmaLinks,
  findPlanArtifactManifestByBranchName,
  hashPlanArtifactSources,
  resolvePlanToken,
} from './plan-artifact';
import { PlanArtifactNotFoundError, AmbiguousPlanArtifactError } from '../errors/app.error';
import { createTempDir as createManagedTempDir } from '../testing/temp-dir';

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
    const tempDir = createManagedTempDir('plan');
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

  it('includes figmaLinks when provided to buildPlanArtifactManifest', () => {
    const links = ['https://www.figma.com/design/abc/Name'];
    const manifest = buildPlanArtifactManifest({
      artifactPath: '/tmp/plan.json',
      action: 'feature',
      format: 'json',
      hash: 'h1',
      sourceName: 'T-1',
      sourceKind: 'ticket',
      createdAt: new Date(),
      figmaLinks: links,
    });
    expect(manifest.figmaLinks).toEqual(links);
  });

  it('rejects non-canonical short hashed identifiers', () => {
    expect(() =>
      resolvePlanArtifactReference('1a2b3c4d-fix-plan.json', {
        artifactDir: '/tmp',
      })
    ).toThrow('Non-canonical plan identifier');
  });

  it('throws PlanArtifactNotFoundError when no matching manifest exists', () => {
    const tempDir = createManagedTempDir('notfound');
    expect(() =>
      resolvePlanArtifactReference('WBP-NOTFOUND', { artifactDir: tempDir })
    ).toThrow(PlanArtifactNotFoundError);
  });
});

describe('updatePlanArtifactManifestSourceBranch', () => {
  it('records the source branch onto an existing manifest', () => {
    const tempDir = createManagedTempDir('source-branch');
    const planPath = path.join(tempDir, '2026-08-25-abc123-feature-plan.json');
    const createdAt = new Date('2026-08-25T00:00:00.000Z');
    writePlanArtifactManifest(
      buildPlanArtifactManifest({ artifactPath: planPath, action: 'feature', format: 'json', hash: 'abc123', sourceName: 'WBP-1', sourceKind: 'ticket', createdAt: createdAt })
    );

    updatePlanArtifactManifestSourceBranch(planPath, 'develop');

    const manifest = readPlanArtifactManifest(buildPlanArtifactManifestPath(planPath));
    expect(manifest?.sourceBranch).toBe('develop');
    expect(manifest?.ticketKey).toBe('WBP-1');
  });

  it('does nothing when no manifest exists for the artifact', () => {
    const tempDir = createManagedTempDir('source-branch-missing');
    const planPath = path.join(tempDir, '2026-08-25-abc123-feature-plan.json');

    expect(() => updatePlanArtifactManifestSourceBranch(planPath, 'develop')).not.toThrow();
    expect(readPlanArtifactManifest(buildPlanArtifactManifestPath(planPath))).toBeNull();
  });

  it('does not overwrite an already-recorded source branch', () => {
    const tempDir = createManagedTempDir('source-branch-write-once');
    const planPath = path.join(tempDir, '2026-08-25-abc123-feature-plan.json');
    const createdAt = new Date('2026-08-25T00:00:00.000Z');
    writePlanArtifactManifest(
      buildPlanArtifactManifest({ artifactPath: planPath, action: 'feature', format: 'json', hash: 'abc123', sourceName: 'WBP-1', sourceKind: 'ticket', createdAt: createdAt })
    );
    updatePlanArtifactManifestSourceBranch(planPath, 'release/2026');

    updatePlanArtifactManifestSourceBranch(planPath, 'develop');

    const manifest = readPlanArtifactManifest(buildPlanArtifactManifestPath(planPath));
    expect(manifest?.sourceBranch).toBe('release/2026');
  });

  it('also records the branch name, independent of sourceBranch write-once', () => {
    const tempDir = createManagedTempDir('source-branch-and-name');
    const planPath = path.join(tempDir, '2026-08-25-abc123-feature-plan.json');
    const createdAt = new Date('2026-08-25T00:00:00.000Z');
    writePlanArtifactManifest(
      buildPlanArtifactManifest({
        artifactPath: planPath, action: 'feature', format: 'json', hash: 'abc123', sourceName: 'WBP-1',
        sourceKind: 'ticket', createdAt,
      })
    );

    updatePlanArtifactManifestSourceBranch(planPath, 'develop', 'feature/WBP-1-thing');

    const manifest = readPlanArtifactManifest(buildPlanArtifactManifestPath(planPath));
    expect(manifest?.sourceBranch).toBe('develop');
    expect(manifest?.branchName).toBe('feature/WBP-1-thing');
  });

  it('backfills a missing branch name even when sourceBranch is already recorded (write-once independently)', () => {
    const tempDir = createManagedTempDir('backfill-branch-name');
    const planPath = path.join(tempDir, '2026-08-25-abc123-feature-plan.json');
    const createdAt = new Date('2026-08-25T00:00:00.000Z');
    writePlanArtifactManifest({
      ...buildPlanArtifactManifest({
        artifactPath: planPath, action: 'feature', format: 'json', hash: 'abc123', sourceName: 'WBP-1',
        sourceKind: 'ticket', createdAt,
      }),
      sourceBranch: 'develop',
    });

    updatePlanArtifactManifestSourceBranch(planPath, 'release/2026', 'feature/WBP-1-thing');

    const manifest = readPlanArtifactManifest(buildPlanArtifactManifestPath(planPath));
    expect(manifest?.sourceBranch).toBe('develop');
    expect(manifest?.branchName).toBe('feature/WBP-1-thing');
  });
});

describe('updatePlanArtifactManifestFigmaLinks', () => {
  it('sets figmaLinks when not previously set', () => {
    const tempDir = createManagedTempDir('figma-links-set');
    const planPath = path.join(tempDir, '2026-08-30-abc123-feature-plan.json');
    writePlanArtifactManifest(
      buildPlanArtifactManifest({
        artifactPath: planPath, action: 'feature', format: 'json', hash: 'abc123',
        sourceName: 'WBP-1', sourceKind: 'ticket', createdAt: new Date('2026-08-30T00:00:00.000Z'),
      })
    );

    updatePlanArtifactManifestFigmaLinks(planPath, ['https://www.figma.com/design/X/Y']);

    const manifest = readPlanArtifactManifest(buildPlanArtifactManifestPath(planPath));
    expect(manifest?.figmaLinks).toEqual(['https://www.figma.com/design/X/Y']);
  });

  it('is a no-op when figmaLinks already set', () => {
    const tempDir = createManagedTempDir('figma-links-noop');
    const planPath = path.join(tempDir, '2026-08-30-abc123-feature-plan.json');
    writePlanArtifactManifest({
      ...buildPlanArtifactManifest({
        artifactPath: planPath, action: 'feature', format: 'json', hash: 'abc123',
        sourceName: 'WBP-1', sourceKind: 'ticket', createdAt: new Date('2026-08-30T00:00:00.000Z'),
      }),
      figmaLinks: ['https://www.figma.com/design/original'],
    });

    updatePlanArtifactManifestFigmaLinks(planPath, ['https://www.figma.com/design/replacement']);

    const manifest = readPlanArtifactManifest(buildPlanArtifactManifestPath(planPath));
    expect(manifest?.figmaLinks).toEqual(['https://www.figma.com/design/original']);
  });
});

describe('findPlanArtifactManifestByBranchName', () => {
  it('finds a custom-plan manifest by its recorded branch name', () => {
    const tempDir = createManagedTempDir('find-by-branch-custom');
    const planPath = path.join(tempDir, '2026-08-25-abc123-fix-plan.json');
    const createdAt = new Date('2026-08-25T00:00:00.000Z');
    writePlanArtifactManifest(
      buildPlanArtifactManifest({
        artifactPath: planPath, action: 'fix', format: 'json', hash: 'abc123', sourceName: 'my-custom-plan',
        sourceKind: 'custom', createdAt,
      })
    );
    updatePlanArtifactManifestSourceBranch(planPath, 'develop', 'fix/my-custom-plan');

    const manifest = findPlanArtifactManifestByBranchName('fix/my-custom-plan', [tempDir]);

    expect(manifest?.sourceBranch).toBe('develop');
    expect(manifest?.sourceKind).toBe('custom');
  });

  it('searches across multiple directories', () => {
    const trackerDir = createManagedTempDir('find-by-branch-tracker-dir');
    const customDir = createManagedTempDir('find-by-branch-custom-dir');
    const planPath = path.join(customDir, '2026-08-25-def456-fix-plan.json');
    writePlanArtifactManifest(
      buildPlanArtifactManifest({
        artifactPath: planPath, action: 'fix', format: 'json', hash: 'def456', sourceName: 'other-plan',
        sourceKind: 'custom', createdAt: new Date('2026-08-25T00:00:00.000Z'),
      })
    );
    updatePlanArtifactManifestSourceBranch(planPath, 'master', 'fix/other-plan');

    const manifest = findPlanArtifactManifestByBranchName('fix/other-plan', [trackerDir, customDir]);

    expect(manifest?.sourceName).toBe('other-plan');
  });

  it('returns undefined when no manifest matches the branch name', () => {
    const tempDir = createManagedTempDir('find-by-branch-missing');
    expect(findPlanArtifactManifestByBranchName('feature/nonexistent', [tempDir])).toBeUndefined();
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

describe('resolvePlanArtifactReference identifier matching', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createManagedTempDir('artifact-matching');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves by exact sourceName when two names are prefix/suffix pairs', () => {
    const hash1 = hashPlanArtifactSources(['2026-08-25-range-rename']);
    const hash2 = hashPlanArtifactSources(['2026-08-25-range-rename-implementation-plan']);
    const createdAt = new Date('2026-08-25T00:00:00.000Z');

    const planPath1 = path.join(tempDir, buildPlanArtifactFilename({
      createdAt,
      hash: hash1,
      action: 'fix',
      format: 'json',
    }));
    const planPath2 = path.join(tempDir, buildPlanArtifactFilename({
      createdAt,
      hash: hash2,
      action: 'fix',
      format: 'json',
    }));

    fs.writeFileSync(planPath1, JSON.stringify({ action: 'fix', summary: 'Plan 1' }));
    fs.writeFileSync(planPath2, JSON.stringify({ action: 'fix', summary: 'Plan 2' }));

    const manifest1 = buildPlanArtifactManifest({ artifactPath: planPath1, action: 'fix', format: 'json', hash: hash1, sourceName: '2026-08-25-range-rename', sourceKind: 'custom', createdAt: createdAt });
    const manifest2 = buildPlanArtifactManifest({ artifactPath: planPath2, action: 'fix', format: 'json', hash: hash2, sourceName: '2026-08-25-range-rename-implementation-plan', sourceKind: 'custom', createdAt: createdAt });

    writePlanArtifactManifest(manifest1);
    writePlanArtifactManifest(manifest2);

    const result = resolvePlanArtifactReference('2026-08-25-range-rename', { artifactDir: tempDir, action: 'fix' });
    expect(result.artifactPath).toBe(planPath1);
    expect(result.hash).toBe(hash1);
  });

  it('resolves by exact ticketKey when sibling keys are numeric prefixes', () => {
    const hash1 = hashPlanArtifactSources(['WBP-123']);
    const hash2 = hashPlanArtifactSources(['WBP-1234']);
    const createdAt = new Date('2026-08-25T00:00:00.000Z');

    const planPath1 = path.join(tempDir, buildPlanArtifactFilename({
      createdAt,
      hash: hash1,
      action: 'fix',
      format: 'json',
    }));
    const planPath2 = path.join(tempDir, buildPlanArtifactFilename({
      createdAt,
      hash: hash2,
      action: 'fix',
      format: 'json',
    }));

    fs.writeFileSync(planPath1, JSON.stringify({ action: 'fix', summary: 'WBP-123 plan' }));
    fs.writeFileSync(planPath2, JSON.stringify({ action: 'fix', summary: 'WBP-1234 plan' }));

    const manifest1 = buildPlanArtifactManifest({ artifactPath: planPath1, action: 'fix', format: 'json', hash: hash1, sourceName: 'WBP-123', sourceKind: 'ticket', createdAt: createdAt });
    const manifest2 = buildPlanArtifactManifest({ artifactPath: planPath2, action: 'fix', format: 'json', hash: hash2, sourceName: 'WBP-1234', sourceKind: 'ticket', createdAt: createdAt });

    writePlanArtifactManifest(manifest1);
    writePlanArtifactManifest(manifest2);

    const result = resolvePlanArtifactReference('WBP-123', { artifactDir: tempDir });
    expect(result.artifactPath).toBe(planPath1);
    expect(result.hash).toBe(hash1);
  });

  it('rejects empty identifier', () => {
    expect(() =>
      resolvePlanArtifactReference('', { artifactDir: tempDir })
    ).toThrow(PlanArtifactNotFoundError);
  });

  it('rejects truncated hash', () => {
    const hash = hashPlanArtifactSources(['test']);
    const createdAt = new Date('2026-08-25T00:00:00.000Z');
    const planPath = path.join(tempDir, buildPlanArtifactFilename({
      createdAt,
      hash,
      action: 'fix',
      format: 'json',
    }));

    fs.writeFileSync(planPath, JSON.stringify({ action: 'fix', summary: 'Test plan' }));
    const manifest = buildPlanArtifactManifest({ artifactPath: planPath, action: 'fix', format: 'json', hash: hash, sourceName: 'test', sourceKind: 'custom', createdAt: createdAt });
    writePlanArtifactManifest(manifest);

    const truncatedHash = hash.slice(0, 4);
    expect(() =>
      resolvePlanArtifactReference(truncatedHash, { artifactDir: tempDir })
    ).toThrow(PlanArtifactNotFoundError);
  });

  it('rejects partial ticket key', () => {
    const hash = hashPlanArtifactSources(['WBP-123']);
    const createdAt = new Date('2026-08-25T00:00:00.000Z');
    const planPath = path.join(tempDir, buildPlanArtifactFilename({
      createdAt,
      hash,
      action: 'fix',
      format: 'json',
    }));

    fs.writeFileSync(planPath, JSON.stringify({ action: 'fix', summary: 'WBP-123 plan' }));
    const manifest = buildPlanArtifactManifest({ artifactPath: planPath, action: 'fix', format: 'json', hash: hash, sourceName: 'WBP-123', sourceKind: 'ticket', createdAt: createdAt });
    writePlanArtifactManifest(manifest);

    expect(() =>
      resolvePlanArtifactReference('WBP-1', { artifactDir: tempDir })
    ).toThrow(PlanArtifactNotFoundError);
  });

  it('rejects partial date stem', () => {
    const hash = hashPlanArtifactSources(['2026-08-25-range-rename']);
    const createdAt = new Date('2026-08-25T00:00:00.000Z');
    const planPath = path.join(tempDir, buildPlanArtifactFilename({
      createdAt,
      hash,
      action: 'fix',
      format: 'json',
    }));

    fs.writeFileSync(planPath, JSON.stringify({ action: 'fix', summary: 'Test plan' }));
    const manifest = buildPlanArtifactManifest({ artifactPath: planPath, action: 'fix', format: 'json', hash: hash, sourceName: '2026-08-25-range-rename', sourceKind: 'custom', createdAt: createdAt });
    writePlanArtifactManifest(manifest);

    expect(() =>
      resolvePlanArtifactReference('2026-08-25', { artifactDir: tempDir })
    ).toThrow(PlanArtifactNotFoundError);
  });

  it('resolves by full hash', () => {
    const hash = hashPlanArtifactSources(['test']);
    const createdAt = new Date('2026-08-25T00:00:00.000Z');
    const planPath = path.join(tempDir, buildPlanArtifactFilename({
      createdAt,
      hash,
      action: 'fix',
      format: 'json',
    }));

    fs.writeFileSync(planPath, JSON.stringify({ action: 'fix', summary: 'Test plan' }));
    const manifest = buildPlanArtifactManifest({ artifactPath: planPath, action: 'fix', format: 'json', hash: hash, sourceName: 'test', sourceKind: 'custom', createdAt: createdAt });
    writePlanArtifactManifest(manifest);

    const result = resolvePlanArtifactReference(hash, { artifactDir: tempDir });
    expect(result.artifactPath).toBe(planPath);
  });

  it('resolves by canonical filename via artifactStem', () => {
    const hash = hashPlanArtifactSources(['test']);
    const createdAt = new Date('2026-08-25T00:00:00.000Z');
    const filename = buildPlanArtifactFilename({
      createdAt,
      hash,
      action: 'fix',
      format: 'json',
    });
    const planPath = path.join(tempDir, filename);

    fs.writeFileSync(planPath, JSON.stringify({ action: 'fix', summary: 'Test plan' }));
    const manifest = buildPlanArtifactManifest({ artifactPath: planPath, action: 'fix', format: 'json', hash: hash, sourceName: 'test', sourceKind: 'custom', createdAt: createdAt });
    writePlanArtifactManifest(manifest);

    const result = resolvePlanArtifactReference(filename, { artifactDir: tempDir });
    expect(result.artifactPath).toBe(planPath);
  });

  it('resolves by exact customArtifactName', () => {
    const hash = hashPlanArtifactSources(['my-custom-plan']);
    const createdAt = new Date('2026-08-25T00:00:00.000Z');
    const planPath = path.join(tempDir, buildPlanArtifactFilename({
      createdAt,
      hash,
      action: 'fix',
      format: 'json',
    }));

    fs.writeFileSync(planPath, JSON.stringify({ action: 'fix', summary: 'Custom plan' }));
    const manifest = buildPlanArtifactManifest({ artifactPath: planPath, action: 'fix', format: 'json', hash: hash, sourceName: 'my-custom-plan', sourceKind: 'custom', createdAt: createdAt });
    writePlanArtifactManifest(manifest);

    const result = resolvePlanArtifactReference('my-custom-plan', { artifactDir: tempDir });
    expect(result.artifactPath).toBe(planPath);
  });

  it('resolves by canonical stem with different date prefix via parseCanonicalStem fallback', () => {
    const hash = hashPlanArtifactSources(['test']);
    const createdAt = new Date('2026-08-25T00:00:00.000Z');

    const filename = buildPlanArtifactFilename({
      createdAt,
      hash,
      action: 'fix',
      format: 'json',
    });
    const planPath = path.join(tempDir, filename);

    fs.writeFileSync(planPath, JSON.stringify({ action: 'fix', summary: 'Test plan' }));
    const manifest = buildPlanArtifactManifest({ artifactPath: planPath, action: 'fix', format: 'json', hash: hash, sourceName: 'test', sourceKind: 'custom', createdAt: createdAt });
    writePlanArtifactManifest(manifest);

    const result = resolvePlanArtifactReference(`2026-08-24-${hash}-fix-plan.json`, { artifactDir: tempDir });
    expect(result.artifactPath).toBe(planPath);
  });

  it('normalizes case and whitespace in identifier', () => {
    const hash = hashPlanArtifactSources(['WBP-123']);
    const createdAt = new Date('2026-08-25T00:00:00.000Z');
    const planPath = path.join(tempDir, buildPlanArtifactFilename({
      createdAt,
      hash,
      action: 'fix',
      format: 'json',
    }));

    fs.writeFileSync(planPath, JSON.stringify({ action: 'fix', summary: 'WBP-123 plan' }));
    const manifest = buildPlanArtifactManifest({ artifactPath: planPath, action: 'fix', format: 'json', hash: hash, sourceName: 'WBP-123', sourceKind: 'ticket', createdAt: createdAt });
    writePlanArtifactManifest(manifest);

    const result = resolvePlanArtifactReference('  WBP-123  ', { artifactDir: tempDir });
    expect(result.artifactPath).toBe(planPath);
  });

  it('resolves migrated artifact with non-8-char hash by exact stored hash', () => {
    const hash = hashPlanArtifactSources(['migrated']);
    const nonStandardHash = 'abc123';
    const createdAt = new Date('2026-08-25T00:00:00.000Z');
    const planPath = path.join(tempDir, `2026-08-25-${nonStandardHash}-fix-plan.json`);

    fs.writeFileSync(planPath, JSON.stringify({ action: 'fix', summary: 'Migrated plan' }));
    const manifest = buildPlanArtifactManifest({ artifactPath: planPath, action: 'fix', format: 'json', hash: nonStandardHash, sourceName: 'migrated', sourceKind: 'custom', createdAt: createdAt });
    writePlanArtifactManifest(manifest);

    const result = resolvePlanArtifactReference(nonStandardHash, { artifactDir: tempDir });
    expect(result.artifactPath).toBe(planPath);
  });

  it('throws AmbiguousPlanArtifactError when artifacts have identical hash and sourceName but different dates', () => {
    const hash = hashPlanArtifactSources(['test']);
    const createdAt1 = new Date('2026-08-24T00:00:00.000Z');
    const createdAt2 = new Date('2026-08-25T00:00:00.000Z');

    const filename1 = buildPlanArtifactFilename({
      createdAt: createdAt1,
      hash,
      action: 'fix',
      format: 'json',
    });
    const planPath1 = path.join(tempDir, filename1);

    fs.writeFileSync(planPath1, JSON.stringify({ action: 'fix', summary: 'Test plan' }));
    const manifest1 = buildPlanArtifactManifest({ artifactPath: planPath1, action: 'fix', format: 'json', hash: hash, sourceName: 'test', sourceKind: 'custom', createdAt: createdAt1 });
    writePlanArtifactManifest(manifest1);

    const filename2 = buildPlanArtifactFilename({
      createdAt: createdAt2,
      hash,
      action: 'fix',
      format: 'json',
    });
    const planPath2 = path.join(tempDir, filename2);

    fs.writeFileSync(planPath2, JSON.stringify({ action: 'fix', summary: 'Test plan 2' }));
    const manifest2 = buildPlanArtifactManifest({ artifactPath: planPath2, action: 'fix', format: 'json', hash: hash, sourceName: 'test', sourceKind: 'custom', createdAt: createdAt2 });
    writePlanArtifactManifest(manifest2);

    expect(() =>
      resolvePlanArtifactReference('test', { artifactDir: tempDir })
    ).toThrow(AmbiguousPlanArtifactError);
  });
});

describe('resolvePlanToken cross-directory resolution', () => {
  let wfHomeDir: string;
  let repoBaseDir: string;
  let trackerDir: string;
  let customDir: string;
  let originalWfHome: string | undefined;

  beforeEach(() => {
    wfHomeDir = createManagedTempDir('wf-home');
    originalWfHome = process.env.WF_HOME;
    process.env.WF_HOME = wfHomeDir;

    repoBaseDir = createManagedTempDir('repo-base');
    trackerDir = path.join(wfHomeDir, 'tracker');
    fs.mkdirSync(trackerDir, { recursive: true });
    customDir = path.join(wfHomeDir, path.basename(path.resolve(repoBaseDir)));
    fs.mkdirSync(customDir, { recursive: true });
  });

  afterEach(() => {
    if (originalWfHome === undefined) delete process.env.WF_HOME;
    else process.env.WF_HOME = originalWfHome;
    jest.restoreAllMocks();
  });

  it('throws AmbiguousPlanArtifactError from trackerDir without falling through to a resolvable customDir match', () => {
    const hash1 = hashPlanArtifactSources(['range-rename-a']);
    const hash2 = hashPlanArtifactSources(['range-rename-b']);
    const createdAt1 = new Date('2026-08-24T00:00:00.000Z');
    const createdAt2 = new Date('2026-08-25T00:00:00.000Z');

    const trackerPlanPath1 = path.join(trackerDir, buildPlanArtifactFilename({
      createdAt: createdAt1,
      hash: hash1,
      action: 'fix',
      format: 'json',
    }));
    const trackerPlanPath2 = path.join(trackerDir, buildPlanArtifactFilename({
      createdAt: createdAt2,
      hash: hash2,
      action: 'fix',
      format: 'json',
    }));
    fs.writeFileSync(trackerPlanPath1, JSON.stringify({ action: 'fix', summary: 'Plan 1' }));
    fs.writeFileSync(trackerPlanPath2, JSON.stringify({ action: 'fix', summary: 'Plan 2' }));
    writePlanArtifactManifest(
      buildPlanArtifactManifest({ artifactPath: trackerPlanPath1, action: 'fix', format: 'json', hash: hash1, sourceName: 'range-rename', sourceKind: 'custom', createdAt: createdAt1 })
    );
    writePlanArtifactManifest(
      buildPlanArtifactManifest({ artifactPath: trackerPlanPath2, action: 'fix', format: 'json', hash: hash2, sourceName: 'range-rename', sourceKind: 'custom', createdAt: createdAt2 })
    );

    const customHash = hashPlanArtifactSources(['range-rename-custom']);
    const customPlanPath = path.join(customDir, buildPlanArtifactFilename({
      createdAt: createdAt2,
      hash: customHash,
      action: 'fix',
      format: 'json',
    }));
    fs.writeFileSync(customPlanPath, JSON.stringify({ action: 'fix', summary: 'Custom plan' }));
    writePlanArtifactManifest(
      buildPlanArtifactManifest({ artifactPath: customPlanPath, action: 'fix', format: 'json', hash: customHash, sourceName: 'range-rename', sourceKind: 'custom', createdAt: createdAt2 })
    );

    expect(() => resolvePlanToken('range-rename', trackerDir, repoBaseDir)).toThrow(AmbiguousPlanArtifactError);
  });
});
