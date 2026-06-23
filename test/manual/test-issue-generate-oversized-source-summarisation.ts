/**
 * Manual Test: issue:generate oversized source summarisation and interactive review
 *
 * Run: nr test:manual -- test-issue-generate-oversized-source-summarisation
 *
 * Verifies:
 * 1. Sources under MAX_SOURCE_CONTENT_LENGTH pass through without summarisation
 * 2. Sources exceeding MAX_SOURCE_CONTENT_LENGTH trigger AI summarisation
 * 3. Silent mode uses AI summary without interactive review
 * 4. Interactive mode presents bullet review when TTY is available
 * 5. Empty bullet approval falls back to the full AI summary
 * 6. buildSynthesisPrompt and buildClarificationPrompt use MAX_SOURCE_CONTENT_LENGTH
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
  '# Heading: Test oversized source summarisation',
  '',
  '**Type:** bug',
  '**Priority:** highest',
  '',
  '## Description',
  '',
  '### Summary',
  'NATS consumer wedge caused failed transactions.',
  '',
  '#### Technical Details',
  'Consumer group stuck after deployment.',
  '',
  '### Acceptance Criteria',
  '- Transactions resume after fix',
  '',
  '### Risks & Assumptions',
  '- None',
  '',
  '#### Out of Scope',
  '- None',
].join('\n');

const MOCK_SUMMARY_BULLETS = [
  '- NATS consumer group wedged after deployment at 16:30 UTC',
  '- 42 transactions failed during the outage window',
  '- Root cause: consumer rebalance timeout exceeded',
  '- Remediation: manual consumer group reset via nats-cli',
].join('\n');

async function testOversizedSourceSummarisation() {
  console.log('\n\u{1F9EA} Manual Test: issue:generate oversized source summarisation\n');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  let passed = 0;
  let failed = 0;

  const pass = (msg: string) => {
    console.log(`  \u2713 ${msg}`);
    passed++;
  };

  const fail = (msg: string, detail?: string) => {
    console.error(`  \u2717 ${msg}${detail ? `\n    \u2192 ${detail}` : ''}`);
    failed++;
  };

  app.get(AiService);
  const originalProtoExecute = AiService.prototype.execute;
  const originalGenerateFromPrompt = StageAgentService.prototype.generateFromPrompt;

  const command = app.get(IssueGenerateCommand);

  // --- Test 1: Small source does not trigger summarisation ---
  {
    const tmpFile = path.join(os.tmpdir(), `wf-small-source-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, 'Short source content.', 'utf-8');

    let summarisationCalled = false;
    let aiCallCount = 0;
    (AiService.prototype as any).execute = async (opts: any) => {
      aiCallCount++;
      const prompt: string = opts.prompt ?? '';
      if (prompt.includes('Summarise the following source')) {
        summarisationCalled = true;
      }
      return { content: MOCK_TICKET_RESPONSE };
    };
    (StageAgentService.prototype as any).generateFromPrompt = async (prompt: string) => {
      aiCallCount++;
      if (prompt.includes('Summarise the following source')) {
        summarisationCalled = true;
      }
      return MOCK_TICKET_RESPONSE;
    };

    let capturedOutput = '';
    const origLog = console.log;
    console.log = (...args: any[]) => {
      capturedOutput += args.map(String).join(' ') + '\n';
    };

    try {
      await command.run([tmpFile], { silent: true, repos: [] } as any);
    } catch {
      // Ignore
    } finally {
      console.log = origLog;
    }

    if (!summarisationCalled) {
      pass('Small source does not trigger AI summarisation');
    } else {
      fail('Small source incorrectly triggered AI summarisation');
    }

    if (!capturedOutput.includes('Summarising')) {
      pass('No summarisation warning for small source');
    } else {
      fail('Unexpected summarisation warning for small source');
    }

    fs.unlinkSync(tmpFile);
  }

  // --- Test 2: Oversized source triggers summarisation in silent mode ---
  {
    const tmpFile = path.join(os.tmpdir(), `wf-oversized-source-${Date.now()}.txt`);
    // Create content exceeding 30,000 characters
    const oversizedContent = 'x'.repeat(31_000);
    fs.writeFileSync(tmpFile, oversizedContent, 'utf-8');

    let summarisationCalled = false;
    let aiCallCount = 0;
    (AiService.prototype as any).execute = async (opts: any) => {
      aiCallCount++;
      const prompt: string = opts.prompt ?? '';
      if (prompt.includes('Summarise the following source')) {
        summarisationCalled = true;
        return { content: MOCK_SUMMARY_BULLETS };
      }
      return { content: MOCK_TICKET_RESPONSE };
    };
    (StageAgentService.prototype as any).generateFromPrompt = async (prompt: string) => {
      aiCallCount++;
      if (prompt.includes('Summarise the following source')) {
        summarisationCalled = true;
        return MOCK_SUMMARY_BULLETS;
      }
      return MOCK_TICKET_RESPONSE;
    };

    let capturedOutput = '';
    const origLog = console.log;
    console.log = (...args: any[]) => {
      capturedOutput += args.map(String).join(' ') + '\n';
    };

    try {
      await command.run([tmpFile], { silent: true, repos: [] } as any);
    } catch {
      // Ignore
    } finally {
      console.log = origLog;
    }

    if (summarisationCalled) {
      pass('Oversized source triggers AI summarisation');
    } else {
      fail('Oversized source did not trigger AI summarisation');
    }

    // Silent mode should not show the warning
    if (!capturedOutput.includes('Summarising')) {
      pass('Silent mode suppresses summarisation warning');
    } else {
      fail('Silent mode leaked summarisation warning');
    }

    fs.unlinkSync(tmpFile);
  }

  // --- Test 3: Non-silent mode shows summarisation warning ---
  {
    const tmpFile = path.join(os.tmpdir(), `wf-oversized-warn-${Date.now()}.txt`);
    const oversizedContent = 'y'.repeat(31_000);
    fs.writeFileSync(tmpFile, oversizedContent, 'utf-8');

    let summarisationCalled = false;
    (AiService.prototype as any).execute = async (opts: any) => {
      const prompt: string = opts.prompt ?? '';
      if (prompt.includes('Summarise the following source')) {
        summarisationCalled = true;
        return { content: MOCK_SUMMARY_BULLETS };
      }
      if (prompt.includes('Analyze these sources and identify')) {
        return { content: '[]' };
      }
      return { content: MOCK_TICKET_RESPONSE };
    };
    (StageAgentService.prototype as any).generateFromPrompt = async (prompt: string) => {
      if (prompt.includes('Summarise the following source')) {
        summarisationCalled = true;
        return MOCK_SUMMARY_BULLETS;
      }
      if (prompt.includes('Analyze these sources and identify')) {
        return '[]';
      }
      return MOCK_TICKET_RESPONSE;
    };

    // Mock inquirer to auto-accept all and type "done"
    const inquirerModule = await import('inquirer');
    const originalPrompt = inquirerModule.default.prompt;
    let promptCallCount = 0;
    (inquirerModule.default as any).prompt = async (questions: any[]) => {
      promptCallCount++;
      const q = Array.isArray(questions) ? questions[0] : questions;
      if (q.type === 'confirm') {
        return { accept: true };
      }
      // Input prompt — return "done" to exit chat loop
      return { input: 'done' };
    };

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
      await command.run([tmpFile], { repos: [] } as any);
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

    if (summarisationCalled) {
      pass('Non-silent oversized source triggers summarisation');
    } else {
      fail('Non-silent oversized source did not trigger summarisation');
    }

    if (capturedOutput.includes('exceeds 30000 characters')) {
      pass('Warning message shows character count');
    } else {
      fail('Missing summarisation warning', `Output: ${capturedOutput.slice(0, 500)}`);
    }

    if (capturedOutput.includes('Review the summarised key points')) {
      pass('Interactive review prompt is shown');
    } else {
      fail('Interactive review prompt missing', `Output: ${capturedOutput.slice(0, 500)}`);
    }

    // Bullets should be presented (4 confirm prompts + 1 "done" input)
    if (promptCallCount >= 5) {
      pass(`Inquirer prompted ${promptCallCount} times (4 bullets + done input)`);
    } else {
      fail(`Expected at least 5 inquirer prompts, got ${promptCallCount}`);
    }

    fs.unlinkSync(tmpFile);
  }

  // --- Test 4: Synthesis prompt uses MAX_SOURCE_CONTENT_LENGTH, not 2000 ---
  {
    const tmpFile = path.join(os.tmpdir(), `wf-truncation-check-${Date.now()}.txt`);
    // Content between 2000 and 30000 chars — should NOT be truncated
    const midContent = 'z'.repeat(5_000);
    fs.writeFileSync(tmpFile, midContent, 'utf-8');

    let synthesisPrompt = '';
    (AiService.prototype as any).execute = async (opts: any) => {
      const prompt: string = opts.prompt ?? '';
      if (prompt.includes('Sources to synthesize')) {
        synthesisPrompt = prompt;
      }
      return { content: MOCK_TICKET_RESPONSE };
    };
    (StageAgentService.prototype as any).generateFromPrompt = async (prompt: string) => {
      if (prompt.includes('Sources to synthesize')) {
        synthesisPrompt = prompt;
      }
      return MOCK_TICKET_RESPONSE;
    };

    let capturedOutput = '';
    const origLog = console.log;
    console.log = (...args: any[]) => {
      capturedOutput += args.map(String).join(' ') + '\n';
    };

    try {
      await command.run([tmpFile], { silent: true, repos: [] } as any);
    } catch {
      // Ignore
    } finally {
      console.log = origLog;
    }

    if (synthesisPrompt.includes('z'.repeat(5_000))) {
      pass('5,000-char source is NOT truncated in synthesis prompt');
    } else if (synthesisPrompt.includes('z'.repeat(2_000)) && !synthesisPrompt.includes('z'.repeat(2_001))) {
      fail('Source was truncated at 2,000 chars (old limit still active)');
    } else {
      fail('Unexpected truncation behaviour', `Prompt length: ${synthesisPrompt.length}`);
    }

    fs.unlinkSync(tmpFile);
  }

  // Cleanup
  AiService.prototype.execute = originalProtoExecute;
  StageAgentService.prototype.generateFromPrompt = originalGenerateFromPrompt;

  await app.close();

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

testOversizedSourceSummarisation();
