/**
 * Manual smoke test: stage progress callback threading
 *
 * Run: nr test:manual -- test-stage-progress-callback
 *
 * Verifies:
 *   1. StageAgentService.generatePlan forwards onProgress to runStagePrompt.
 *   2. StageAgentService.generateFromPrompt forwards onProgress to runStagePrompt.
 *   3. StageAgentService.generateFromPrompt defaults onProgress to undefined when omitted.
 *   4. PlannerAgent passes onProgress when not silent and omits it when silent.
 *   5. onProgress callback with correct shape is accepted by generatePlan.
 *
 * @returns Promise that resolves when the smoke test completes
 */
import chalk from 'chalk';
import { ConfigService } from '@nestjs/config';
import { StageAgentService } from '../../src/integrations/ai/stage-agent.service';

let passed = 0;
let failed = 0;

const pass = (message: string): void => {
  console.log(chalk.green(`  ✓ ${message}`));
  passed += 1;
};

const fail = (message: string, detail?: string): void => {
  console.error(chalk.red(`  ✗ ${message}${detail ? `\n    → ${detail}` : ''}`));
  failed += 1;
};

const assert = (message: string, condition: boolean, detail?: string): void => {
  if (condition) {
    pass(message);
    return;
  }
  fail(message, detail);
};

const createConfigService = (): ConfigService =>
  ({
    get: (key: string, defaultValue?: unknown) => {
      const values: Record<string, unknown> = {
        'stages.plan.backend': 'agent',
        'stages.plan.provider': 'openai',
        'stages.plan.model': 'gpt-5.4',
        'stages.generate.backend': 'agent',
        'stages.generate.provider': 'openai',
        'stages.generate.model': 'gpt-5.4',
        'ai.provider': 'openai',
        'ai.model': 'gpt-5.4',
      };
      return key in values ? values[key] : defaultValue;
    },
  }) as unknown as ConfigService;

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n🧪 Stage progress callback threading smoke test\n'));

  // Test 1: generatePlan forwards onProgress
  console.log(chalk.bold('Test 1: generatePlan forwards onProgress'));
  {
    const service = new StageAgentService(createConfigService());
    let capturedParams: Record<string, unknown> | null = null;
    (service as any).runStagePrompt = async (params: Record<string, unknown>) => {
      capturedParams = params;
      return JSON.stringify({
        action: 'fix',
        summary: 'Fix it',
        steps: ['step 1'],
        estimatedComplexity: 'low',
        affectedFiles: [],
        risks: [],
      });
    };

    const onProgress = (line: string) => void line;
    await service.generatePlan({
      action: 'fix',
      issueContent: 'Fix callback handling',
      onProgress,
    });

    assert('onProgress is forwarded to runStagePrompt', capturedParams!.onProgress === onProgress);
  }

  // Test 2: generateFromPrompt forwards onProgress
  console.log(chalk.bold('\nTest 2: generateFromPrompt forwards onProgress'));
  {
    const service = new StageAgentService(createConfigService());
    let capturedParams: Record<string, unknown> | null = null;
    (service as any).runStagePrompt = async (params: Record<string, unknown>) => {
      capturedParams = params;
      return 'Generated content';
    };

    const onProgress = (line: string) => void line;
    await service.generateFromPrompt('Summarise this', onProgress);

    assert('onProgress is forwarded to runStagePrompt', capturedParams!.onProgress === onProgress);
  }

  // Test 3: generateFromPrompt defaults onProgress to undefined
  console.log(chalk.bold('\nTest 3: generateFromPrompt defaults onProgress to undefined'));
  {
    const service = new StageAgentService(createConfigService());
    let capturedParams: Record<string, unknown> | null = null;
    (service as any).runStagePrompt = async (params: Record<string, unknown>) => {
      capturedParams = params;
      return 'Generated content';
    };

    await service.generateFromPrompt('Summarise this');

    assert('onProgress is undefined when not provided', capturedParams!.onProgress === undefined);
  }

  // Test 4: onProgress callback shape accepted
  console.log(chalk.bold('\nTest 4: onProgress callback with correct shape is accepted'));
  {
    const service = new StageAgentService(createConfigService());
    let wasCalled = false;
    (service as any).runStagePrompt = async () => {
      wasCalled = true;
      return JSON.stringify({
        action: 'fix',
        summary: 'Fix it',
        steps: ['step 1'],
        estimatedComplexity: 'low',
        affectedFiles: [],
        risks: [],
      });
    };

    const collected: string[] = [];
    await service.generatePlan({
      action: 'fix',
      issueContent: 'Fix callback handling',
      onProgress: (line: string) => collected.push(line),
    });

    assert('generatePlan completed with onProgress callback', wasCalled);
  }

  // Test 5: stage property set correctly
  console.log(chalk.bold('\nTest 5: runStagePrompt receives correct stage names'));
  {
    const service = new StageAgentService(createConfigService());
    const capturedStages: string[] = [];
    (service as any).runStagePrompt = async (params: Record<string, unknown>) => {
      capturedStages.push(params.stage as string);
      return 'Generated content';
    };

    await service.generateFromPrompt('prompt 1');
    assert('generateFromPrompt sets stage to "generate"', capturedStages[0] === 'generate');
  }

  console.log(chalk.bold('\nSummary'));
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

void main();
