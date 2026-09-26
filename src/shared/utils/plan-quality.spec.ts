import { createPlanQualityError, validatePlanQuality } from './plan-quality';
import type { NodeInfra, TestInfraContext } from '../types/detection.types';
import { formatRunnerInvocation } from './verification-commands';

describe('validatePlanQuality', () => {
  const repoName = 'wf';

  const mockTestInfra: TestInfraContext = {
    primary: 'node' as const,
    ecosystems: [
      {
        ecosystem: 'node' as const,
        nodeVersionMajor: 22,
        hasNodeTest: true,
        frameworks: ['jest'],
        scripts: {
          test: 'jest',
          'test:manual': 'ts-node -r tsconfig-paths/register run-manual-test.ts',
          lint: 'eslint "{src,apps,libs,test}/**/*.ts"',
        },
        allScriptNames: ['test', 'test:manual', 'lint'],
        testPatterns: {
          fileSuffix: '.spec' as const,
          mockPrefix: 'mock',
          mockFactoryPrefix: 'createMock',
          describeStyle: 'flat' as const,
          helperPaths: ['test/fixtures/sample-plan.json'],
          mockCleanup: { namespace: 'jest', method: 'restoreAllMocks' as const },
          diSetupPattern: 'testing-module' as const,
          errorHandlerExits: true,
        },
      },
    ],
  };

  const createTestInfraWithoutScripts = (): TestInfraContext => {
    const nodeInfra = mockTestInfra.ecosystems.find(
      (ecosystem): ecosystem is NodeInfra => ecosystem.ecosystem === 'node'
    );
    if (!nodeInfra) throw new Error('Expected node test infrastructure');

    return {
      ...mockTestInfra,
      ecosystems: [{ ...nodeInfra, scripts: {}, allScriptNames: [] }],
    };
  };

  it('returns no violations for an executable plan', () => {
    const result = validatePlanQuality({
      plan: {
        action: 'fix',
        summary: 'Tighten plan validation',
        estimatedComplexity: 'medium',
        steps: [
          'Rename AuthService to AuthSessionService in wf/src/auth/auth.service.ts.',
          'Add wf/src/auth/auth.service.spec.ts using afterEach(() => jest.restoreAllMocks()) and createMockAuthRepository().',
        ],
        affectedFiles: [`${repoName}/src/auth/auth.service.ts`],
        affectedRepositories: [repoName],
        verification: {
          targeted: [
            {
              id: 'manual-plan-validation',
              run: 'yarn test:manual -- test-issue-plan-validation',
              policy: 'enforced',
            },
          ],
        },
      },
      affectedRepositories: [repoName],
      testInfra: mockTestInfra,
    });

    expect(result).toEqual([]);
  });

  it('flags rename steps without explicit replacement targets', () => {
    const result = validatePlanQuality({
      plan: {
        action: 'fix',
        summary: 'Rename auth service',
        estimatedComplexity: 'low',
        steps: ['Rename AuthService in wf/src/auth/auth.service.ts.'],
        affectedRepositories: [repoName],
      },
      affectedRepositories: [repoName],
      testInfra: mockTestInfra,
    });

    expect(result).toEqual([
      expect.objectContaining({
        ruleId: 'rename-target-required',
        message: expect.stringContaining('Rename AuthService'),
      }),
    ]);
  });

  it('flags rename steps that mention context but still omit the replacement target', () => {
    const result = validatePlanQuality({
      plan: {
        action: 'fix',
        summary: 'Rename auth service',
        estimatedComplexity: 'low',
        steps: ['Rename AuthService as part of cleanup in wf/src/auth/auth.service.ts.'],
        affectedRepositories: [repoName],
      },
      affectedRepositories: [repoName],
      testInfra: mockTestInfra,
    });

    expect(result).toEqual([
      expect.objectContaining({
        ruleId: 'rename-target-required',
        message: expect.stringContaining('Rename AuthService as part of cleanup'),
      }),
    ]);
  });

  it('flags verification commands outside the detected allowlist', () => {
    const result = validatePlanQuality({
      plan: {
        action: 'fix',
        summary: 'Use bad verification',
        estimatedComplexity: 'low',
        steps: ['Inspect auth flow.'],
        affectedRepositories: [repoName],
        verification: {
          targeted: [
            {
              id: 'non-allowlisted-command',
              run: 'yarn test:integration -- --bail',
              policy: 'enforced',
            },
          ],
        },
      },
      affectedRepositories: [repoName],
      testInfra: mockTestInfra,
    });

    expect(result).toEqual([
      expect.objectContaining({
        ruleId: 'verification-allowlist',
        message: expect.stringContaining('yarn test:integration -- --bail'),
      }),
    ]);
  });

  it.each(['npm', 'yarn', 'pnpm', 'bun'] as const)(
    'accepts commands formatted for %s through validation', packageManager => {
      const result = validatePlanQuality({
        plan: {
          verification: {
            targeted: [{
              id: 'runner-command',
              run: formatRunnerInvocation(packageManager, 'test:manual', 'x'),
              policy: 'enforced',
            }],
          },
        },
        testInfra: mockTestInfra,
      });

      expect(result).toEqual([]);
    }
  );

  it.each([
    ['npm', 'npm run test -- ...'],
    ['yarn', 'yarn test ...'],
    ['pnpm', 'pnpm run test ...'],
    ['bun', 'bun run test ...'],
  ] as const)('includes %s-specific repair forms in allowlist violations', (packageManager, expectedForm) => {
    const result = validatePlanQuality({
      plan: {
        verification: {
          targeted: [{ id: 'bad-runner-command', run: 'invalid command', policy: 'enforced' }],
        },
      },
      testInfra: mockTestInfra,
      packageManager,
    });

    expect(result).toEqual([
      expect.objectContaining({
        ruleId: 'verification-allowlist',
        message: expect.stringContaining(expectedForm),
      }),
    ]);
  });

  it('lists allowed script names when no package manager is available for repair guidance', () => {
    const result = validatePlanQuality({
      plan: { verification: { targeted: [{ id: 'bad-command', run: 'invalid command', policy: 'enforced' }] } },
      testInfra: mockTestInfra,
    });

    expect(result).toEqual([
      expect.objectContaining({ message: expect.stringContaining('Allowed scripts: test, test:manual, lint.') }),
    ]);
  });

  it('falls back to the inline node form when no scripts are detected', () => {
    const result = validatePlanQuality({
      plan: { verification: { targeted: [{ id: 'empty-scripts', run: 'invalid command', policy: 'enforced' }] } },
      testInfra: createTestInfraWithoutScripts(),
      packageManager: 'yarn',
    });

    expect(result).toEqual([
      expect.objectContaining({
        message: 'Verification command must match the detected allowlist: invalid command Allowed forms: node -e "...".',
      }),
    ]);
  });

  it('uses the inline-form guidance without a package manager when no scripts are detected', () => {
    const result = validatePlanQuality({
      plan: { verification: { targeted: [{ id: 'empty-scripts', run: 'invalid command', policy: 'enforced' }] } },
      testInfra: createTestInfraWithoutScripts(),
    });

    expect(result).toEqual([
      expect.objectContaining({
        message: 'Verification command must match the detected allowlist: invalid command Allowed inline form: node -e "...".',
      }),
    ]);
  });

  it('accepts allowlisted verification commands after normalizing a redundant repo-local cd prefix', () => {
    const result = validatePlanQuality({
      plan: {
        action: 'fix',
        summary: 'Use repo-local verification',
        estimatedComplexity: 'low',
        steps: ['Inspect auth flow.'],
        affectedRepositories: [repoName],
        verification: {
          targeted: [
            {
              id: 'repo-local-command',
              run: 'cd wf && npm run test:manual -- test-issue-plan-validation',
              policy: 'enforced',
            },
          ],
        },
      },
      affectedRepositories: [repoName],
      testInfra: mockTestInfra,
    });

    expect(result).toEqual([]);
  });

  it('flags test guidance that contradicts detected conventions', () => {
    const result = validatePlanQuality({
      plan: {
        action: 'fix',
        summary: 'Use conflicting test conventions',
        estimatedComplexity: 'medium',
        steps: [
          'Add wf/src/auth/auth.service.test.ts with afterEach(() => jest.resetAllMocks()) and createFakeAuthRepository().',
        ],
        affectedRepositories: [repoName],
      },
      affectedRepositories: [repoName],
      testInfra: mockTestInfra,
    });

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'test-file-suffix',
        }),
        expect.objectContaining({
          ruleId: 'mock-cleanup-convention',
        }),
        expect.objectContaining({
          ruleId: 'mock-factory-prefix',
        }),
      ])
    );
  });

  it('flags inline allowlist paths not in affectedFiles', () => {
    const result = validatePlanQuality({
      plan: {
        action: 'feature',
        summary: 'Add config',
        estimatedComplexity: 'low',
        steps: ['Add config fields'],
        affectedFiles: [
          { filePath: `${repoName}/src/config/configuration.ts`, status: 'found' },
          { filePath: `${repoName}/src/factory.ts`, status: 'to-create' },
        ],
        affectedRepositories: [repoName],
        verification: {
          targeted: [
            {
              id: 'no-secrets',
              run: `node -e "const allowed = ['src/config/configuration.ts', 'src/factory.ts', 'src/factory.spec.ts']; console.log('OK')"`,
              policy: 'enforced',
            },
          ],
        },
      },
      affectedRepositories: [repoName],
      testInfra: mockTestInfra,
    });

    expect(result).toEqual([
      expect.objectContaining({
        ruleId: 'verification-inline-allowlist-drift',
        message: expect.stringContaining('src/factory.spec.ts'),
      }),
    ]);
  });

  it('passes when all inline allowlist paths are in affectedFiles', () => {
    const result = validatePlanQuality({
      plan: {
        action: 'feature',
        summary: 'Add config',
        estimatedComplexity: 'low',
        steps: ['Add config fields'],
        affectedFiles: [
          { filePath: `${repoName}/src/config/configuration.ts`, status: 'found' },
          { filePath: `${repoName}/src/factory.ts`, status: 'to-create' },
          { filePath: `${repoName}/src/factory.spec.ts`, status: 'to-create' },
        ],
        affectedRepositories: [repoName],
        verification: {
          targeted: [
            {
              id: 'no-secrets',
              run: `node -e "const allowed = ['src/config/configuration.ts', 'src/factory.ts', 'src/factory.spec.ts']; console.log('OK')"`,
              policy: 'enforced',
            },
          ],
        },
      },
      affectedRepositories: [repoName],
      testInfra: mockTestInfra,
    });

    const driftViolations = result.filter(v => v.ruleId === 'verification-inline-allowlist-drift');
    expect(driftViolations).toEqual([]);
  });

  it('skips inline allowlist drift check when affectedFiles is empty', () => {
    const result = validatePlanQuality({
      plan: {
        action: 'feature',
        summary: 'Add config',
        estimatedComplexity: 'low',
        steps: ['Add config fields'],
        affectedRepositories: [repoName],
        verification: {
          targeted: [
            {
              id: 'no-secrets',
              run: `node -e "const allowed = ['src/config/configuration.ts']; console.log('OK')"`,
              policy: 'enforced',
            },
          ],
        },
      },
      affectedRepositories: [repoName],
      testInfra: mockTestInfra,
    });

    const driftViolations = result.filter(v => v.ruleId === 'verification-inline-allowlist-drift');
    expect(driftViolations).toEqual([]);
  });

  it('ignores non-inline verification commands for allowlist drift', () => {
    const result = validatePlanQuality({
      plan: {
        action: 'feature',
        summary: 'Add config',
        estimatedComplexity: 'low',
        steps: ['Add config fields'],
        affectedFiles: [{ filePath: `${repoName}/src/config.ts`, status: 'found' }],
        affectedRepositories: [repoName],
        verification: {
          targeted: [
            {
              id: 'unit-tests',
              run: 'yarn test -- src/config.spec.ts',
              policy: 'enforced',
            },
          ],
        },
      },
      affectedRepositories: [repoName],
      testInfra: mockTestInfra,
    });

    const driftViolations = result.filter(v => v.ruleId === 'verification-inline-allowlist-drift');
    expect(driftViolations).toEqual([]);
  });

  it('flags vi.resetAllMocks when convention is vi.restoreAllMocks', () => {
    const result = validatePlanQuality({
      plan: {
        action: 'fix',
        summary: 'Add vitest test',
        estimatedComplexity: 'low',
        steps: ['Add test with afterEach(() => vi.resetAllMocks()).'],
        affectedRepositories: [repoName],
      },
      affectedRepositories: [repoName],
      testInfra: {
        ...mockTestInfra,
        ecosystems: [{
          ...(mockTestInfra.ecosystems[0] as NodeInfra),
          frameworks: ['vitest'] as NodeInfra['frameworks'],
          testPatterns: {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            ...(mockTestInfra.ecosystems[0] as NodeInfra).testPatterns!,
            mockCleanup: { namespace: 'vi', method: 'restoreAllMocks' as const },
          },
        }],
      },
    });

    expect(result).toEqual([
      expect.objectContaining({ ruleId: 'mock-cleanup-convention' }),
    ]);
  });
});

