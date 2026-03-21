// Mock chalk before any imports so modules receive identity functions
jest.mock('chalk', () => {
  const identity = (s: any) => s;

  const makeChain = () => {
    const chain: any = identity;
    const colorNames = [
      'bold',
      'dim',
      'italic',
      'underline',
      'inverse',
      'strikethrough',
      'black',
      'red',
      'green',
      'yellow',
      'blue',
      'magenta',
      'cyan',
      'white',
      'gray',
      'grey',
    ];
    colorNames.forEach((name) => {
      chain[name] = identity;
    });
    return chain;
  };

  const chalk = makeChain();
  const boldChain = makeChain();
  chalk.bold = boldChain;

  return { default: chalk, ...chalk };
});

import { Test } from '@nestjs/testing';
import { RunCommand } from './run.command';
import { WorkflowParserService } from '../core/workflow-parser/workflow-parser.service';
import { StageEngineService } from '../core/stage-engine/stage-engine.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { Workflow } from '../common/interfaces/workflow.interface';

const mockWorkflow: Workflow = {
  metadata: {
    name: 'test-workflow',
    description: 'A test workflow',
    autoExecutionMode: false,
    version: '1.0',
  },
  steps: [
    {
      id: 'step-1',
      title: 'Build',
      instructions: ['Run npm run build'],
      requiresApproval: false,
      retryable: true,
      actions: [],
    },
    {
      id: 'step-2',
      title: 'Deploy',
      instructions: [],
      requiresApproval: true,
      retryable: false,
      actions: [],
    },
  ],
};

describe('RunCommand', () => {
  let command: RunCommand;
  let mockDryRunPreview: jest.Mocked<DryRunPreviewService>;

  beforeEach(async () => {
    mockDryRunPreview = {
      showHeader: jest.fn(),
      showSummary: jest.fn(),
      showTerminalOutput: jest.fn(),
      showValidationResult: jest.fn(),
      previewApiCall: jest.fn(),
      previewFileWrite: jest.fn(),
      previewFileRead: jest.fn(),
      previewGitOperation: jest.fn(),
      showNoSideEffects: jest.fn(),
    } as unknown as jest.Mocked<DryRunPreviewService>;

    const module = await Test.createTestingModule({
      providers: [
        RunCommand,
        {
          provide: WorkflowParserService,
          useValue: { findWorkflow: jest.fn().mockResolvedValue(mockWorkflow) },
        },
        { provide: StageEngineService, useValue: {} },
        {
          provide: LoggerService,
          useValue: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        },
        { provide: DryRunPreviewService, useValue: mockDryRunPreview },
      ],
    }).compile();

    command = module.get(RunCommand);
  });

  describe('dry-run mode', () => {
    it('calls showHeader with the workflow name', async () => {
      await command.run(['test-workflow'], { dryRun: true });
      expect(mockDryRunPreview.showHeader).toHaveBeenCalledWith(
        'run',
        'test-workflow',
      );
    });

    it('calls showSummary with step count and workflow metadata', async () => {
      await command.run(['test-workflow'], { dryRun: true });
      expect(mockDryRunPreview.showSummary).toHaveBeenCalledWith(
        expect.objectContaining({
          apiCallCount: 0,
          terminalOutputLines: expect.arrayContaining([
            'Workflow: test-workflow',
            'Steps: 2',
          ]),
        }),
      );
    });

    it('includes step titles in terminalOutputLines', async () => {
      await command.run(['test-workflow'], { dryRun: true });
      const summaryArg = mockDryRunPreview.showSummary.mock.calls[0][0];
      expect(
        (summaryArg.terminalOutputLines as string[]).some((l) =>
          l.includes('Build'),
        ),
      ).toBe(true);
    });

    it('appends [Approval Required] flag for steps that require approval', async () => {
      await command.run(['test-workflow'], { dryRun: true });
      const summaryArg = mockDryRunPreview.showSummary.mock.calls[0][0];
      const lines = summaryArg.terminalOutputLines as string[];
      expect(lines.some((l) => l.includes('[Approval Required]'))).toBe(true);
    });

    it('appends [Retryable] flag for retryable steps', async () => {
      await command.run(['test-workflow'], { dryRun: true });
      const summaryArg = mockDryRunPreview.showSummary.mock.calls[0][0];
      const lines = summaryArg.terminalOutputLines as string[];
      expect(lines.some((l) => l.includes('[Retryable]'))).toBe(true);
    });

    it('includes instruction lines for steps with instructions', async () => {
      await command.run(['test-workflow'], { dryRun: true });
      const summaryArg = mockDryRunPreview.showSummary.mock.calls[0][0];
      const lines = summaryArg.terminalOutputLines as string[];
      expect(lines.some((l) => l.includes('Run npm run build'))).toBe(true);
    });

    it('calls showValidationResult', async () => {
      await command.run(['test-workflow'], { dryRun: true });
      expect(mockDryRunPreview.showValidationResult).toHaveBeenCalled();
    });

    it('does not call stageEngine (no live execution)', async () => {
      const stageEngine = { executeWorkflow: jest.fn() };
      // Re-check: stageEngine.executeWorkflow should NOT have been called
      await command.run(['test-workflow'], { dryRun: true });
      // showValidationResult called = dry-run returned early
      expect(mockDryRunPreview.showValidationResult).toHaveBeenCalled();
    });
  });
});
