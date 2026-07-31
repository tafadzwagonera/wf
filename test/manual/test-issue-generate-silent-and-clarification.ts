/**
 * Manual Test: issue:generate --silent output contract and clarification pass
 *
 * Run: nr test:manual -- test-issue-generate-silent-and-clarification
 *
 * Verifies:
 * 1. Silent mode suppresses all decorative output (banners, tips, progress)
 * 2. Silent mode without --save/--output emits only raw ticket content
 * 3. Clarification pass fires in interactive mode and injects answers into synthesis
 * 4. Clarification pass is skipped in silent mode
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueGenerateCommand } from '../../src/commands/issue-generate.command';
import { AiService } from '../../src/integrations/ai/ai.service';
import { StageAgentService } from '../../src/integrations/ai/stage-agent.service';

const MOCK_TICKET_RESPONSE = [
  '# Heading: Test silent mode output',
  '',
  '**Type:** task',
  '**Priority:** medium',
  '',
  '## Description',
  '',
  '### Summary',
  'Test summary for silent mode verification.',
  '',
  '#### Technical Details',
  'None',
  '',
  '### Acceptance Criteria',
  '- None',
  '',
  '### Risks & Assumptions',
  '- None',
  '',
  '#### Out of Scope',
  '- None',
].join('\n');

const MOCK_CLARIFICATION_RESPONSE = JSON.stringify(['What is the target deployment environment?']);

async function testSilentAndClarification() {
  console.log('\n🧪 Manual Test: issue:generate --silent output and clarification pass\n');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  let passed = 0;
  let failed = 0;

  const pass = (msg: string) => {
    console.log(`  ✓ ${msg}`);
    passed++;
  };

  const fail = (msg: string, detail?: string) => {
    console.error(`  ✗ ${msg}${detail ? `\n    → ${detail}` : ''}`);
    failed++;
  };

  app.get(AiService);
  const originalProtoExecute = AiService.prototype.execute;
  const originalGenerateFromPrompt = StageAgentService.prototype.generateFromPrompt;

  const tmpFile1 = path.join(os.tmpdir(), `wf-silent-test-a-${Date.now()}.txt`);
  const tmpFile2 = path.join(os.tmpdir(), `wf-silent-test-b-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile1, 'Source A: placeholder content.', 'utf-8');
  fs.writeFileSync(tmpFile2, 'Source B: placeholder content.', 'utf-8');

  const command = app.get(IssueGenerateCommand);

  // --- Test 1: Silent mode suppresses decorative output ---
  {
    let aiCallCount = 0;
    (AiService.prototype as any).execute = async () => {
      aiCallCount++;
      return { content: MOCK_TICKET_RESPONSE };
    };
    (StageAgentService.prototype as any).generateFromPrompt = async () => {
      aiCallCount++;
      return MOCK_TICKET_RESPONSE;
    };

    let capturedOutput = '';
    const origLog = console.log;
    console.log = (...args: any[]) => {
      capturedOutput += args.map(String).join(' ') + '\n';
    };

    try {
      await command.run([tmpFile1, tmpFile2], {
        silent: true,
        repos: [],
      });
    } catch {
      // Ignore
    } finally {
      console.log = origLog;
    }

    if (!capturedOutput.includes('Generating Ticket')) {
      pass('Silent mode suppresses "Generating Ticket" banner');
    } else {
      fail('Silent mode leaked "Generating Ticket" banner');
    }

    if (!capturedOutput.includes('Fetching:')) {
      pass('Silent mode suppresses "Fetching:" progress');
    } else {
      fail('Silent mode leaked "Fetching:" progress');
    }

    if (!capturedOutput.includes('Using AI to synthesize')) {
      pass('Silent mode suppresses "Using AI to synthesize" banner');
    } else {
      fail('Silent mode leaked "Using AI to synthesize" banner');
    }

    if (!capturedOutput.includes('Tip:')) {
      pass('Silent mode suppresses "Tip:" footer');
    } else {
      fail('Silent mode leaked "Tip:" footer');
    }

    if (capturedOutput.includes('Test summary for silent mode')) {
      pass('Silent mode emits raw ticket content to stdout');
    } else {
      fail('Silent mode did not emit raw ticket content', `Got: ${capturedOutput.slice(0, 300)}`);
    }

    // Only 1 AI call (synthesis), no clarification call
    if (aiCallCount === 1) {
      pass('Silent mode skips clarification AI call (1 call total)');
    } else {
      fail(`Expected 1 AI call in silent mode, got ${aiCallCount}`);
    }
  }

  // --- Test 2: Non-silent interactive mode triggers clarification ---
  {
    let aiCallCount = 0;
    let lastPromptContent = '';
    (AiService.prototype as any).execute = async (opts: any) => {
      aiCallCount++;
      const prompt = opts.prompt ?? '';
      if (aiCallCount === 1) {
        return { content: MOCK_CLARIFICATION_RESPONSE };
      }
      lastPromptContent = prompt;
      return { content: MOCK_TICKET_RESPONSE };
    };
    (StageAgentService.prototype as any).generateFromPrompt = async (prompt: string) => {
      aiCallCount++;
      if (aiCallCount === 1) {
        return MOCK_CLARIFICATION_RESPONSE;
      }
      lastPromptContent = prompt;
      return MOCK_TICKET_RESPONSE;
    };

    // Mock inquirer to auto-answer
    const inquirerModule = await import('inquirer');
    const originalPrompt = inquirerModule.default.prompt;
    (inquirerModule.default as any).prompt = async () => ({
      answer: 'Production AWS',
    });

    // Simulate TTY
    const origStdinTTY = process.stdin.isTTY;
    const origStdoutTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    let capturedOutput = '';
    const origLog = console.log;
    console.log = (...args: any[]) => {
      capturedOutput += args.map(String).join(' ') + '\n';
    };

    try {
      await command.run([tmpFile1, tmpFile2], { repos: [] });
    } catch {
      // Ignore
    } finally {
      console.log = origLog;
      (inquirerModule.default as any).prompt = originalPrompt;
      Object.defineProperty(process.stdin, 'isTTY', {
        value: origStdinTTY,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: origStdoutTTY,
        configurable: true,
      });
    }

    if (aiCallCount === 2) {
      pass('Interactive mode makes 2 AI calls (clarification + synthesis)');
    } else {
      fail(`Expected 2 AI calls in interactive mode, got ${aiCallCount}`);
    }

    if (lastPromptContent.includes('user-clarifications')) {
      pass('Synthesis prompt includes user-clarifications source');
    } else {
      fail('Synthesis prompt missing user-clarifications source');
    }

    if (lastPromptContent.includes('Production AWS')) {
      pass('Synthesis prompt includes user answer "Production AWS"');
    } else {
      fail('Synthesis prompt missing user answer');
    }
  }

  // Cleanup
  fs.unlinkSync(tmpFile1);
  fs.unlinkSync(tmpFile2);
  AiService.prototype.execute = originalProtoExecute;
  StageAgentService.prototype.generateFromPrompt = originalGenerateFromPrompt;

  await app.close();

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

testSilentAndClarification();