describe('createPlanQualityError', () => {
  it('formats rule ids and repair guidance in one error message', () => {
    const error = createPlanQualityError([
      {
        ruleId: 'rename-target-required',
        message: 'Step 1 must name the replacement target.',
      },
      {
        ruleId: 'verification-allowlist',
        message: 'Use an allowed verification command form.',
      },
    ]);

    expect(error.message).toContain('Generated plan failed quality checks');
    expect(error.message).toContain('[rename-target-required]');
    expect(error.message).toContain('[verification-allowlist]');
  });
});

describe('validatePlanQuality with skillRules', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('accepts arbitrary string ruleIds from skill rules', () => {
    const result = validatePlanQuality({
      plan: { steps: ['Do work'] },
      skillRules: [{ ruleId: 'skill:custom-rule', validate: () => ['violation message'] }],
    });

    expect(result).toEqual([
      { ruleId: 'skill:custom-rule', message: 'violation message' },
    ]);
  });

  it('merges skill violations with built-in violations', () => {
    const result = validatePlanQuality({
      plan: {
        steps: ['Rename AuthService in wf/src/auth.ts.'],
      },
      affectedRepositories: ['wf'],
      skillRules: [{ ruleId: 'custom-skill-rule', validate: () => ['skill says no'] }],
    });

    const ruleIds = result.map(v => v.ruleId);
    expect(ruleIds).toContain('rename-target-required');
    expect(ruleIds).toContain('custom-skill-rule');
  });

  it('deduplicates identical skill violations via uniqueViolations', () => {
    const duplicateRule = {
      ruleId: 'dupe-rule',
      validate: () => ['same message', 'same message'],
    };

    const result = validatePlanQuality({
      plan: { steps: ['Clean step'] },
      skillRules: [duplicateRule],
    });

    const dupes = result.filter(v => v.ruleId === 'dupe-rule');
    expect(dupes).toHaveLength(1);
  });

  it('returns no skill violations when skillRules is empty', () => {
    const result = validatePlanQuality({
      plan: { steps: ['Clean step'] },
      skillRules: [],
    });

    expect(result).toEqual([]);
  });

  it('returns no violations when skillRules is omitted', () => {
    const result = validatePlanQuality({
      plan: { steps: ['Clean step'] },
    });

    expect(result).toEqual([]);
  });
});
