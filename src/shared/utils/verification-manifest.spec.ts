import { parseVerificationManifest } from './verification-manifest';

describe('parseVerificationManifest', () => {
  it('parses enforced and best-effort baseline steps', () => {
    const manifest = parseVerificationManifest(
      JSON.stringify({
        version: 1,
        baseline: [
          { id: 'lint', run: 'npm run lint', policy: 'enforced' },
          { id: 'smoke', run: 'npm run smoke', policy: 'best_effort' },
        ],
      }),
      '/tmp/verification.json',
    );

    expect(manifest).toEqual({
      version: 1,
      baseline: [
        { id: 'lint', run: 'npm run lint', policy: 'enforced' },
        { id: 'smoke', run: 'npm run smoke', policy: 'best_effort' },
      ],
    });
  });
});
