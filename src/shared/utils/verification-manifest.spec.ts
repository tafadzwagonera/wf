import { normalizeTargetedStepCommand, parseVerificationManifest } from './verification-manifest';

describe('parseVerificationManifest', () => {
  it('parses enforced and best-effort baseline steps', () => {
    const manifest = parseVerificationManifest(
      JSON.stringify({
        version: 1,
        baseline: [
          { id: 'lint', run: 'yarn lint', policy: 'enforced' },
          { id: 'smoke', run: 'yarn smoke', policy: 'best_effort' },
        ],
      }),
      '/tmp/verification.json'
    );

    expect(manifest).toEqual({
      version: 1,
      baseline: [
        { id: 'lint', run: 'yarn lint', policy: 'enforced' },
        { id: 'smoke', run: 'yarn smoke', policy: 'best_effort' },
      ],
    });
  });

  it('parses v2 manifest with stage-scoped baseline', () => {
    const manifest = parseVerificationManifest(
      JSON.stringify({
        version: 2,
        implement: {
          baseline: [{ id: 'build', run: 'yarn build', policy: 'enforced' }],
        },
      }),
      '/tmp/verification.json',
      'implement'
    );

    expect(manifest.baseline).toEqual([{ id: 'build', run: 'yarn build', policy: 'enforced' }]);
  });

  it('returns empty baseline when v2 manifest has no block for the requested stage', () => {
    const manifest = parseVerificationManifest(
      JSON.stringify({
        version: 2,
        implement: {
          baseline: [{ id: 'build', run: 'yarn build', policy: 'enforced' }],
        },
      }),
      '/tmp/verification.json',
      'review'
    );

    expect(manifest.baseline).toEqual([]);
  });

  it('silently ignores unknown stage keys in v2 manifests', () => {
    const manifest = parseVerificationManifest(
      JSON.stringify({
        version: 2,
        implement: {
          baseline: [{ id: 'lint', run: 'yarn lint', policy: 'enforced' }],
        },
        generate: { custom: true },
        review: { baseline: [] },
      }),
      '/tmp/verification.json',
      'implement'
    );

    expect(manifest.baseline).toEqual([{ id: 'lint', run: 'yarn lint', policy: 'enforced' }]);
  });

  it('defaults to implement stage when no stage param is given for v2', () => {
    const manifest = parseVerificationManifest(
      JSON.stringify({
        version: 2,
        implement: {
          baseline: [{ id: 'build', run: 'yarn build', policy: 'enforced' }],
        },
      }),
      '/tmp/verification.json'
    );

    expect(manifest.baseline).toEqual([{ id: 'build', run: 'yarn build', policy: 'enforced' }]);
  });

  it('should accept override as a valid verification policy', () => {
    const manifest = parseVerificationManifest(
      JSON.stringify({
        version: 2,
        implement: {
          baseline: [{ id: 'lint', run: 'yarn lint', policy: 'override' }],
        },
      }),
      '/tmp/verification.json',
      'implement'
    );

    expect(manifest.baseline).toHaveLength(1);
    expect(manifest.baseline[0].policy).toBe('override');
  });

  it('rejects unsupported manifest versions', () => {
    expect(() =>
      parseVerificationManifest(JSON.stringify({ version: 99, baseline: [] }), '/tmp/verification.json')
    ).toThrow(/unsupported.*version/i);
  });
});

describe('normalizeTargetedStepCommand', () => {
  it('rewrites deprecated --testPathPattern to --testPathPatterns', () => {
    expect(normalizeTargetedStepCommand("yarn test --testPathPattern='tour-group.mapper' --verbose")).toBe(
      "yarn test --testPathPatterns='tour-group.mapper' --verbose",
    );
  });

  it('drops the -- separator before --testPathPatterns after rewrite', () => {
    expect(normalizeTargetedStepCommand("yarn test -- --testPathPattern='tour-group.mapper' --verbose")).toBe(
      "yarn test --testPathPatterns='tour-group.mapper' --verbose",
    );
  });

  it('drops the -- separator before a pre-existing --testPathPatterns', () => {
    expect(normalizeTargetedStepCommand("yarn test -- --testPathPatterns='region.mapper' --verbose")).toBe(
      "yarn test --testPathPatterns='region.mapper' --verbose",
    );
  });

  it('leaves commands without --testPathPatterns unchanged', () => {
    expect(normalizeTargetedStepCommand('yarn test -- src/foo.spec.ts')).toBe('yarn test -- src/foo.spec.ts');
  });

  it('leaves --forceExit unchanged', () => {
    expect(normalizeTargetedStepCommand('yarn test --forceExit')).toBe('yarn test --forceExit');
  });
});
