import { Test } from '@nestjs/testing';
import { AiService } from '../../integrations/ai/ai.service';
import { PlanStageService } from './plan-stage.service';
import { StageAgentService } from '../../integrations/ai/stage-agent.service';
import {
  buildPlanArtifactManifestPath,
  hashPlanArtifactSources,
} from '../../shared/utils/plan-artifact';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('PlanStageService', () => {
  const mockPlan = {
    action: 'fix',
    summary: 'Update auth redirect handling',
    estimatedComplexity: 'medium',
    steps: ['Inspect redirect logic', 'Adjust callback handling'],
    filesAffected: ['src/auth/callback.ts'],
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

    await service.generatePlan(
      '# WBP-123: Fix auth redirect\n\n## Description\n\nRestore callback flow\n',
      {
        action: 'fix',
        ticketKey: 'WBP-123',
        affectedRepositories: ['repo-a', 'repo-b'],
      },
    );

    expect(aiService.generatePlan).toHaveBeenCalledWith(
      'fix',
      expect.stringContaining('Restore callback flow'),
      {
        ticketKey: 'WBP-123',
        summary: 'Fix auth redirect',
        affectedRepositories: ['repo-a', 'repo-b'],
      },
    );
  });

  it('uses the stage agent service when plan agent mode is enabled', async () => {
    const { service, aiService, stageAgentService } = await buildService(true);

    await service.generatePlan('Ticket body', {
      action: 'fix',
      ticketKey: 'WBP-321',
      affectedRepositories: ['repo-a'],
    });

    expect(stageAgentService.generatePlan).toHaveBeenCalledWith({
      action: 'fix',
      issueContent: 'Ticket body',
      ticketKey: 'WBP-321',
      affectedRepositories: ['repo-a'],
    });
    expect(aiService.generatePlan).not.toHaveBeenCalled();
  });

  it('persists a JSON plan artifact and returns cache metadata', async () => {
    const { service } = await buildService();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-plan-'));
    const ticketPath = path.join(tempDir, 'WBP-123.md');
    const planPath = path.join(
      tempDir,
      `2026-04-16-${hashPlanArtifactSources(['WBP-123'])}-fix-plan.json`,
    );
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
      },
    );
    jest.useRealTimers();

    expect(fs.readFileSync(planPath, 'utf-8')).toBe(
      JSON.stringify(mockPlan, null, 2),
    );
    expect(fs.existsSync(buildPlanArtifactManifestPath(planPath))).toBe(true);
    expect(artifact).toEqual({
      plan: mockPlan,
      action: 'fix',
      path: planPath,
      fromCache: false,
    });
  });
});
