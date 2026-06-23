import { parseVerificationManifest } from './verification-manifest';

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

  it('rejects unsupported manifest versions', () => {
    expect(() =>
      parseVerificationManifest(JSON.stringify({ version: 99, baseline: [] }), '/tmp/verification.json')
    ).toThrow(/unsupported.*version/i);
  });
});
