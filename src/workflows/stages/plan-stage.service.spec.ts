import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AiService } from '../../integrations/ai/ai.service';
import { PlanStageService } from './plan-stage.service';
import { StageAgentService } from '../../integrations/ai/stage-agent.service';
import { knownSkills, registerSkill } from '../../skills/skill-registry';
import {
  buildPlanArtifactManifest,
  buildPlanArtifactManifestPath,
  buildPlanArtifactFilename,
  hashPlanArtifactSources,
  writePlanArtifactManifest,
} from '../../common/utils/plan-artifact';
import { AiProviderError, PlanArtifactNotFoundError, ValidationError } from '../../common/utils/errors';
import { detectTestInfra } from '../../common/utils/detect-test-infra';
import { detectRepoConventions } from '../../common/utils/detect-repo-conventions';
import { findConfigReadClusters } from '../../common/utils/find-existing-resolvers';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTempDir as createManagedTempDir } from '../../common/testing/temp-dir';

jest.mock('inquirer', () => ({
  __esModule: true,
  default: {
    prompt: jest.fn(),
  },
}));

jest.mock('../../common/utils/find-existing-resolvers', () => ({
  findConfigReadClusters: jest.fn().mockResolvedValue([]),
  findFunctionsByName: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../common/utils/detect-test-infra', () => ({
  detectTestInfra: jest.fn(),
}));

jest.mock('../../common/utils/detect-repo-conventions', () => {
  const actual = jest.requireActual('../../common/utils/detect-repo-conventions');
  return { ...actual, detectRepoConventions: jest.fn(), detectPackageManager: jest.fn() };
});

jest.mock('../../common/utils/extract-figma-links', () => ({
  searchFigmaLinksForTicket: jest.fn().mockResolvedValue([]),
  extractFigmaLinks: jest.fn().mockReturnValue([]),
  resolvePostParseFigmaLinks: jest.fn().mockResolvedValue([]),
}));

