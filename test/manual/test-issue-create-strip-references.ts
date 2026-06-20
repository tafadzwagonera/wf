/**
 * Manual Test: issue:create strips removed sections
 *
 * Run: nr test:manual -- test-issue-create-strip-references
 *
 * Verifies:
 * 1. References, Unit Test Scope, Dependencies, and Affected Repositories
 *    are removed from the ticket description
 * 2. Retained sections (Acceptance Criteria, Risks, Out of Scope) are preserved
 * 3. Descriptions without removed sections pass through unchanged
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueCreateCommand } from '../../src/commands/issue-create.command';
import { IssueTrackerService } from '../../src/integrations/issue-trackers/issue-tracker.service';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ARTIFACT_WITH_ALL_SECTIONS = [
  '# Integrate payment gateway',
  '',
  '**Type:** story',
  '**Priority:** medium',
  '',
  '## Description',
  '### Summary',
  'Integrate Stripe payment gateway for checkout.',
  '',
  '### Acceptance Criteria',
  '- Payment intent is created on checkout.',
  '',
  '### Unit Test Scope',
  '- DTO validation covers required fields.',
  '',
  '#### Dependencies',
  '- service-auth v2',
  '',
  '### Risks & Assumptions',
  '- None',
  '',
  '### Affected Repositories',
  '- service-payment-v1',
  '',
  '#### References',
  '- https://stripe.com/docs/payments/intents',
  '- Internal design doc: payment-gateway-rfc.md',
  '',
  '#### Out of Scope',
  '- Refund handling',
].join('\n');

const ARTIFACT_WITHOUT_REMOVED_SECTIONS = [
  '# Add health check endpoint',
  '',
  '**Type:** task',
  '**Priority:** low',
  '',
  '## Description',
  '### Summary',
  'Expose a /health endpoint for liveness probes.',
  '',
  '### Acceptance Criteria',
  '- GET /health returns 200.',
].join('\n');

async function testStripSections() {
  console.log('\n🧪 Manual Test: issue:create strips removed sections\n');

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
  const trackerService = app.get(IssueTrackerService);

  let capturedTicket: any = null;
  const origGetAdapter = trackerService.getAdapter.bind(trackerService);
  (trackerService as any).getAdapter = (name: string) => {
    const real = origGetAdapter(name);
    return {
      ...real,
      createTicket: async (ticket: any) => {
        capturedTicket = ticket;
        return { tracker: name, key: 'MOCK-1', id: '10001', url: null };
      },
    };
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-strip-sections-'));

  // --- Test 1: Removed sections are stripped ---
  {
    capturedTicket = null;
    const filePath = path.join(tmpDir, 'all-sections.md');
    fs.writeFileSync(filePath, ARTIFACT_WITH_ALL_SECTIONS);

    const origLog = console.log;
    console.log = () => {};
    try {
      await command.run([filePath], {
        silent: true,
        ticketProject: 'MOCK',
      } as any);
    } finally {
      console.log = origLog;
    }

    const desc = capturedTicket?.description ?? '';

    if (!desc.includes('#### References')) {
      pass('References heading is stripped');
    } else {
      fail('References heading was found', `Got: ${desc}`);
    }

    if (!desc.includes('stripe.com/docs')) {
      pass('Reference URLs are stripped');
    } else {
      fail('Reference URL was found', `Got: ${desc}`);
    }

    if (!desc.includes('### Unit Test Scope')) {
      pass('Unit Test Scope heading is stripped');
    } else {
      fail('Unit Test Scope heading was found', `Got: ${desc}`);
    }

    if (!desc.includes('#### Dependencies')) {
      pass('Dependencies heading is stripped');
    } else {
      fail('Dependencies heading was found', `Got: ${desc}`);
    }

    if (!desc.includes('### Affected Repositories')) {
      pass('Affected Repositories heading is stripped');
    } else {
      fail('Affected Repositories heading was found', `Got: ${desc}`);
    }

    if (desc.includes('### Acceptance Criteria')) {
      pass('Acceptance Criteria section is preserved');
    } else {
      fail('Acceptance Criteria section was lost', `Got: ${desc}`);
    }

    if (desc.includes('### Risks & Assumptions')) {
      pass('Risks & Assumptions section is preserved');
    } else {
      fail('Risks & Assumptions section was lost', `Got: ${desc}`);
    }

    if (desc.includes('#### Out of Scope')) {
      pass('Out of Scope section is preserved');
    } else {
      fail('Out of Scope section was lost', `Got: ${desc}`);
    }
  }

  // --- Test 2: Descriptions without removed sections pass through unchanged ---
  {
    capturedTicket = null;
    const filePath = path.join(tmpDir, 'clean.md');
    fs.writeFileSync(filePath, ARTIFACT_WITHOUT_REMOVED_SECTIONS);

    const origLog = console.log;
    console.log = () => {};
    try {
      await command.run([filePath], {
        silent: true,
        ticketProject: 'MOCK',
      } as any);
    } finally {
      console.log = origLog;
    }

    if (capturedTicket?.description?.includes('GET /health returns 200')) {
      pass('Description without removed sections passes through unchanged');
    } else {
      fail(
        'Description without removed sections was altered',
        `Got: ${capturedTicket?.description}`,
      );
    }
  }

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
  await app.close();

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

testStripSections().catch((err) => {
  console.error(err.stdout || err.message);
  process.exit(1);
});
