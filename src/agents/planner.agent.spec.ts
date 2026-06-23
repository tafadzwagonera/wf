import { Test } from '@nestjs/testing';
import { PlannerAgent } from './planner.agent';
import { PlanStageService } from '../workflows/stages/plan-stage.service';

describe('PlannerAgent', () => {
  it('delegates plan artifact creation to PlanStageService', async () => {
    const module = await Test.createTestingModule({
      providers: [
        PlannerAgent,
        {
          provide: PlanStageService,
          useValue: {
            createPlanArtifact: jest.fn().mockResolvedValue({
              plan: {
                action: 'fix',
                summary: 'Fix login',
                estimatedComplexity: 'medium',
                steps: ['Inspect auth'],
                filesAffected: ['src/auth.ts'],
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
      {
        action: 'fix',
        affectedRepositories: ['repo-a'],
      }
    );
  });
});
