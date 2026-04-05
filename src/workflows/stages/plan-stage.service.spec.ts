import { Test } from '@nestjs/testing';
import { AiService } from '../../integrations/ai/ai.service';
import { PlanStageService } from './plan-stage.service';
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
          run: 'npm run test:manual -- test-auth-redirect',
          policy: 'enforced',
          reason: 'Covers redirect callback flow',
        },
      ],
    },
    risks: ['Regression in login flow'],
  };

  const buildService = async () => {
    const module = await Test.createTestingModule({
      providers: [
        PlanStageService,
        {
          provide: AiService,
          useValue: {
            generatePlan: jest.fn().mockResolvedValue(mockPlan),
          },
        },
      ],
    }).compile();

    return {
      service: module.get(PlanStageService),
      aiService: module.get(AiService),
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

  it('persists a JSON plan artifact and returns cache metadata', async () => {
    const { service } = await buildService();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-plan-'));
    const ticketPath = path.join(tempDir, 'WBP-123.md');
    fs.writeFileSync(ticketPath, '# WBP-123: Fix auth redirect');

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

    expect(
      fs.readFileSync(path.join(tempDir, 'WBP-123-plan-fix.json'), 'utf-8'),
    ).toBe(JSON.stringify(mockPlan, null, 2));
    expect(artifact).toEqual({
      plan: mockPlan,
      action: 'fix',
      path: path.join(tempDir, 'WBP-123-plan-fix.json'),
      fromCache: false,
    });
  });
});
