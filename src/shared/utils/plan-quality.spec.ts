import { createPlanQualityError, validatePlanQuality } from './plan-quality';
import type { NodeInfra, TestInfraContext } from '../types/detection.types';

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
              run: 'cd wf && yarn test:manual -- test-issue-plan-validation',
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
