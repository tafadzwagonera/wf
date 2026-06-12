/**
 * Manual Test: issue:create stdin pipe support
 *
 * Run: nr test:manual -- test-issue-create-stdin-pipe
 *
 * Verifies:
 * 1. issue:create reads markdown content from stdin when no file arg is given
 * 2. --format overrides the default md format for stdin
 * 3. Piped content is correctly parsed into a UniversalTicket
 */

import { NestFactory } from '@nestjs/core';
import { Readable } from 'stream';
import { AppModule } from '../../src/app.module';
import { IssueCreateCommand } from '../../src/commands/issue-create.command';
import { IssueTrackerService } from '../../src/integrations/issue-trackers/issue-tracker.service';

const MOCK_MARKDOWN_TICKET = [
  '# Add OAuth2 support',
  '',
  '**Type:** story',
  '**Priority:** high',
  '',
  '## Description',
  '',
  'Implement OAuth2 authorization code flow.',
].join('\n');

async function testStdinPipe() {
  console.log('\n🧪 Manual Test: issue:create stdin pipe support\n');

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

  const command = app.get(IssueCreateCommand);

  // Mock the platform adapter to capture the ticket instead of calling the API
  const platformService = app.get(IssueTrackerService);
  let capturedTicket: any = null;
  const origGetAdapter = platformService.getAdapter.bind(platformService);
  (platformService as any).getAdapter = (name: string) => {
    const real = origGetAdapter(name);
    return {
      ...real,
      createTicket: async (ticket: any) => {
        capturedTicket = ticket;
        return { platform: name, key: 'MOCK-1', id: '10001', url: null };
      },
    };
  };

  // --- Test 1: Read markdown from stdin ---
  {
    capturedTicket = null;

    // Simulate piped stdin
    const origStdin = process.stdin;
    const origIsTTY = process.stdin.isTTY;
    const mockStdin = new Readable({
      read() {
        this.push(MOCK_MARKDOWN_TICKET);
        this.push(null);
      },
    });
    Object.defineProperty(mockStdin, 'isTTY', { value: false });
    Object.defineProperty(process, 'stdin', {
      value: mockStdin,
      configurable: true,
    });

    let capturedOutput = '';
    const origLog = console.log;
    console.log = (...args: any[]) => {
      capturedOutput += args.map(String).join(' ') + '\n';
    };

    try {
      await command.run([], { silent: true, ticketProject: 'MOCK' } as any);
    } finally {
      console.log = origLog;
      Object.defineProperty(process, 'stdin', {
        value: origStdin,
        configurable: true,
      });
      Object.defineProperty(origStdin, 'isTTY', {
        value: origIsTTY,
        configurable: true,
      });
    }

    if (capturedTicket) {
      pass('Stdin content was parsed and submitted to platform adapter');
    } else {
      fail('Platform adapter was not called with ticket from stdin');
    }

    if (capturedTicket?.title?.includes('OAuth2')) {
      pass('Ticket title parsed correctly from stdin markdown');
    } else {
      fail(
        'Ticket title not parsed from stdin',
        `Got: ${capturedTicket?.title}`,
      );
    }

    const lastLine = capturedOutput.trim().split('\n').pop()?.trim();
    if (lastLine === 'MOCK-1') {
      pass('Silent mode emits ticket key as last stdout line from stdin pipe');
    } else {
      fail(
        'Silent output mismatch',
        `Expected last line "MOCK-1", got: "${lastLine}"`,
      );
    }
  }

  // --- Test 2: JSON format via --format flag ---
  {
    capturedTicket = null;

    const jsonContent = JSON.stringify({
      title: 'JSON stdin test',
      description: 'Created from JSON stdin',
      type: 'task',
      priority: 'medium',
    });

    const origStdin = process.stdin;
    const origIsTTY = process.stdin.isTTY;
    const mockStdin = new Readable({
      read() {
        this.push(jsonContent);
        this.push(null);
      },
    });
    Object.defineProperty(mockStdin, 'isTTY', { value: false });
    Object.defineProperty(process, 'stdin', {
      value: mockStdin,
      configurable: true,
    });

    let capturedOutput = '';
    const origLog = console.log;
    console.log = (...args: any[]) => {
      capturedOutput += args.map(String).join(' ') + '\n';
    };

    try {
      await command.run([], {
        silent: true,
        format: 'json',
        ticketProject: 'MOCK',
      } as any);
    } finally {
      console.log = origLog;
      Object.defineProperty(process, 'stdin', {
        value: origStdin,
        configurable: true,
      });
      Object.defineProperty(origStdin, 'isTTY', {
        value: origIsTTY,
        configurable: true,
      });
    }

    if (capturedTicket?.title === 'JSON stdin test') {
      pass('JSON stdin parsed correctly with --format json');
    } else {
      fail(
        'JSON stdin not parsed correctly',
        `Got title: ${capturedTicket?.title}`,
      );
    }
  }

  await app.close();

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

testStdinPipe();