describe('PlanStageService', () => {
  const mockDetectTestInfra = detectTestInfra as jest.MockedFunction<typeof detectTestInfra>;
  const mockDetectRepoConventions = detectRepoConventions as jest.MockedFunction<typeof detectRepoConventions>;
  const mockPlan = {
    action: 'fix',
    summary: 'Update auth redirect handling',
    estimatedComplexity: 'medium',
    steps: ['Inspect redirect logic', 'Adjust callback handling'],
    affectedFiles: ['src/auth/callback.ts'],
    verification: {
      targeted: [
        {
          id: 'manual-auth-smoke',
          run: 'yarn test:manual -- test-auth-redirect',
          policy: 'enforced',
          reason: 'Covers redirect callback flow',
        },
      ],
    },
    risks: [{ description: 'Regression in login flow', severity: 'medium' }],
  };

  const buildService = async (agentEnabled: boolean = false) => {
    const module = await Test.createTestingModule({
      providers: [
        PlanStageService,
        {
          provide: AiService,
          useValue: {
            generatePlan: jest.fn().mockResolvedValue(mockPlan),
            validatePlanJson: jest.fn().mockResolvedValue(mockPlan),
          },
        },
        {
          provide: StageAgentService,
          useValue: {
            isEnabledForStage: jest.fn().mockReturnValue(agentEnabled),
            generatePlan: jest.fn().mockResolvedValue({ plan: mockPlan, sessionId: undefined }),
            enrichPlanWithDirectoryConfigs: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
      ],
    }).compile();

    return {
      service: module.get(PlanStageService),
      aiService: module.get(AiService),
      stageAgentService: module.get(StageAgentService),
    };
  };

  afterEach(() => jest.restoreAllMocks());

  beforeEach(() => {
    mockDetectTestInfra.mockReturnValue({
      primary: 'node',
      ecosystems: [
        {
          ecosystem: 'node',
          nodeVersionMajor: 22,
          hasNodeTest: true,
          frameworks: ['jest'],
          scripts: { test: 'jest', 'test:manual': 'ts-node run-manual-test.ts' },
          allScriptNames: ['test', 'test:manual'],
          testPatterns: {
            fileSuffix: '.spec',
            mockPrefix: 'mock',
            mockFactoryPrefix: 'createMock',
            describeStyle: 'flat',
            helperPaths: ['src/test/helpers.ts'],
            mockCleanup: { namespace: 'jest', method: 'restoreAllMocks' },
            diSetupPattern: 'testing-module',
            errorHandlerExits: true,
          },
        },
      ],
    });
    mockDetectRepoConventions.mockReturnValue({ packageManager: 'yarn' } as any);
  });

  it('generates a plan using extracted ticket summary and affected repositories', async () => {
    const { service, aiService } = await buildService();

    await service.generatePlan('# WBP-123: Fix auth redirect\n\n## Description\n\nRestore callback flow\n', {
      action: 'fix',
      ticketKey: 'WBP-123',
      affectedRepositories: ['repo-a', 'repo-b'],
    });

    expect(aiService.generatePlan).toHaveBeenCalledWith(
      'fix',
      expect.stringContaining('Restore callback flow'),
      expect.objectContaining({
        ticketKey: 'WBP-123',
        summary: 'Fix auth redirect',
        affectedRepositories: ['repo-a', 'repo-b'],
        testInfra: expect.objectContaining({
          primary: expect.any(String),
          ecosystems: expect.arrayContaining([
            expect.objectContaining({
              ecosystem: 'node',
              testPatterns: expect.objectContaining({
                fileSuffix: '.spec',
              }),
            }),
          ]),
        }),
      })
    );
  });

  it('derives conventions from repoDir before generating a plan', async () => {
    const { service, aiService } = await buildService();

    await service.generatePlan('Ticket body', { action: 'fix', repoDir: '/tmp/yarn-repo' });

    expect(mockDetectRepoConventions).toHaveBeenCalledWith('/tmp/yarn-repo');
    expect(aiService.generatePlan).toHaveBeenCalledWith(
      'fix',
      'Ticket body',
      expect.objectContaining({ conventions: expect.objectContaining({ packageManager: 'yarn' }) })
    );
  });

  it('preserves repoDir when createPlanArtifact starts plan generation', async () => {
    const { service, aiService } = await buildService();
    const repoDir = createManagedTempDir('plan-repo-dir');
    const ticketPath = path.join(repoDir, 'WBP-REPO-DIR.md');
    fs.writeFileSync(ticketPath, '# WBP-REPO-DIR: Preserve repo directory');
    const generatePlanSpy = jest.spyOn(service, 'generatePlan');

    await service.createPlanArtifact(
      { ticketKey: 'WBP-REPO-DIR', content: '# WBP-REPO-DIR: Preserve repo directory', path: ticketPath },
      { action: 'fix', repoDir }
    );

    expect(generatePlanSpy).toHaveBeenCalledWith(
      '# WBP-REPO-DIR: Preserve repo directory',
      expect.objectContaining({ repoDir })
    );
    expect(aiService.generatePlan).toHaveBeenCalled();
  });

  it('keeps explicitly supplied conventions instead of deriving replacements', async () => {
    const { service, aiService } = await buildService();
    const mockConventions = { packageManager: 'bun' } as any;
    mockDetectRepoConventions.mockClear();

    await service.generatePlan('Ticket body', {
      action: 'fix', repoDir: '/tmp/bun-repo', conventions: mockConventions,
    });

    expect(mockDetectRepoConventions).not.toHaveBeenCalled();
    expect(aiService.generatePlan).toHaveBeenCalledWith(
      'fix',
      'Ticket body',
      expect.objectContaining({ conventions: mockConventions })
    );
  });

  it('uses the stage agent service when plan agent mode is enabled', async () => {
    const { service, aiService, stageAgentService } = await buildService(true);

    await service.generatePlan('Ticket body', {
      action: 'fix',
      ticketKey: 'WBP-321',
      affectedRepositories: ['repo-a'],
    });

    expect(stageAgentService.generatePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'fix',
        issueContent: 'Ticket body',
        ticketKey: 'WBP-321',
        affectedRepositories: ['repo-a'],
        testInfra: expect.objectContaining({
          primary: expect.any(String),
          ecosystems: expect.arrayContaining([
            expect.objectContaining({
              ecosystem: 'node',
              testPatterns: expect.objectContaining({
                fileSuffix: '.spec',
              }),
            }),
          ]),
        }),
      })
    );
    expect(aiService.generatePlan).not.toHaveBeenCalled();
  });

  it('passes conventions and prior plans through to AI service', async () => {
    const { service, aiService } = await buildService();
    const mockConventions = {
      language: 'typescript',
      linter: null,
      typescript: null,
      go: null,
      python: null,
      terraform: null,
      folderStructure: [],
      namingPattern: 'kebab-case',
      nestjsDetected: false,
      importStyle: 'commonjs',
      keyDependencies: [],
      errorHandlingPaths: [],
      gitHooks: [],
    };
    const mockPriorPlans = { plans: [], repoName: 'test-repo' };
    const mockPlanCorrelation = { matches: [], repoName: 'test-repo' };

    await service.generatePlan('Ticket body', {
      action: 'fix',
      conventions: mockConventions as any,
      priorPlans: mockPriorPlans as any,
      planCorrelation: mockPlanCorrelation as any,
    });

    expect(aiService.generatePlan).toHaveBeenCalledWith(
      'fix',
      'Ticket body',
      expect.objectContaining({
        conventions: mockConventions,
        priorPlans: mockPriorPlans,
        planCorrelation: mockPlanCorrelation,
      })
    );
  });

  it('passes conventions through to stage agent service when agent mode enabled', async () => {
    const { service, stageAgentService } = await buildService(true);
    const mockConventions = {
      language: 'typescript',
      linter: null,
      typescript: null,
      go: null,
      python: null,
      terraform: null,
      folderStructure: [],
      namingPattern: 'kebab-case',
      nestjsDetected: false,
      importStyle: 'commonjs',
      keyDependencies: [],
      errorHandlingPaths: [],
      gitHooks: [],
    };

    await service.generatePlan('Ticket body', {
      action: 'fix',
      conventions: mockConventions as any,
    });

    expect(stageAgentService.generatePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        conventions: mockConventions,
      })
    );
  });

  it('passes prior plans through to stage agent service when agent mode enabled', async () => {
    const { service, stageAgentService } = await buildService(true);
    const mockPriorPlans = { plans: [], repoName: 'test-repo' };

    await service.generatePlan('Ticket body', {
      action: 'fix',
      priorPlans: mockPriorPlans as any,
    });

    expect(stageAgentService.generatePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        priorPlans: mockPriorPlans,
      })
    );
  });

  it('forwards onProgress to stage agent service when agent mode is enabled', async () => {
    const { service, stageAgentService } = await buildService(true);
    const onProgress = jest.fn();

    await service.generatePlan('Ticket body', {
      action: 'fix',
      ticketKey: 'WBP-321',
      affectedRepositories: ['repo-a'],
      onProgress,
    });

    expect(stageAgentService.generatePlan).toHaveBeenCalledWith(expect.objectContaining({ onProgress }));
  });

  it('does not forward onProgress when not provided', async () => {
    const { service, stageAgentService } = await buildService(true);

    await service.generatePlan('Ticket body', {
      action: 'fix',
      ticketKey: 'WBP-321',
      affectedRepositories: ['repo-a'],
    });

    expect(stageAgentService.generatePlan).toHaveBeenCalledWith(expect.objectContaining({ onProgress: undefined }));
  });

  it('records the discarded agent error before falling back', async () => {
    const logFileWriter = require('../../common/logger/log-file-writer');
    const appendSpy = jest.spyOn(logFileWriter, 'appendToLogFile').mockImplementation(() => undefined);

    const { service, aiService, stageAgentService } = await buildService(true);
    const stallError = new AiProviderError(
      'Claude CLI finished without returning a result after 2 pass(es) — workload not decreasing. Diagnostics:\nno result message',
      { passes: 2, sessionId: 'sess_stall_plan' },
      true,
      'stall'
    );
    (stageAgentService.generatePlan as jest.Mock).mockRejectedValueOnce(stallError);
    (aiService.generatePlan as jest.Mock).mockResolvedValueOnce(mockPlan);

    await service.generatePlan('Ticket body', {
      action: 'fix',
      ticketKey: 'WBP-401',
      affectedRepositories: ['repo-a'],
    });

    const line = appendSpy.mock.calls.map(call => String(call[1])).find(l => l.startsWith('plan.fallback'));
    expect(line).toContain('reason=no result');
    expect(line).toContain('category=stall');
    expect(line).toContain('session=sess_stall_plan');
    expect(line).toContain('billing=api-key');
    expect(line).toContain('workload not decreasing');
    expect(line).not.toContain('\n');

    appendSpy.mockRestore();
  });

  it('falls back to standard completion when agent plan repair fails', async () => {
    const { service, aiService, stageAgentService } = await buildService(true);
    const proseError = new AiProviderError(
      'Failed to parse resolution plan from agent response',
      {
        response: 'Here is my analysis of the codebase. The auth module needs updating...',
        sessionId: 'test-session-456',
      },
      true,
      'parse'
    );
    const callOrder: string[] = [];
    (stageAgentService.generatePlan as jest.Mock).mockRejectedValueOnce(proseError);
    (aiService.validatePlanJson as jest.Mock).mockImplementationOnce(async () => {
      callOrder.push('validate');
      throw new AiProviderError('Plan JSON could not be corrected', { response: proseError.details.response }, true, 'parse');
    });
    (aiService.generatePlan as jest.Mock).mockImplementationOnce(async () => {
      callOrder.push('fallback');
      return mockPlan;
    });

    const result = await service.generatePlan('Ticket body', {
      action: 'fix',
      ticketKey: 'WBP-400',
      affectedRepositories: ['repo-a'],
    });

    expect(result).toEqual({ plan: mockPlan, sessionId: 'test-session-456' });
    expect(callOrder).toEqual(['validate', 'fallback']);
    expect(aiService.validatePlanJson).toHaveBeenCalledWith(proseError.details.response);
    expect(aiService.generatePlan).toHaveBeenCalledWith(
      'fix',
      'Ticket body',
      expect.objectContaining({
        agentAnalysis: 'Here is my analysis of the codebase. The auth module needs updating...',
      })
    );
  });

  it('returns repaired plan and preserves sessionId when validation succeeds', async () => {
    const { service, aiService, stageAgentService } = await buildService(true);
    const proseError = new AiProviderError(
      'Failed to parse resolution plan from agent response',
      {
        response: JSON.stringify({
          action: 'fix',
          summary: 'Agent draft',
          steps: ['Inspect auth flow'],
          estimatedComplexity: 'low',
        }),
        sessionId: 'test-session-123',
      },
      true,
      'parse'
    );
    (stageAgentService.generatePlan as jest.Mock).mockRejectedValueOnce(proseError);
    (aiService.validatePlanJson as jest.Mock).mockResolvedValueOnce({
      ...mockPlan,
      summary: 'Recovered plan',
    });

    const result = await service.generatePlan('Ticket body', {
      action: 'fix',
      ticketKey: 'WBP-400',
      affectedRepositories: ['repo-a'],
    });

    expect(result).toEqual({
      plan: {
        ...mockPlan,
        summary: 'Recovered plan',
      },
      sessionId: 'test-session-123',
    });
    expect(aiService.generatePlan).not.toHaveBeenCalled();
  });

  it('re-throws rate-limit stalls without falling back to the API-key completion', async () => {
    const { service, aiService, stageAgentService } = await buildService(true);
    const rateLimitStall = new AiProviderError(
      'Claude CLI hit a rate or usage limit and produced no result after 2 pass(es). Diagnostics:\nRate limited (status: rejected)',
      { passes: 2, diagnostics: ['Rate limited (status: rejected)'] },
      true,
      'rate-limit'
    );
    (stageAgentService.generatePlan as jest.Mock).mockRejectedValueOnce(rateLimitStall);

    await expect(service.generatePlan('Ticket body', { action: 'fix', ticketKey: 'WBP-403' })).rejects.toMatchObject({
      category: 'rate-limit',
    });

    expect(aiService.generatePlan).not.toHaveBeenCalled();
    expect(aiService.validatePlanJson).not.toHaveBeenCalled();
  });

  it('re-throws non-parsing AiProviderErrors without falling back', async () => {
    const { service, aiService, stageAgentService } = await buildService(true);
    const rateLimitError = new AiProviderError('Rate limit exceeded', { status: 429 });
    (stageAgentService.generatePlan as jest.Mock).mockRejectedValueOnce(rateLimitError);

    await expect(service.generatePlan('Ticket body', { action: 'fix', ticketKey: 'WBP-401' })).rejects.toThrow(
      'Rate limit exceeded'
    );

    expect(aiService.generatePlan).not.toHaveBeenCalled();
  });

  it('falls back to structured completion when agent prose response is empty', async () => {
    const { service, aiService, stageAgentService } = await buildService(true);
    const emptyProseError = new AiProviderError(
      'Failed to parse resolution plan from agent response',
      {
        response: '',
      },
      true,
      'parse'
    );
    (stageAgentService.generatePlan as jest.Mock).mockRejectedValueOnce(emptyProseError);
    (aiService.validatePlanJson as jest.Mock).mockRejectedValueOnce(
      new AiProviderError('Plan JSON could not be corrected', { response: '' }, true, 'parse')
    );

    const result = await service.generatePlan('Ticket body', { action: 'fix', ticketKey: 'WBP-402' });

    expect(aiService.validatePlanJson).toHaveBeenCalledWith('');
    expect(aiService.generatePlan).toHaveBeenCalled();
    expect(result).toMatchObject({ plan: { action: 'fix', summary: expect.any(String) } });
  });

  it('falls through to generatePlan fallback when validatePlanJson rejects with a non-parse error during agent path', async () => {
    const { service, aiService, stageAgentService } = await buildService(true);
    const proseError = new AiProviderError(
      'Failed to parse resolution plan from agent response',
      {
        response: 'Here is my analysis of the codebase. The auth module needs updating...',
      },
      true,
      'parse'
    );
    (stageAgentService.generatePlan as jest.Mock).mockRejectedValueOnce(proseError);
    (aiService.validatePlanJson as jest.Mock).mockRejectedValueOnce(
      new AiProviderError('Rate limit exceeded', { status: 429 }, true, 'api')
    );

    const result = await service.generatePlan('Ticket body', {
      action: 'fix',
      ticketKey: 'WBP-403',
      affectedRepositories: ['repo-a'],
    });

    expect(aiService.generatePlan).toHaveBeenCalled();
    expect(result).toMatchObject({ plan: { action: 'fix', summary: expect.any(String) } });
  });

  it('falls through to executeFallbackCompletion when validatePlanJson rejects with a non-parse error', async () => {
    const { service, aiService, stageAgentService } = await buildService(true);
    const proseError = new AiProviderError(
      'Failed to parse resolution plan from agent response',
      { response: 'Here is my analysis of the codebase...' },
      true,
      'parse'
    );
    (stageAgentService.generatePlan as jest.Mock).mockRejectedValueOnce(proseError);
    (aiService.validatePlanJson as jest.Mock).mockRejectedValueOnce(
      new AiProviderError('Rate limit exceeded', { status: 429 }, true, 'api')
    );

    const result = await service.generatePlan('Ticket body', { action: 'fix', ticketKey: 'WBP-404' });

    expect(aiService.generatePlan).toHaveBeenCalled();
    expect(result).toMatchObject({ plan: { action: 'fix', summary: expect.any(String) } });
  });

  it('throws when fallback result is structurally invalid', async () => {
    const { service, aiService, stageAgentService } = await buildService(true);
    const proseError = new AiProviderError('Failed to parse resolution plan from agent response', {
      response: 'Some analysis prose...',
    });
    (stageAgentService.generatePlan as jest.Mock).mockRejectedValueOnce(proseError);
    (aiService.generatePlan as jest.Mock).mockResolvedValueOnce({ summary: 'incomplete' });

    await expect(service.generatePlan('Ticket body', { action: 'fix', ticketKey: 'WBP-403' })).rejects.toThrow(
      'Fallback completion did not produce a valid resolution plan'
    );
  });

  it('retries once with plan-quality feedback when the first standard plan is semantically invalid', async () => {
    const { service, aiService } = await buildService();
    (aiService.generatePlan as jest.Mock)
      .mockResolvedValueOnce({
        ...mockPlan,
        steps: ['Rename AuthService in repo-a/src/auth.ts.'],
        affectedRepositories: ['repo-a'],
      })
      .mockResolvedValueOnce({
        ...mockPlan,
        steps: ['Rename AuthService to AuthSessionService in repo-a/src/auth.ts.'],
        affectedRepositories: ['repo-a'],
      });

    const result = await service.generatePlan('Ticket body', {
      action: 'fix',
      ticketKey: 'WBP-404',
      affectedRepositories: ['repo-a'],
    });

    expect(result.plan.steps).toEqual(['Rename AuthService to AuthSessionService in repo-a/src/auth.ts.']);
    expect(aiService.generatePlan).toHaveBeenNthCalledWith(
      2,
      'fix',
      'Ticket body',
      expect.objectContaining({
        planQualityFeedback: expect.arrayContaining([expect.stringContaining('[rename-target-required]')]),
      })
    );
  });

  it('includes detected yarn runner forms in verification retry feedback', async () => {
    const { service, aiService } = await buildService();
    (aiService.generatePlan as jest.Mock)
      .mockResolvedValueOnce({
        ...mockPlan,
        affectedRepositories: ['repo-a'],
        verification: { targeted: [{ id: 'invalid', run: 'yarn unknown', policy: 'enforced' }] },
      })
      .mockResolvedValueOnce({ ...mockPlan, affectedRepositories: ['repo-a'] });

    await service.generatePlan('Ticket body', { action: 'fix', repoDir: '/tmp/yarn-repo' });

    expect(aiService.generatePlan).toHaveBeenNthCalledWith(
      2,
      'fix',
      'Ticket body',
      expect.objectContaining({
        planQualityFeedback: expect.arrayContaining([expect.stringContaining('yarn test ...')]),
      })
    );
  });

  it('logs and surfaces violations in the risk section when the retried plan is still semantically invalid', async () => {
    const { service, aiService } = await buildService();
    (aiService.generatePlan as jest.Mock)
      .mockResolvedValueOnce({
        ...mockPlan,
        estimatedComplexity: 'low',
        risks: [],
        steps: ['Rename AuthService in repo-a/src/auth.ts.'],
        affectedRepositories: ['repo-a'],
      })
      .mockResolvedValueOnce({
        ...mockPlan,
        estimatedComplexity: 'low',
        risks: [],
        steps: ['Rename AuthService in repo-a/src/auth.ts.'],
        affectedRepositories: ['repo-a'],
      });

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    const result = await service.generatePlan('Ticket body', {
      action: 'fix',
      ticketKey: 'WBP-405',
      affectedRepositories: ['repo-a'],
    });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Plan quality violations persisted after retry'));

    expect(result.plan.risks).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(result.plan.risks!.some(r => r.description.includes('[plan-quality]'))).toBe(true);
    expect(result.plan.estimatedComplexity).toBe('medium');
  });

  it('records a duplicate-resolver reuse risk without retrying the planner', async () => {
    const { service, aiService } = await buildService();
    const repoDir = '/tmp/wf-duplicate-resolver-repo';
    const mockClusterLookup = jest.mocked(findConfigReadClusters);
    mockClusterLookup.mockResolvedValue([{ file: 'src/integrations/ai/ai.service.ts', line: 977, count: 2 }]);
    (aiService.generatePlan as jest.Mock).mockResolvedValue({
      ...mockPlan,
      risks: [],
      steps: ['Read `stages.implement.provider` and `ai.stages.plan.provider` in a new helper.'],
    });
    jest.spyOn(console, 'log').mockImplementation();

    const result = await service.generatePlan('Ticket body', { action: 'fix', ticketKey: 'WBP-406', repoDir });

    expect(aiService.generatePlan).toHaveBeenCalledTimes(1);
    expect(mockClusterLookup).toHaveBeenCalledTimes(1);
    expect(mockClusterLookup.mock.calls[0]).toEqual([repoDir, ['provider']]);
    expect(result.plan.risks?.some(risk =>
      /reuse .* in src\/integrations\/ai\/ai\.service\.ts:977, or state why it cannot be reused/.test(risk.description)
    )).toBe(true);
  });

  it('applyQualityViolationsToRisks returns a new plan without mutating the attempt or the violations', async () => {
    const { service } = await buildService();
    jest.spyOn(console, 'log').mockImplementation();
    const attempt = {
      plan: { ...mockPlan, estimatedComplexity: 'low', risks: [{ description: 'Prior risk', severity: 'medium' }] },
      sessionId: 'session-1',
      modelUsed: 'model-1',
    };
    const violations = ['[rename-target-required] Step 1 must name the target.'];

    const result = (service as any).applyQualityViolationsToRisks(attempt, violations);

    expect(attempt.plan.risks).toEqual([{ description: 'Prior risk', severity: 'medium' }]);
    expect(attempt.plan.estimatedComplexity).toBe('low');
    expect(violations).toEqual(['[rename-target-required] Step 1 must name the target.']);
    expect(result.plan.risks).toEqual([
      { description: 'Prior risk', severity: 'medium' },
      { description: '[plan-quality] [rename-target-required] Step 1 must name the target.', severity: 'medium' },
    ]);
    expect(result.sessionId).toBe('session-1');
  });

  it('accepts repo-local verification commands without triggering a corrective retry', async () => {
    const { service, aiService } = await buildService();
    (aiService.generatePlan as jest.Mock).mockResolvedValueOnce({
      ...mockPlan,
      affectedRepositories: ['repo-a'],
      verification: {
        targeted: [
          {
            id: 'repo-local-command',
            run: 'cd repo-a && yarn test:manual -- test-issue-plan-validation',
            policy: 'enforced',
          },
        ],
      },
    });

    const result = await service.generatePlan('Ticket body', {
      action: 'fix',
      ticketKey: 'WBP-406',
      affectedRepositories: ['repo-a'],
    });

    expect(result.plan.verification?.targeted?.[0]?.run).toBe(
      'cd repo-a && yarn test:manual -- test-issue-plan-validation'
    );
    expect(aiService.generatePlan).toHaveBeenCalledTimes(1);
  });

  it('persists a JSON plan artifact and returns cache metadata', async () => {
    const { service } = await buildService();
    const tempDir = createManagedTempDir('plan');
    const ticketPath = path.join(tempDir, 'WBP-123.md');
    const planPath = path.join(tempDir, `2026-04-16-${hashPlanArtifactSources(['WBP-123'])}-fix-plan.json`);
    fs.writeFileSync(ticketPath, '# WBP-123: Fix auth redirect');
    jest.useFakeTimers().setSystemTime(new Date('2026-04-16T00:00:00.000Z'));

    const artifact = await service.createPlanArtifact(
      {
        ticketKey: 'WBP-123',
        content: '# WBP-123: Fix auth redirect',
        path: ticketPath,
      },
      {
        action: 'fix',
        affectedRepositories: ['repo-a'],
      }
    );
    jest.useRealTimers();

    expect(fs.readFileSync(planPath, 'utf-8')).toBe(JSON.stringify(mockPlan, null, 2));
    expect(fs.existsSync(buildPlanArtifactManifestPath(planPath))).toBe(true);
    expect(artifact).toEqual({
      plan: mockPlan,
      action: 'fix',
      path: planPath,
      fromCache: false,
    });
  });

  it('writes Figma links from post-parse inquirer into manifest when conventions show a design system', async () => {
    const { resolvePostParseFigmaLinks } = jest.requireMock('../../common/utils/extract-figma-links');
    (resolvePostParseFigmaLinks as jest.Mock).mockResolvedValueOnce(['https://figma.com/design/abc123/Card']);
    const { service, aiService } = await buildService();
    const tempDir = createManagedTempDir('plan');
    const ticketPath = path.join(tempDir, 'WBP-500.md');
    fs.writeFileSync(ticketPath, '# WBP-500: Style the card');

    await service.createPlanArtifact(
      { ticketKey: 'WBP-500', content: '# WBP-500: Style the card', path: ticketPath },
      { action: 'fix', affectedRepositories: ['repo-a'], figma: true }
    );

    expect(aiService.generatePlan).toHaveBeenCalledWith(
      'fix', '# WBP-500: Style the card',
      expect.objectContaining({ figmaLinks: [] })
    );
    const manifestFiles = fs.readdirSync(tempDir).filter(f => f.endsWith('.sources.json'));
    expect(manifestFiles).toHaveLength(1);
    const manifest = JSON.parse(fs.readFileSync(path.join(tempDir, manifestFiles[0]), 'utf-8'));
    expect(manifest.figmaLinks).toEqual(['https://figma.com/design/abc123/Card']);
    const planFiles = fs.readdirSync(tempDir).filter(f => f.endsWith('-plan.json'));
    expect(planFiles).toHaveLength(1);
    const savedPlan = JSON.parse(fs.readFileSync(path.join(tempDir, planFiles[0]), 'utf-8'));
    expect(savedPlan.figmaLinks).toEqual(['https://figma.com/design/abc123/Card']);
  });

  it('writes uiDesignScreenshots into plan JSON when provided in options', async () => {
    const { service } = await buildService();
    const tempDir = createManagedTempDir('plan-ui-screenshots');
    const ticketPath = path.join(tempDir, 'ABC-1.md');
    fs.writeFileSync(ticketPath, '# ABC-1: Style the header');

    await service.createPlanArtifact(
      { ticketKey: 'ABC-1', content: '# ABC-1: Style the header', path: ticketPath },
      { action: 'fix', uiDesignScreenshots: ['/abs/design.png'] }
    );

    const planFiles = fs.readdirSync(tempDir).filter(f => f.endsWith('-plan.json'));
    expect(planFiles).toHaveLength(1);
    const savedPlan = JSON.parse(fs.readFileSync(path.join(tempDir, planFiles[0]), 'utf-8'));
    expect(savedPlan.uiDesignScreenshots).toEqual(['/abs/design.png']);
  });

  it('forwards uiDesignScreenshots to aiService.generatePlan during createPlanArtifact', async () => {
    const { service, aiService } = await buildService();
    const tempDir = createManagedTempDir('plan-ui-forwarded');
    const ticketPath = path.join(tempDir, 'ABC-3.md');
    fs.writeFileSync(ticketPath, '# ABC-3: Style the nav');

    await service.createPlanArtifact(
      { ticketKey: 'ABC-3', content: '# ABC-3: Style the nav', path: ticketPath },
      { action: 'fix', uiDesignScreenshots: ['/abs/nav.png'] }
    );

    expect(aiService.generatePlan).toHaveBeenCalledWith(
      expect.any(String), expect.any(String),
      expect.objectContaining({ uiDesignScreenshots: ['/abs/nav.png'] })
    );
  });

  it('positions uiDesignScreenshots after figmaLinks in key order', async () => {
    const { resolvePostParseFigmaLinks } = jest.requireMock('../../common/utils/extract-figma-links');
    (resolvePostParseFigmaLinks as jest.Mock).mockResolvedValueOnce(['https://figma.com/x']);
    const { service } = await buildService();
    const tempDir = createManagedTempDir('plan-ui-key-order');
    const ticketPath = path.join(tempDir, 'ABC-2.md');
    fs.writeFileSync(ticketPath, '# ABC-2: Style the footer');

    await service.createPlanArtifact(
      { ticketKey: 'ABC-2', content: '# ABC-2: Style the footer', path: ticketPath },
      { action: 'fix', uiDesignScreenshots: ['/abs/footer.png'], figma: true }
    );

    const planFiles = fs.readdirSync(tempDir).filter(f => f.endsWith('-plan.json'));
    const savedPlan = JSON.parse(fs.readFileSync(path.join(tempDir, planFiles[0]), 'utf-8'));
    const keys = Object.keys(savedPlan);
    expect(keys.indexOf('figmaLinks')).toBeLessThan(keys.indexOf('uiDesignScreenshots'));
  });

  it('logs warnNoFigmaLinks with reason no-links-found when interactive session returns no links', async () => {
    const logFileWriter = require('../../common/logger/log-file-writer');
    const appendSpy = jest.spyOn(logFileWriter, 'appendToLogFile').mockImplementation(() => undefined);
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    const { service } = await buildService();
    const tempDir = createManagedTempDir('plan');
    const ticketPath = path.join(tempDir, 'WBP-700.md');
    fs.writeFileSync(ticketPath, '# WBP-700: Style the card');

    await service.createPlanArtifact(
      { ticketKey: 'WBP-700', content: '# WBP-700: Style the card', path: ticketPath },
      { action: 'fix', affectedRepositories: ['repo-a'], figma: true }
    );

    const line = appendSpy.mock.calls.map(call => String(call[1])).find(l => l.includes('No Figma frame links'));
    expect(line).toContain('no-links-found');
    expect(line).not.toContain('non-interactive-session');

    appendSpy.mockRestore();
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
  });

  it('logs warnNoFigmaLinks with reason non-interactive-session when session is non-TTY', async () => {
    const logFileWriter = require('../../common/logger/log-file-writer');
    const appendSpy = jest.spyOn(logFileWriter, 'appendToLogFile').mockImplementation(() => undefined);

    const { service } = await buildService();
    const tempDir = createManagedTempDir('plan');
    const ticketPath = path.join(tempDir, 'WBP-800.md');
    fs.writeFileSync(ticketPath, '# WBP-800: Style the nav');

    await service.createPlanArtifact(
      { ticketKey: 'WBP-800', content: '# WBP-800: Style the nav', path: ticketPath },
      { action: 'fix', affectedRepositories: ['repo-a'], figma: true }
    );

    const line = appendSpy.mock.calls.map(call => String(call[1])).find(l => l.includes('No Figma frame links'));
    expect(line).toContain('non-interactive-session');
    expect(line).not.toContain('no-links-found');

    appendSpy.mockRestore();
  });

  it('writes manifest with sourceKind custom when sourceKind option is custom', async () => {
    const { service } = await buildService();
    const tempDir = createManagedTempDir('plan');
    const ticketPath = path.join(tempDir, 'my-custom-plan.md');
    fs.writeFileSync(ticketPath, '# Custom plan content');
    jest.useFakeTimers().setSystemTime(new Date('2026-04-16T00:00:00.000Z'));

    const artifact = await service.createPlanArtifact(
      {
        ticketKey: 'my-custom-plan',
        content: '# Custom plan content',
        path: ticketPath,
      },
      {
        action: 'fix',
        affectedRepositories: ['repo-a'],
        sourceKind: 'custom',
      }
    );
    jest.useRealTimers();

    const manifestPath = buildPlanArtifactManifestPath(artifact.path);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.sourceKind).toBe('custom');
    expect(manifest.customArtifactName).toBe('my-custom-plan');
    expect(manifest.ticketKey).toBeUndefined();
  });

  describe('action mismatch handling', () => {
    const mockInquirer = require('inquirer').default as { prompt: jest.Mock };

    afterEach(() => {
      jest.restoreAllMocks();
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    });

    const setInteractiveSession = () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    };

    /**
     * Build a cached plan fixture where the file content's action differs from
     * the filename/manifest action. This simulates a hand-edited or mis-stamped plan.
     *
     * @param tempDir - Temp directory for the fixture
     * @param filenameAction - Action encoded in the filename and manifest (e.g., 'fix')
     * @param contentAction - Action stored inside the plan file content (e.g., 'investigate')
     * @param sourceName - Ticket key used as source identifier
     */
    const buildCachedPlan = (
      tempDir: string,
      filenameAction: string,
      contentAction: string,
      sourceName = 'WBP-MISMATCH'
    ) => {
      const hash = hashPlanArtifactSources([sourceName]);
      const createdAt = new Date('2026-04-16T00:00:00.000Z');
      const planFilename = buildPlanArtifactFilename({
        createdAt, hash, action: filenameAction as any, format: 'json',
      });
      const planPath = path.join(tempDir, planFilename);
      // File content has the contentAction (mismatch from filename)
      const plan = { ...mockPlan, action: contentAction };
      fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
      // Manifest records the filenameAction (what the resolution lookup will match)
      const manifest = buildPlanArtifactManifest({ artifactPath: planPath, action: filenameAction as any, format: 'json', hash: hash, sourceName: sourceName, sourceKind: 'ticket', createdAt: createdAt });
      writePlanArtifactManifest(manifest);
      return { planPath, plan, hash };
    };

    it('calls enrichPlanWithDirectoryConfigs after generating plan', async () => {
      const { service, stageAgentService } = await buildService(true);
      const tempDir = createManagedTempDir('enrichment');
      const ticketPath = path.join(tempDir, 'TEST-ENRICH.md');
      fs.writeFileSync(ticketPath, '# TEST-ENRICH: Test');

      await service.createPlanArtifact(
        { ticketKey: 'TEST-ENRICH', content: '# TEST-ENRICH: Test', path: ticketPath },
        { action: 'fix' }
      );

      expect(stageAgentService.enrichPlanWithDirectoryConfigs).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(String)
      );
    });

    it('createPlanArtifact returns cached plan without prompting when actions match', async () => {
      const { service } = await buildService();
      const tempDir = createManagedTempDir('mismatch');
      const ticketPath = path.join(tempDir, 'WBP-MISMATCH.md');
      fs.writeFileSync(ticketPath, '# WBP-MISMATCH: Test');
      // Filename='fix', content='fix' — no mismatch
      buildCachedPlan(tempDir, 'fix', 'fix');

      const artifact = await service.createPlanArtifact(
        { ticketKey: 'WBP-MISMATCH', content: '# WBP-MISMATCH: Test', path: ticketPath },
        { action: 'fix', skipExisting: true }
      );

      expect(artifact.fromCache).toBe(true);
      expect(artifact.action).toBe('fix');
      expect(mockInquirer.prompt).not.toHaveBeenCalled();
    });

    it('createPlanArtifact returns cached plan when user picks plan action on mismatch', async () => {
      const { service } = await buildService();
      const tempDir = createManagedTempDir('mismatch');
      const ticketPath = path.join(tempDir, 'WBP-MISMATCH.md');
      fs.writeFileSync(ticketPath, '# WBP-MISMATCH: Test');
      // Filename='fix', content='investigate' — mismatch when caller requests 'fix'
      buildCachedPlan(tempDir, 'fix', 'investigate');
      setInteractiveSession();
      mockInquirer.prompt.mockResolvedValue({ selectedAction: 'investigate' });

      const artifact = await service.createPlanArtifact(
        { ticketKey: 'WBP-MISMATCH', content: '# WBP-MISMATCH: Test', path: ticketPath },
        { action: 'fix', skipExisting: true }
      );

      expect(artifact.fromCache).toBe(true);
      expect(artifact.action).toBe('investigate');
      expect(artifact.plan.action).toBe('investigate');
    });

    it('createPlanArtifact falls through to regeneration when user picks requested action on mismatch', async () => {
      const { service } = await buildService();
      const tempDir = createManagedTempDir('mismatch');
      const ticketPath = path.join(tempDir, 'WBP-MISMATCH.md');
      fs.writeFileSync(ticketPath, '# WBP-MISMATCH: Test');
      buildCachedPlan(tempDir, 'fix', 'investigate');
      setInteractiveSession();
      mockInquirer.prompt.mockResolvedValue({ selectedAction: 'fix' });

      const artifact = await service.createPlanArtifact(
        { ticketKey: 'WBP-MISMATCH', content: '# WBP-MISMATCH: Test', path: ticketPath },
        { action: 'fix', skipExisting: true }
      );

      expect(artifact.fromCache).toBe(false);
      expect(artifact.action).toBe('fix');
    });

    it('createPlanArtifact throws ValidationError non-interactively when actions mismatch', async () => {
      const { service } = await buildService();
      const tempDir = createManagedTempDir('mismatch');
      const ticketPath = path.join(tempDir, 'WBP-MISMATCH.md');
      fs.writeFileSync(ticketPath, '# WBP-MISMATCH: Test');
      buildCachedPlan(tempDir, 'fix', 'investigate');

      await expect(
        service.createPlanArtifact(
          { ticketKey: 'WBP-MISMATCH', content: '# WBP-MISMATCH: Test', path: ticketPath },
          { action: 'fix', skipExisting: true }
        )
      ).rejects.toThrow(ValidationError);

      await expect(
        service.createPlanArtifact(
          { ticketKey: 'WBP-MISMATCH', content: '# WBP-MISMATCH: Test', path: ticketPath },
          { action: 'fix', skipExisting: true }
        )
      ).rejects.toThrow(/mismatch/i);
    });

    it('loadPlanArtifact prompts and returns cached plan when user picks plan action on mismatch', async () => {
      const { service } = await buildService();
      const tempDir = createManagedTempDir('mismatch');
      const ticketPath = path.join(tempDir, 'WBP-MISMATCH.md');
      fs.writeFileSync(ticketPath, '# WBP-MISMATCH: Test');
      buildCachedPlan(tempDir, 'fix', 'investigate');
      setInteractiveSession();
      mockInquirer.prompt.mockResolvedValue({ selectedAction: 'investigate' });

      const artifact = await service.loadPlanArtifact(ticketPath, 'fix');

      expect(artifact.fromCache).toBe(true);
      expect(artifact.action).toBe('investigate');
    });

    it('loadPlanArtifact throws ValidationError with --from plan guidance when user picks requested action', async () => {
      const { service } = await buildService();
      const tempDir = createManagedTempDir('mismatch');
      const ticketPath = path.join(tempDir, 'WBP-MISMATCH.md');
      fs.writeFileSync(ticketPath, '# WBP-MISMATCH: Test');
      buildCachedPlan(tempDir, 'fix', 'investigate');
      setInteractiveSession();
      mockInquirer.prompt.mockResolvedValue({ selectedAction: 'fix' });

      await expect(service.loadPlanArtifact(ticketPath, 'fix')).rejects.toThrow(ValidationError);
      await expect(service.loadPlanArtifact(ticketPath, 'fix')).rejects.toThrow(/--from plan/);
    });

    it('loadPlanArtifact throws ValidationError non-interactively when actions mismatch', async () => {
      const { service } = await buildService();
      const tempDir = createManagedTempDir('mismatch');
      const ticketPath = path.join(tempDir, 'WBP-MISMATCH.md');
      fs.writeFileSync(ticketPath, '# WBP-MISMATCH: Test');
      buildCachedPlan(tempDir, 'fix', 'investigate');

      await expect(service.loadPlanArtifact(ticketPath, 'fix')).rejects.toThrow(ValidationError);
      await expect(service.loadPlanArtifact(ticketPath, 'fix')).rejects.toThrow(/mismatch/i);
    });
  });

  describe('plan quality validation on disk-loaded plans', () => {
    const tempDirs: string[] = [];

    afterEach(() => {
      for (const dir of tempDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      tempDirs.length = 0;
      jest.restoreAllMocks();
    });

    const createTempDir = () => {
      const dir = createManagedTempDir('quality');
      tempDirs.push(dir);
      return dir;
    };

    it('createPlanArtifact downgrades violations to risks on cached plan with rename steps missing targets', async () => {
      const { service } = await buildService();
      const tempDir = createTempDir();
      const ticketPath = path.join(tempDir, 'WBP-QUALITY.md');
      fs.writeFileSync(ticketPath, '# WBP-QUALITY: Test');

      const hash = hashPlanArtifactSources(['WBP-QUALITY']);
      const createdAt = new Date('2026-04-16T00:00:00.000Z');
      const planFilename = buildPlanArtifactFilename({
        createdAt,
        hash,
        action: 'fix',
        format: 'json',
      });
      const planPath = path.join(tempDir, planFilename);
      const invalidPlan = {
        ...mockPlan,
        action: 'fix',
        steps: ['Rename AuthService in src/auth.ts'],
        affectedRepositories: ['repo-a'],
      };
      fs.writeFileSync(planPath, JSON.stringify(invalidPlan, null, 2));
      const manifest = buildPlanArtifactManifest({ artifactPath: planPath, action: 'fix', format: 'json', hash: hash, sourceName: 'WBP-QUALITY', sourceKind: 'ticket', createdAt: createdAt });
      writePlanArtifactManifest(manifest);

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const result = await service.createPlanArtifact(
        { ticketKey: 'WBP-QUALITY', content: '# WBP-QUALITY: Test', path: ticketPath },
        { action: 'fix', skipExisting: true }
      );

      expect(result.plan.risks).toEqual(expect.arrayContaining([expect.objectContaining({ description: expect.stringMatching(/\[plan-quality\].*rename-target-required/), severity: 'medium' })]));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('rename-target-required'));
    });

    it('createPlanArtifact downgrades violations to risks on cached plan with disallowed verification commands', async () => {
      const { service } = await buildService();
      const tempDir = createTempDir();
      const ticketPath = path.join(tempDir, 'WBP-QUALITY-2.md');
      fs.writeFileSync(ticketPath, '# WBP-QUALITY-2: Test');

      const hash = hashPlanArtifactSources(['WBP-QUALITY-2']);
      const createdAt = new Date('2026-04-16T00:00:00.000Z');
      const planFilename = buildPlanArtifactFilename({
        createdAt,
        hash,
        action: 'fix',
        format: 'json',
      });
      const planPath = path.join(tempDir, planFilename);
      const invalidPlan = {
        ...mockPlan,
        action: 'fix',
        verification: {
          targeted: [
            {
              id: 'disallowed-command',
              run: 'curl http://localhost:3000',
              policy: 'enforced' as const,
            },
          ],
        },
        affectedRepositories: ['repo-a'],
      };
      fs.writeFileSync(planPath, JSON.stringify(invalidPlan, null, 2));
      const manifest = buildPlanArtifactManifest({ artifactPath: planPath, action: 'fix', format: 'json', hash: hash, sourceName: 'WBP-QUALITY-2', sourceKind: 'ticket', createdAt: createdAt });
      writePlanArtifactManifest(manifest);

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const result = await service.createPlanArtifact(
        { ticketKey: 'WBP-QUALITY-2', content: '# WBP-QUALITY-2: Test', path: ticketPath },
        { action: 'fix', skipExisting: true }
      );

      expect(result.plan.risks).toEqual(expect.arrayContaining([expect.objectContaining({ description: expect.stringMatching(/\[plan-quality\].*verification-allowlist/), severity: 'medium' })]));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('verification-allowlist'));
    });

    it('loadPlanArtifact downgrades violations to risks on loaded plan with rename steps missing targets', async () => {
      const { service } = await buildService();
      const tempDir = createTempDir();
      const ticketPath = path.join(tempDir, 'WBP-QUALITY-3.md');
      fs.writeFileSync(ticketPath, '# WBP-QUALITY-3: Test');

      const hash = hashPlanArtifactSources(['WBP-QUALITY-3']);
      const createdAt = new Date('2026-04-16T00:00:00.000Z');
      const planFilename = buildPlanArtifactFilename({
        createdAt,
        hash,
        action: 'fix',
        format: 'json',
      });
      const planPath = path.join(tempDir, planFilename);
      const invalidPlan = {
        ...mockPlan,
        estimatedComplexity: 'low',
        risks: [],
        action: 'fix',
        steps: ['Rename AuthService in src/auth.ts'],
        affectedRepositories: ['repo-a'],
      };
      fs.writeFileSync(planPath, JSON.stringify(invalidPlan, null, 2));
      const manifest = buildPlanArtifactManifest({ artifactPath: planPath, action: 'fix', format: 'json', hash: hash, sourceName: 'WBP-QUALITY-3', sourceKind: 'ticket', createdAt: createdAt });
      writePlanArtifactManifest(manifest);

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const result = await service.loadPlanArtifact(ticketPath);

      expect(result.plan.risks).toEqual(expect.arrayContaining([expect.objectContaining({ description: expect.stringMatching(/\[plan-quality\].*rename-target-required/), severity: 'medium' })]));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('rename-target-required'));
      expect(result.plan.estimatedComplexity).toBe('low');
    });

    it('loadPlanArtifact downgrades violations to risks on loaded plan with disallowed verification commands', async () => {
      const { service } = await buildService();
      const tempDir = createTempDir();
      const ticketPath = path.join(tempDir, 'WBP-QUALITY-4.md');
      fs.writeFileSync(ticketPath, '# WBP-QUALITY-4: Test');

      const hash = hashPlanArtifactSources(['WBP-QUALITY-4']);
      const createdAt = new Date('2026-04-16T00:00:00.000Z');
      const planFilename = buildPlanArtifactFilename({
        createdAt,
        hash,
        action: 'fix',
        format: 'json',
      });
      const planPath = path.join(tempDir, planFilename);
      const invalidPlan = {
        ...mockPlan,
        action: 'fix',
        verification: {
          targeted: [
            {
              id: 'disallowed-command',
              run: 'curl http://localhost:3000',
              policy: 'enforced' as const,
            },
          ],
        },
        affectedRepositories: ['repo-a'],
      };
      fs.writeFileSync(planPath, JSON.stringify(invalidPlan, null, 2));
      const manifest = buildPlanArtifactManifest({ artifactPath: planPath, action: 'fix', format: 'json', hash: hash, sourceName: 'WBP-QUALITY-4', sourceKind: 'ticket', createdAt: createdAt });
      writePlanArtifactManifest(manifest);

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const result = await service.loadPlanArtifact(ticketPath);

      expect(result.plan.risks).toEqual(expect.arrayContaining([expect.objectContaining({ description: expect.stringMatching(/\[plan-quality\].*verification-allowlist/), severity: 'medium' })]));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('verification-allowlist'));
    });

    it('createPlanArtifact returns cached plan when quality checks pass', async () => {
      const { service } = await buildService();
      const tempDir = createTempDir();
      const ticketPath = path.join(tempDir, 'WBP-QUALITY-5.md');
      fs.writeFileSync(ticketPath, '# WBP-QUALITY-5: Test');

      const hash = hashPlanArtifactSources(['WBP-QUALITY-5']);
      const createdAt = new Date('2026-04-16T00:00:00.000Z');
      const planFilename = buildPlanArtifactFilename({
        createdAt,
        hash,
        action: 'fix',
        format: 'json',
      });
      const planPath = path.join(tempDir, planFilename);
      const validPlan = {
        ...mockPlan,
        action: 'fix',
        steps: ['Rename AuthService to AuthSessionService in src/auth.ts.'],
        verification: {
          targeted: [
            {
              id: 'test-script',
              run: 'yarn test',
              policy: 'enforced' as const,
            },
          ],
        },
        affectedRepositories: ['repo-a'],
      };
      fs.writeFileSync(planPath, JSON.stringify(validPlan, null, 2));
      const manifest = buildPlanArtifactManifest({ artifactPath: planPath, action: 'fix', format: 'json', hash: hash, sourceName: 'WBP-QUALITY-5', sourceKind: 'ticket', createdAt: createdAt });
      writePlanArtifactManifest(manifest);

      const artifact = await service.createPlanArtifact(
        { ticketKey: 'WBP-QUALITY-5', content: '# WBP-QUALITY-5: Test', path: ticketPath },
        { action: 'fix', skipExisting: true }
      );

      expect(artifact.fromCache).toBe(true);
      expect(artifact.plan.action).toBe('fix');
    });

    it('loadPlanArtifact returns loaded plan when quality checks pass', async () => {
      const { service } = await buildService();
      const tempDir = createTempDir();
      const ticketPath = path.join(tempDir, 'WBP-QUALITY-6.md');
      fs.writeFileSync(ticketPath, '# WBP-QUALITY-6: Test');

      const hash = hashPlanArtifactSources(['WBP-QUALITY-6']);
      const createdAt = new Date('2026-04-16T00:00:00.000Z');
      const planFilename = buildPlanArtifactFilename({
        createdAt,
        hash,
        action: 'fix',
        format: 'json',
      });
      const planPath = path.join(tempDir, planFilename);
      const validPlan = {
        ...mockPlan,
        action: 'fix',
        steps: ['Rename AuthService to AuthSessionService in src/auth.ts.'],
        verification: {
          targeted: [
            {
              id: 'test-script',
              run: 'yarn test',
              policy: 'enforced' as const,
            },
          ],
        },
        affectedRepositories: ['repo-a'],
      };
      fs.writeFileSync(planPath, JSON.stringify(validPlan, null, 2));
      const manifest = buildPlanArtifactManifest({ artifactPath: planPath, action: 'fix', format: 'json', hash: hash, sourceName: 'WBP-QUALITY-6', sourceKind: 'ticket', createdAt: createdAt });
      writePlanArtifactManifest(manifest);

      const artifact = await service.loadPlanArtifact(ticketPath);

      expect(artifact.fromCache).toBe(true);
      expect(artifact.plan.action).toBe('fix');
    });

    it('calls detectTestInfra with the provided repoDir instead of the artifact directory', async () => {
      const { service } = await buildService();
      const tempDir = createTempDir();
      const repoDir = createTempDir();
      const ticketPath = path.join(tempDir, 'WBP-QUALITY-CWD.md');
      fs.writeFileSync(ticketPath, '# WBP-QUALITY-CWD: Test');

      const hash = hashPlanArtifactSources(['WBP-QUALITY-CWD']);
      const createdAt = new Date('2026-04-16T00:00:00.000Z');
      const planFilename = buildPlanArtifactFilename({
        createdAt, hash, action: 'fix', format: 'json',
      });
      const planPath = path.join(tempDir, planFilename);
      fs.writeFileSync(planPath, JSON.stringify({ ...mockPlan, action: 'fix' }, null, 2));
      const manifest = buildPlanArtifactManifest({ artifactPath: planPath, action: 'fix', format: 'json', hash: hash, sourceName: 'WBP-QUALITY-CWD', sourceKind: 'ticket', createdAt: createdAt });
      writePlanArtifactManifest(manifest);

      jest.spyOn(console, 'log').mockImplementation();
      await service.loadPlanArtifact(ticketPath, undefined, repoDir);

      expect(mockDetectTestInfra).toHaveBeenCalledWith(repoDir);
    });

    it('falls back to process.cwd() when repoDir is omitted', async () => {
      const { service } = await buildService();
      const tempDir = createTempDir();
      const ticketPath = path.join(tempDir, 'WBP-QUALITY-FALLBACK.md');
      fs.writeFileSync(ticketPath, '# WBP-QUALITY-FALLBACK: Test');

      const hash = hashPlanArtifactSources(['WBP-QUALITY-FALLBACK']);
      const createdAt = new Date('2026-04-16T00:00:00.000Z');
      const planFilename = buildPlanArtifactFilename({
        createdAt, hash, action: 'fix', format: 'json',
      });
      const planPath = path.join(tempDir, planFilename);
      fs.writeFileSync(planPath, JSON.stringify({ ...mockPlan, action: 'fix' }, null, 2));
      const manifest = buildPlanArtifactManifest({ artifactPath: planPath, action: 'fix', format: 'json', hash: hash, sourceName: 'WBP-QUALITY-FALLBACK', sourceKind: 'ticket', createdAt: createdAt });
      writePlanArtifactManifest(manifest);

      jest.spyOn(console, 'log').mockImplementation();
      await service.loadPlanArtifact(ticketPath);

      expect(mockDetectTestInfra).toHaveBeenCalledWith(process.cwd());
    });

    it('throws ValidationError when repoDir does not exist on disk', async () => {
      const { service } = await buildService();
      const tempDir = createTempDir();
      const ticketPath = path.join(tempDir, 'WBP-QUALITY-BAD.md');
      fs.writeFileSync(ticketPath, '# WBP-QUALITY-BAD: Test');

      const hash = hashPlanArtifactSources(['WBP-QUALITY-BAD']);
      const createdAt = new Date('2026-04-16T00:00:00.000Z');
      const planFilename = buildPlanArtifactFilename({
        createdAt, hash, action: 'fix', format: 'json',
      });
      const planPath = path.join(tempDir, planFilename);
      fs.writeFileSync(planPath, JSON.stringify({ ...mockPlan, action: 'fix' }, null, 2));
      const manifest = buildPlanArtifactManifest({ artifactPath: planPath, action: 'fix', format: 'json', hash: hash, sourceName: 'WBP-QUALITY-BAD', sourceKind: 'ticket', createdAt: createdAt });
      writePlanArtifactManifest(manifest);

      const bogusDir = path.join(os.tmpdir(), 'wf-nonexistent-' + Date.now());
      await expect(service.loadPlanArtifact(ticketPath, undefined, bogusDir))
        .rejects.toThrow(ValidationError);
      await expect(service.loadPlanArtifact(ticketPath, undefined, bogusDir))
        .rejects.toThrow(/not a valid directory/);
    });
  });

  describe('skill integration', () => {
    let savedSkills: Map<string, import('../../skills/skill.types').SkillDefinition>;

    beforeEach(() => {
      savedSkills = new Map(knownSkills);
      knownSkills.clear();
    });

    afterEach(() => {
      knownSkills.clear();
      for (const [k, v] of savedSkills) knownSkills.set(k, v);
    });

    it('passes skillNames in context when plan skills are configured', async () => {
      registerSkill({ id: 'test-driven-development', stages: ['plan', 'implement'] });
      registerSkill({ id: 'writing-plans', stages: ['plan'] });
      const module = await Test.createTestingModule({
        providers: [
          PlanStageService,
          {
            provide: AiService,
            useValue: { generatePlan: jest.fn().mockResolvedValue(mockPlan) },
          },
          {
            provide: StageAgentService,
            useValue: {
              isEnabledForStage: jest.fn().mockReturnValue(false),
              generatePlan: jest.fn(),
            },
          },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string) => {
                if (key === 'stages.plan.skills') return ['test-driven-development', 'writing-plans'];
                return undefined;
              }),
            },
          },
        ],
      }).compile();

      const service = module.get(PlanStageService);
      const aiService = module.get(AiService);

      await service.generatePlan('# WBP-SKILL: Test', { action: 'fix' });

      expect(aiService.generatePlan).toHaveBeenCalledWith(
        'fix',
        '# WBP-SKILL: Test',
        expect.objectContaining({
          skillNames: ['test-driven-development', 'writing-plans'],
        })
      );
    });

    it('throws ConfigurationError when a plan skill does not support the plan stage', async () => {
      registerSkill({ id: 'frontend-design-nuxt', stages: ['implement'] });
      const module = await Test.createTestingModule({
        providers: [
          PlanStageService,
          {
            provide: AiService,
            useValue: { generatePlan: jest.fn() },
          },
          {
            provide: StageAgentService,
            useValue: { isEnabledForStage: jest.fn().mockReturnValue(false), generatePlan: jest.fn() },
          },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string) => {
                if (key === 'stages.plan.skills') return ['frontend-design-nuxt'];
                return undefined;
              }),
            },
          },
        ],
      }).compile();

      const service = module.get(PlanStageService);
      await expect(service.generatePlan('body', { action: 'fix' }))
        .rejects.toThrow('does not support the "plan" stage');
    });

    it('omits skillNames from context when no skills are configured', async () => {
      const { service, aiService } = await buildService();
      await service.generatePlan('# WBP-EMPTY: Test', { action: 'fix' });

      expect(aiService.generatePlan).toHaveBeenCalledWith(
        'fix',
        '# WBP-EMPTY: Test',
        expect.objectContaining({ skillNames: undefined })
      );
    });
  });

  describe('tryReuseCachedPlan', () => {
    it('falls through to generation when no cached plan exists', async () => {
      const { service } = await buildService();
      const tempDir = createManagedTempDir('notfound');
      const ticketPath = path.join(tempDir, 'WBP-NOTFOUND.md');
      fs.writeFileSync(ticketPath, '# WBP-NOTFOUND: Test');

      const artifact = await service.createPlanArtifact(
        { ticketKey: 'WBP-NOTFOUND', content: '# WBP-NOTFOUND: Test', path: ticketPath },
        { action: 'fix', skipExisting: true }
      );

      expect(artifact.fromCache).toBe(false);
    });

    it('rethrows ValidationError when multiple cached plan artifacts are found', async () => {
      const { service } = await buildService();
      const tempDir = createManagedTempDir('multi');
      const ticketPath = path.join(tempDir, 'WBP-MULTI.md');
      fs.writeFileSync(ticketPath, '# WBP-MULTI: Test');
      const hash = hashPlanArtifactSources(['WBP-MULTI']);
      for (const date of ['2026-01-01', '2026-02-01']) {
        const planFilename = buildPlanArtifactFilename({
          createdAt: new Date(`${date}T00:00:00.000Z`), hash, action: 'fix', format: 'json',
        });
        const planPath = path.join(tempDir, planFilename);
        fs.writeFileSync(planPath, JSON.stringify({ ...mockPlan }));
        const manifest = buildPlanArtifactManifest({ artifactPath: planPath, action: 'fix', format: 'json', hash: hash, sourceName: 'WBP-MULTI', sourceKind: 'ticket', createdAt: new Date(`${date}T00:00:00.000Z`) });
        writePlanArtifactManifest(manifest);
      }

      await expect(
        service.createPlanArtifact(
          { ticketKey: 'WBP-MULTI', content: '# WBP-MULTI: Test', path: ticketPath },
          { action: 'fix', skipExisting: true }
        )
      ).rejects.toThrow(ValidationError);

      await expect(
        service.createPlanArtifact(
          { ticketKey: 'WBP-MULTI', content: '# WBP-MULTI: Test', path: ticketPath },
          { action: 'fix', skipExisting: true }
        )
      ).rejects.toThrow(/Multiple plan artifacts/i);
    });

    it('rethrows ValidationError for a non-canonical (short-hash) identifier', async () => {
      const { service } = await buildService();
      const tempDir = createManagedTempDir('noncanon');
      const ticketPath = path.join(tempDir, 'abcdef01-fix-plan.md');
      fs.writeFileSync(ticketPath, '# abcdef01-fix-plan: Test');

      const rejection = service.createPlanArtifact(
        { ticketKey: 'abcdef01-fix-plan', content: '# abcdef01-fix-plan: Test', path: ticketPath },
        { action: 'fix', skipExisting: true }
      );

      await expect(rejection).rejects.toThrow(ValidationError);
      await expect(rejection).rejects.not.toThrow(PlanArtifactNotFoundError);
      await expect(rejection).rejects.toThrow(/Non-canonical/i);
    });

    it('PlanArtifactNotFoundError is a subtype of ValidationError', () => {
      expect(new PlanArtifactNotFoundError('test')).toBeInstanceOf(ValidationError);
    });
  });

  describe('enrichPlanWithDirectoryConfigs', () => {
    it('delegates to stageAgentService.enrichPlanWithDirectoryConfigs', async () => {
      const { service, stageAgentService } = await buildService();
      const plan = { summary: 'test', steps: [], estimatedComplexity: 'low', affectedRepositories: ['wf'] } as any;

      service.enrichPlanWithDirectoryConfigs(plan, '/repos/wf');

      expect(stageAgentService.enrichPlanWithDirectoryConfigs).toHaveBeenCalledWith(plan, '/repos/wf');
    });
  });
});
