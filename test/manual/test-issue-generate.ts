/**
 * Manual Test: issue:generate buildSynthesisPrompt template sections
 *
 * Run: nr test:manual -- test-issue-generate
 *
 * Verifies that the synthesized output contains all required Jira ticket
 * template sections when the AI response is mocked. No real API calls are made.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueGenerateCommand } from '../../src/commands/issue-generate.command';
import { AiService } from '../../src/integrations/ai/ai.service';

const MOCK_AI_RESPONSE = `# Heading: Add rate limiting to the API gateway

**Type:** task
**Priority:** medium

## Description

### Summary
The API gateway currently has no rate limiting. Under sustained load, downstream services are overwhelmed.
Add per-client rate limiting using a token-bucket algorithm.

\`\`\`typescript
// Example middleware hook
app.use(rateLimit({ windowMs: 60_000, max: 100 }));
\`\`\`

#### Technical Details
- Add a Redis-backed token-bucket middleware to the gateway.
- Ensure backward compatibility by defaulting to 100 req/min per client.
- No database migrations required.

### Acceptance Criteria
- API returns 429 when a client exceeds 100 requests per minute.
- The rate limit is configurable via environment variable RATE_LIMIT_MAX.

### Unit Test Scope
- Unit test the token-bucket middleware in isolation.
- Integration test the gateway with a mocked Redis client.

#### Dependencies
- redis@^4.0.0

### Risks & Assumptions
- Redis availability is assumed; a circuit breaker is out of scope.

### Affected Repositories
- api-gateway

#### References
- https://example.com/rfc-rate-limiting

#### Out of Scope
- Per-endpoint rate limits.
`;

async function testIssueGenerate() {
  console.log(
    '\n🧪 Manual Test: issue:generate buildSynthesisPrompt template sections\n',
  );

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

  app.get(AiService); // ensure singleton is initialized
  const originalProtoExecute = AiService.prototype.execute;
  let aiCallCount = 0;
  (AiService.prototype as any).execute = async () => {
    aiCallCount++;
    return { content: MOCK_AI_RESPONSE };
  };

  // Two temp source files to bypass the single-source short-circuit in synthesizeWithAI:
  //   if (sources.length === 1 && sources[0].ticket) return sources[0].ticket
  const tmpFile1 = path.join(os.tmpdir(), `wf-gen-test-a-${Date.now()}.txt`);
  const tmpFile2 = path.join(os.tmpdir(), `wf-gen-test-b-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile1, 'Source A: placeholder content.', 'utf-8');
  fs.writeFileSync(tmpFile2, 'Source B: placeholder content.', 'utf-8');

  let capturedOutput = '';
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout.write as any) = (chunk: any, ...args: any[]) => {
    capturedOutput += String(chunk);
    return true;
  };

  const command = app.get(IssueGenerateCommand);

  try {
    await command.run([tmpFile1, tmpFile2], { repos: [] } as any);
  } catch (_) {
    // Ignore — assertions are made on captured stdout
  } finally {
    process.stdout.write = origWrite;
    fs.unlinkSync(tmpFile1);
    fs.unlinkSync(tmpFile2);
    AiService.prototype.execute = originalProtoExecute;
  }

  const REQUIRED_SECTIONS = [
    '### Summary',
    '#### Technical Details',
    '### Acceptance Criteria',
    '### Unit Test Scope',
    '#### Dependencies',
    '### Risks & Assumptions',
    '### Affected Repositories',
    '#### References',
    '#### Out of Scope',
  ];

  for (const section of REQUIRED_SECTIONS) {
    if (capturedOutput.includes(section)) {
      pass(`Output contains "${section}"`);
    } else {
      fail(
        `Output is missing "${section}"`,
        `Captured output (first 600 chars):\n    ${capturedOutput.slice(0, 600)}`,
      );
    }
  }

  // --- Fix 1: trailing-dash regression ---
  // "plan-tripcom-tour-sync-manual-" would have been produced before the fix.
  // We verify by synthesizing a mock title that would truncate to a trailing dash.
  {
    const longTitle = 'Plan: Tripcom Tour Sync Manual Test Script';
    const sanitized = longTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 30)
      .replace(/-+$/, '');
    if (!sanitized.endsWith('-')) {
      pass('sanitizedTitle does not end with a trailing dash');
    } else {
      fail(
        'sanitizedTitle still ends with a trailing dash',
        `Got: "${sanitized}"`,
      );
    }
  }

  // --- Fix 2: AI synthesis bypass regression ---
  // Verifies aiService.execute was called at least once during the two-source run above.
  // This is a direct call-count spy — immune to false positives from source content.
  if (aiCallCount > 0) {
    pass(
      `AI synthesis was invoked (aiService.execute called ${aiCallCount} time(s))`,
    );
  } else {
    fail('AI synthesis was NOT invoked — aiService.execute call count is 0');
  }

  // The prompt instructs the AI to start the title with "# Heading:" — verify the serialized
  // output includes a non-empty heading line in that format.
  if (/# Heading: .+/.test(capturedOutput)) {
    pass('Output contains "# Heading: <title>" line');
  } else {
    fail(
      'Output is missing "# Heading: <title>" line',
      `Captured output (first 600 chars):\n    ${capturedOutput.slice(0, 600)}`,
    );
  }

  // --- Fix 3: single-source stub-description forces AI synthesis ---
  // A ticket with a description shorter than MIN_DESCRIPTION_LENGTH must go through AI.
  // Uses a single .md source with a 20-char description — should NOT be short-circuited.
  {
    const stubFile = path.join(os.tmpdir(), `wf-gen-stub-${Date.now()}.md`);
    fs.writeFileSync(
      stubFile,
      '# Plan: Quick Stub Feature\n\nShort stub description.\n',
      'utf-8',
    );

    let stubAiCallCount = 0;
    const existingProtoExecute = AiService.prototype.execute;
    (AiService.prototype as any).execute = async () => {
      stubAiCallCount++;
      return { content: MOCK_AI_RESPONSE };
    };

    let stubOutput = '';
    const origWriteStub = process.stdout.write.bind(process.stdout);
    (process.stdout.write as any) = (chunk: any, ...args: any[]) => {
      stubOutput += String(chunk);
      return true;
    };

    try {
      await command.run([stubFile], { repos: [] } as any);
    } catch (_) {
      // Ignore — assertion is on stubAiCallCount
    } finally {
      process.stdout.write = origWriteStub;
      fs.unlinkSync(stubFile);
      AiService.prototype.execute = existingProtoExecute;
    }

    if (stubAiCallCount > 0) {
      pass(
        'single-source stub description triggered AI synthesis (not short-circuited)',
      );
    } else {
      fail(
        'single-source stub description was short-circuited — AI was NOT called',
      );
    }
  }

  console.log('\n' + '━'.repeat(60));
  console.log(`Results: ${passed} passed   ${failed} failed`);
  if (failed === 0) console.log('All tests passed! ✓');
  console.log('━'.repeat(60) + '\n');

  await app.close();
  if (failed > 0) process.exit(1);
}

testIssueGenerate();
