import { Test } from '@nestjs/testing';
import { PlannerAgent } from './planner.agent';
import { CliPresenter } from '../shared/presentation/cli-presenter.service';
import { PlanStageService } from '../workflows/stages/plan-stage.service';

describe('PlannerAgent', () => {
  afterEach(() => jest.restoreAllMocks());

  it('delegates plan artifact creation to PlanStageService', async () => {
    const module = await Test.createTestingModule({
      providers: [
        PlannerAgent,
        {
          provide: CliPresenter,
          useValue: {
            stageHeader: jest.fn(),
            separator: jest.fn(),
            progress: jest.fn(),
            outcome: jest.fn(),
            detail: jest.fn(),
            summaryBlock: jest.fn(),
          },
        },
        {
          provide: PlanStageService,
          useValue: {
            createPlanArtifact: jest.fn().mockResolvedValue({
              plan: {
                action: 'fix',
                summary: 'Fix login',
                estimatedComplexity: 'medium',
                steps: ['Inspect auth'],
                affectedFiles: ['src/auth.ts'],
              },
              action: 'fix',
              path: '/tmp/.wf/repo/jira/WBP-123-plan-fix.json',
              fromCache: false,
            }),
            loadPlanArtifact: jest.fn(),
          },
        },
      ],
    }).compile();

    const agent = module.get(PlannerAgent);
    const planStageService = module.get(PlanStageService);

    await agent.execute(
      {
        ticketKey: 'WBP-123',
        content: '# WBP-123: Fix login',
        path: '/tmp/.wf/repo/jira/WBP-123.md',
      },
      {
        action: 'fix',
        affectedRepositories: ['repo-a'],
      }
    );

    expect(planStageService.createPlanArtifact).toHaveBeenCalledWith(
      {
        ticketKey: 'WBP-123',
        content: '# WBP-123: Fix login',
        path: '/tmp/.wf/repo/jira/WBP-123.md',
      },
      expect.objectContaining({
        action: 'fix',
        affectedRepositories: ['repo-a'],
        onProgress: expect.any(Function),
      })
    );
  });

  it('passes undefined onProgress when silent mode is active', async () => {
    const module = await Test.createTestingModule({
      providers: [
        PlannerAgent,
        {
          provide: CliPresenter,
          useValue: {
            stageHeader: jest.fn(),
            separator: jest.fn(),
            progress: jest.fn(),
            outcome: jest.fn(),
            detail: jest.fn(),
            summaryBlock: jest.fn(),
          },
        },
        {
          provide: PlanStageService,
          useValue: {
            createPlanArtifact: jest.fn().mockResolvedValue({
              plan: {
                action: 'fix',
                summary: 'Fix login',
                estimatedComplexity: 'medium',
                steps: ['Inspect auth'],
                affectedFiles: ['src/auth.ts'],
              },
              action: 'fix',
              path: '/tmp/.wf/repo/jira/WBP-123-plan-fix.json',
              fromCache: false,
            }),
            loadPlanArtifact: jest.fn(),
          },
        },
      ],
    }).compile();

    const agent = module.get(PlannerAgent);
    const planStageService = module.get(PlanStageService);

    await agent.execute(
      {
        ticketKey: 'WBP-123',
        content: '# WBP-123: Fix login',
        path: '/tmp/.wf/repo/jira/WBP-123.md',
      },
      {
        action: 'fix',
        affectedRepositories: ['repo-a'],
        silent: true,
      }
    );

    expect(planStageService.createPlanArtifact).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        onProgress: undefined,
      })
    );
  });
});
