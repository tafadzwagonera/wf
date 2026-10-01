import { mergeVerificationSteps, normalizePlanVerification, normalizeTargetedStepCommand, parseVerificationManifest } from './verification-manifest';

describe('parseVerificationManifest', () => {
  afterEach(() => jest.restoreAllMocks());

  it('preserves earlyExitPattern in manifests and plan normalization', () => {
    const manifest = parseVerificationManifest(JSON.stringify({ version: 1, baseline: [{ id: 'tf', run: 'terraform plan', policy: 'enforced', earlyExitPattern: 'Preparing the remote plan' }] }), '/tmp/verification.json');
    const plan = normalizePlanVerification({ targeted: manifest.baseline }, '/tmp/plan.json');
    expect(manifest.baseline[0].earlyExitPattern).toBe('Preparing the remote plan');
    expect(plan?.targeted?.[0].earlyExitPattern).toBe('Preparing the remote plan');
  });
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

  it('preserves the repo field on a baseline step when present', () => {
    const manifest = parseVerificationManifest(
      JSON.stringify({
        version: 1,
        baseline: [{ id: 'test', run: 'yarn test', policy: 'enforced', repo: 'shop-v1.1' }],
      }),
      '/tmp/verification.json',
    );
    expect(manifest.baseline[0].repo).toBe('shop-v1.1');
  });

  it('warns when a baseline step uses terraform fmt -recursive', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    parseVerificationManifest(
      JSON.stringify({
        version: 1,
        baseline: [{ id: 'format', run: 'terraform fmt -check -recursive', policy: 'enforced' }],
      }),
      '/tmp/verification.json',
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('terraform fmt -recursive'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"format"'));
  });

  it('warns when a baseline step uses terraform fmt --recursive', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    parseVerificationManifest(
      JSON.stringify({
        version: 1,
        baseline: [{ id: 'fmt', run: 'terraform fmt --recursive', policy: 'enforced' }],
      }),
      '/tmp/verification.json',
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('terraform fmt -recursive'));
  });

  it('does not warn for a scoped terraform fmt -check step', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    parseVerificationManifest(
      JSON.stringify({
        version: 1,
        baseline: [{ id: 'format', run: 'terraform fmt -check main.tf', policy: 'enforced' }],
      }),
      '/tmp/verification.json',
    );
    expect(warn).not.toHaveBeenCalled();
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

describe('mergeVerificationSteps', () => {
  it('drops targeted step whose command duplicates a baseline script', () => {
    const baseline = [
      { id: 'build', run: 'yarn build', policy: 'enforced' as const },
      { id: 'test', run: 'yarn test', policy: 'enforced' as const },
    ];
    const targeted = [
      { id: 'typescript-build', run: 'yarn build', policy: 'enforced' as const },
      { id: 'no-stale-symbols', run: "bash -c 'grep -rn ...'", policy: 'enforced' as const },
    ];

    const result = mergeVerificationSteps(baseline, targeted);

    expect(result).toEqual([
      { id: 'build', run: 'yarn build', policy: 'enforced' },
      { id: 'test', run: 'yarn test', policy: 'enforced' },
      { id: 'no-stale-symbols', run: "bash -c 'grep -rn ...'", policy: 'enforced' },
    ]);
  });

  it('drops targeted step matching a baseline script across package managers', () => {
    const baseline = [
      { id: 'build', run: 'yarn build', policy: 'enforced' as const },
    ];
    const targeted = [
      { id: 'npm-build', run: 'npm build', policy: 'enforced' as const },
      { id: 'pnpm-build', run: 'pnpm build', policy: 'enforced' as const },
      { id: 'unique-check', run: 'node -e "assert(true)"', policy: 'enforced' as const },
    ];

    const result = mergeVerificationSteps(baseline, targeted);

    expect(result).toEqual([
      { id: 'build', run: 'yarn build', policy: 'enforced' },
      { id: 'unique-check', run: 'node -e "assert(true)"', policy: 'enforced' },
    ]);
  });

  it('drops targeted step matching deno task syntax', () => {
    const baseline = [
      { id: 'test', run: 'deno task test', policy: 'enforced' as const },
    ];
    const targeted = [
      { id: 'unit-tests', run: 'yarn test', policy: 'enforced' as const },
    ];

    const result = mergeVerificationSteps(baseline, targeted);

    expect(result).toEqual([
      { id: 'test', run: 'deno task test', policy: 'enforced' },
    ]);
  });

  it('allows override policy to bypass command-duplicate check and append the targeted step', () => {
    const baseline = [
      { id: 'test', run: 'yarn test', policy: 'enforced' as const },
    ];
    const targeted = [
      { id: 'scoped-test', run: 'yarn test -- src/foo.spec.ts', policy: 'override' as const },
    ];

    const result = mergeVerificationSteps(baseline, targeted);

    expect(result).toEqual([
      { id: 'test', run: 'yarn test', policy: 'enforced' },
      { id: 'scoped-test', run: 'yarn test -- src/foo.spec.ts', policy: 'override' },
    ]);
  });

  it('allows override policy with same ID to replace a baseline step', () => {
    const baseline = [
      { id: 'test', run: 'yarn test', policy: 'enforced' as const },
    ];
    const targeted = [
      { id: 'test', run: 'yarn test --coverage', policy: 'override' as const },
    ];

    const result = mergeVerificationSteps(baseline, targeted);

    expect(result).toEqual([
      { id: 'test', run: 'yarn test --coverage', policy: 'override' },
    ]);
  });

  it('preserves targeted steps with unique non-script commands', () => {
    const baseline = [
      { id: 'build', run: 'yarn build', policy: 'enforced' as const },
    ];
    const targeted = [
      { id: 'stale-check', run: "bash -c 'grep -rn old_symbol src/'", policy: 'enforced' as const },
      { id: 'inline-assert', run: 'node -e "require(\'assert\').ok(true)"', policy: 'enforced' as const },
    ];

    const result = mergeVerificationSteps(baseline, targeted);

    expect(result).toEqual([
      { id: 'build', run: 'yarn build', policy: 'enforced' },
      { id: 'stale-check', run: "bash -c 'grep -rn old_symbol src/'", policy: 'enforced' },
      { id: 'inline-assert', run: 'node -e "require(\'assert\').ok(true)"', policy: 'enforced' },
    ]);
  });

  it('retains ID-based dedup when targeted ID matches a baseline ID', () => {
    const baseline = [
      { id: 'lint', run: 'yarn lint', policy: 'enforced' as const },
    ];
    const targeted = [
      { id: 'lint', run: 'yarn lint --fix', policy: 'enforced' as const },
    ];

    const result = mergeVerificationSteps(baseline, targeted);

    expect(result).toEqual([
      { id: 'lint', run: 'yarn lint', policy: 'enforced' },
    ]);
  });
});

describe('filterVerificationStepsForRepo', () => {
  const makeStep = (id: string, repo?: string) => ({
    id,
    run: `yarn ${id}`,
    policy: 'enforced' as const,
    ...(repo !== undefined && { repo }),
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns all steps as kept when affectedRepositories has exactly one entry', () => {
    const steps = [makeStep('typecheck', 'shop-v1.1'), makeStep('test', 'repo-a')];
    const { kept, dropped } = require('./verification-manifest').filterVerificationStepsForRepo(
      steps,
      'repo-a',
      ['repo-a'],
    );
    expect(kept).toEqual(steps);
    expect(dropped).toEqual([]);
  });

  it('keeps only steps whose repo matches repoName in a multi-repo plan', () => {
    const target = makeStep('test', 'repo-a');
    const other = makeStep('typecheck', 'shop-v1.1');
    const { kept, dropped } = require('./verification-manifest').filterVerificationStepsForRepo(
      [target, other],
      'repo-a',
      ['repo-a', 'shop-v1.1'],
    );
    expect(kept).toEqual([target]);
    expect(dropped).toEqual([other]);
  });

  it('drops a step with a non-matching repo field in a multi-repo plan', () => {
    const foreign = makeStep('typecheck', 'shop-v1.1');
    const { kept, dropped } = require('./verification-manifest').filterVerificationStepsForRepo(
      [foreign],
      'repo-a',
      ['repo-a', 'shop-v1.1'],
    );
    expect(kept).toHaveLength(0);
    expect(dropped).toEqual([foreign]);
  });

  it('passes all steps through when no step has a repo field (legacy-plan bypass)', () => {
    const unscoped = makeStep('build');
    const { kept, dropped } = require('./verification-manifest').filterVerificationStepsForRepo(
      [unscoped],
      'repo-a',
      ['repo-a', 'shop-v1.1'],
    );
    expect(kept).toEqual([unscoped]);
    expect(dropped).toHaveLength(0);
  });

  it('drops an unscoped step when at least one step in the array carries a repo field', () => {
    const scoped = makeStep('test', 'repo-a');
    const unscoped = makeStep('build');
    const { kept, dropped } = require('./verification-manifest').filterVerificationStepsForRepo(
      [scoped, unscoped],
      'repo-a',
      ['repo-a', 'shop-v1.1'],
    );
    expect(kept).toEqual([scoped]);
    expect(dropped).toEqual([unscoped]);
  });

  it('returns empty kept and dropped for an empty steps array', () => {
    const { kept, dropped } = require('./verification-manifest').filterVerificationStepsForRepo(
      [],
      'repo-a',
      ['repo-a', 'shop-v1.1'],
    );
    expect(kept).toEqual([]);
    expect(dropped).toEqual([]);
  });
});
