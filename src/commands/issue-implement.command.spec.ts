// Mock chalk before any imports
jest.mock('chalk', () => {
  const identity = (s: any) => s;
  const makeChain = () => {
    const chain: any = identity;
    [
      'bold', 'dim', 'italic', 'underline', 'inverse', 'strikethrough',
      'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan',
      'white', 'gray', 'grey',
    ].forEach((name) => { chain[name] = identity; });
    return chain;
  };
  const chalk = makeChain();
  chalk.bold = makeChain();
  return { default: chalk, ...chalk };
});

import { Test } from '@nestjs/testing';
import { IssueImplementCommand } from './issue-implement.command';
import { ClaudeService } from '../integrations/ai/claude.service';
import { PlatformService } from '../integrations/platforms/platform.service';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { AgentOrchestrator } from '../agents/agent-orchestrator.service';

async function buildCommand(): Promise<IssueImplementCommand> {
  const module = await Test.createTestingModule({
    providers: [
      IssueImplementCommand,
      { provide: ClaudeService, useValue: {} },
      { provide: PlatformService, useValue: {} },
      {
        provide: ConfigService,
        useValue: { get: jest.fn().mockReturnValue('jira') },
      },
      {
        provide: LoggerService,
        useValue: {
          info: jest.fn(),
          warn: jest.fn(),
          error: jest.fn(),
          success: jest.fn(),
        },
      },
      {
        provide: DryRunPreviewService,
        useValue: {
          showHeader: jest.fn(),
          showSummary: jest.fn(),
          showValidationResult: jest.fn(),
          previewApiCall: jest.fn(),
          previewFileRead: jest.fn(),
          previewFileWrite: jest.fn(),
        },
      },
      {
        provide: AgentOrchestrator,
        useValue: {
          implementer: { execute: jest.fn() },
          planner: { execute: jest.fn() },
        },
      },
    ],
  }).compile();
  return module.get(IssueImplementCommand);
}

describe('IssueImplementCommand', () => {
  describe('option metadata', () => {
    it('does not expose a --force-recreate option', () => {
      const proto = IssueImplementCommand.prototype as any;
      expect(proto.parseForceRecreate).toBeUndefined();
    });
  });
});
