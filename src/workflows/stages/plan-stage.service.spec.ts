import { Test } from '@nestjs/testing';
import { AiService } from '../../integrations/ai/ai.service';
import { PlanStageService } from './plan-stage.service';
import { StageAgentService } from '../../integrations/ai/stage-agent.service';
import { buildPlanArtifactManifestPath, hashPlanArtifactSources } from '../../shared/utils/plan-artifact';
import { AIError } from '../../shared/utils/errors';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('PlanStageService', () => {
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
    risks: ['Regression in login flow'],
  };

  const buildService = async (agentEnabled: boolean = false) => {
    const module = await Test.createTestingModule({
      providers: [
        PlanStageService,
        {
          provide: AiService,
          useValue: {
            generatePlan: jest.fn().mockResolvedValue(mockPlan),
          },
        },
        {
          provide: StageAgentService,
          useValue: {
            isEnabledForStage: jest.fn().mockReturnValue(agentEnabled),
            generatePlan: jest.fn().mockResolvedValue(mockPlan),
          },
        },
      ],
    }).compile();

    return {
      service: module.get(PlanStageService),
      aiService: module.get(AiService),
      stageAgentService: module.get(StageAgentService),
    };
  };

  afterEach(() => {
    jest.restoreAllMocks();
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
        testInfra: expect.objectContaining({ primary: expect.any(String) }),
      })
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
        testInfra: expect.objectContaining({ primary: expect.any(String) }),
      })
    );
    expect(aiService.generatePlan).not.toHaveBeenCalled();
  });

  it('passes conventions and prior tickets through to AI service', async () => {
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
    };
    const mockPriorTickets = { tickets: [], repoName: 'test-repo' };

    await service.generatePlan('Ticket body', {
      action: 'fix',
      conventions: mockConventions as any,
      priorTickets: mockPriorTickets,
    });

    expect(aiService.generatePlan).toHaveBeenCalledWith(
      'fix',
      'Ticket body',
      expect.objectContaining({
        conventions: mockConventions,
        priorTickets: mockPriorTickets,
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

  it('falls back to standard completion when agent returns prose instead of JSON', async () => {
    const { service, aiService, stageAgentService } = await buildService(true);
    const proseError = new AIError('Failed to parse resolution plan from agent response', {
      response: 'Here is my analysis of the codebase. The auth module needs updating...',
    });
    (stageAgentService.generatePlan as jest.Mock).mockRejectedValueOnce(proseError);

    const result = await service.generatePlan('Ticket body', {
      action: 'fix',
      ticketKey: 'WBP-400',
      affectedRepositories: ['repo-a'],
    });

    expect(result).toEqual(mockPlan);
    expect(aiService.generatePlan).toHaveBeenCalledWith(
      'fix',
      'Ticket body',
      expect.objectContaining({
        agentAnalysis: 'Here is my analysis of the codebase. The auth module needs updating...',
      })
    );
  });

  it('re-throws non-parsing AIErrors without falling back', async () => {
    const { service, aiService, stageAgentService } = await buildService(true);
    const rateLimitError = new AIError('Rate limit exceeded', { status: 429 });
    (stageAgentService.generatePlan as jest.Mock).mockRejectedValueOnce(rateLimitError);

    await expect(service.generatePlan('Ticket body', { action: 'fix', ticketKey: 'WBP-401' })).rejects.toThrow(
      'Rate limit exceeded'
    );

    expect(aiService.generatePlan).not.toHaveBeenCalled();
  });

  it('falls back to structured completion when agent prose response is empty', async () => {
    const { service, aiService, stageAgentService } = await buildService(true);
    const emptyProseError = new AIError('Failed to parse resolution plan from agent response', {
      response: '',
    });
    (stageAgentService.generatePlan as jest.Mock).mockRejectedValueOnce(emptyProseError);

    const result = await service.generatePlan('Ticket body', { action: 'fix', ticketKey: 'WBP-402' });

    expect(aiService.generatePlan).toHaveBeenCalled();
    expect(result).toMatchObject({ action: 'fix', summary: expect.any(String) });
  });

  it('throws when fallback result is structurally invalid', async () => {
    const { service, aiService, stageAgentService } = await buildService(true);
    const proseError = new AIError('Failed to parse resolution plan from agent response', {
      response: 'Some analysis prose...',
    });
    (stageAgentService.generatePlan as jest.Mock).mockRejectedValueOnce(proseError);
    (aiService.generatePlan as jest.Mock).mockResolvedValueOnce({ summary: 'incomplete' });

    await expect(service.generatePlan('Ticket body', { action: 'fix', ticketKey: 'WBP-403' })).rejects.toThrow(
      'Fallback completion did not produce a valid resolution plan'
    );
  });

  it('persists a JSON plan artifact and returns cache metadata', async () => {
    const { service } = await buildService();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-plan-'));
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
});
