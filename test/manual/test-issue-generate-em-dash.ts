/**
 * Manual Test: issue:generate em-dash normalization smoke test
 *
 * Run: nr test:manual -- test-issue-generate-em-dash
 *
 * Verifies:
 *   1. AI-synthesized `issue:generate` output rewrites em dashes to ` - `.
 *   2. Single-source imported ticket output rewrites em dashes to ` - `.
 *   3. Saved generated artifacts rewrite em dashes to ` - `.
 *
 * No real AI or platform calls are made.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { IssueGenerateCommand } from '../../src/commands/issue-generate.command';
import { AiService } from '../../src/integrations/ai/ai.service';
import { FormatConverterService } from '../../src/common/converters/format-converter.service';

const MOCK_AI_RESPONSE = `# Generated Title — Needs Cleanup

**Type:** task
**Priority:** medium

## Description

### Summary
Generated summary — with em dash

#### Technical Details
- None

### Acceptance Criteria
- None

### Unit Test Scope
- None

#### Dependencies
- None

### Risks & Assumptions
- None

### Affected Repositories
- None

#### References
- None

#### Out of Scope
- None
`;

/**
 * Print a passing assertion result.
 *
 * @param message Human-readable pass message
 * @returns Nothing
 */
const pass = (message: string): void => {
  console.log(`  ✓ ${message}`);
};

/**
 * Print a failing assertion result.
 *
 * @param message Human-readable failure message
 * @param detail Optional failure detail
 * @returns Nothing
 */
const fail = (message: string, detail?: string): void => {
  console.error(`  ✗ ${message}${detail ? `\n    → ${detail}` : ''}`);
};

/**
 * Verify a serialized output string contains only ASCII replacement punctuation.
 *
 * @param label Human-readable assertion label
 * @param content Serialized output content
 * @returns Pass/fail counters for aggregation
 */
const assertNoEmDash = (
  label: string,
  content: string,
): { passed: number; failed: number } => {
  if (content.includes('—')) {
    fail(label, 'Found an em dash in serialized output');
    return { passed: 0, failed: 1 };
  }

  if (!content.includes(' - ')) {
    fail(label, 'Expected normalized ASCII " - " punctuation');
    return { passed: 0, failed: 1 };
  }

  pass(label);
  return { passed: 1, failed: 0 };
};

async function main() {
  console.log(
    chalkHeader('\n🧪 issue:generate em-dash normalization smoke test\n'),
  );

  let passed = 0;
  let failed = 0;

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const command = app.get(IssueGenerateCommand);
  const formatConverterService = app.get(FormatConverterService);
  const originalAiExecute = AiService.prototype.execute;
  const originalMdConverter = formatConverterService.getConverter('md');

  (AiService.prototype as any).execute = async () => ({
    content: MOCK_AI_RESPONSE,
  });

  const synthesisSourceA = path.join(
    os.tmpdir(),
    `wf-gen-em-dash-a-${Date.now()}.txt`,
  );
  const synthesisSourceB = path.join(
    os.tmpdir(),
    `wf-gen-em-dash-b-${Date.now()}.txt`,
  );
  const synthesisOutputPath = path.join(
    os.tmpdir(),
    `wf-gen-em-dash-output-${Date.now()}.md`,
  );
  const importedTicketPath = path.join(
    os.tmpdir(),
    `wf-imported-em-dash-${Date.now()}.md`,
  );

  fs.writeFileSync(synthesisSourceA, 'Source A: placeholder content.', 'utf-8');
  fs.writeFileSync(synthesisSourceB, 'Source B: placeholder content.', 'utf-8');
  fs.writeFileSync(
    importedTicketPath,
    '# Imported ticket placeholder',
    'utf-8',
  );

  try {
    console.log(
      'Test 1: synthesized output written via --output excludes em dashes',
    );
    await command.run([synthesisSourceA, synthesisSourceB], {
      format: 'md',
      output: synthesisOutputPath,
    } as any);
    const synthesizedOutput = fs.readFileSync(synthesisOutputPath, 'utf-8');
    ({ passed, failed } = sumResults(
      { passed, failed },
      assertNoEmDash(
        'Synthesized output replaced em dashes with ASCII punctuation',
        synthesizedOutput,
      ),
    ));

    console.log(
      'Test 2: single-source imported ticket output excludes em dashes',
    );
    const detectFormatSpy = jestlessSpy(
      formatConverterService,
      'detectFormat',
      () => 'md',
    );
    const getConverterSpy = jestlessSpy(
      formatConverterService,
      'getConverter',
      ((format: string) => {
        if (format === 'md') {
          return {
            parse: () => ({
              title: 'Imported ticket — Title',
              description:
                'Imported description — long enough to bypass synthesis. '.repeat(
                  3,
                ),
              type: 'task',
              priority: 'medium',
            }),
            serialize: (ticket: { title: string; description: string }) =>
              [`# ${ticket.title}`, '', ticket.description].join('\n'),
          };
        }

        return originalMdConverter;
      }) as any,
    );
    const importedOutputPath = path.join(
      os.tmpdir(),
      `wf-imported-em-dash-output-${Date.now()}.md`,
    );

    try {
      await command.run([importedTicketPath], {
        format: 'md',
        output: importedOutputPath,
      } as any);
      const importedOutput = fs.readFileSync(importedOutputPath, 'utf-8');
      ({ passed, failed } = sumResults(
        { passed, failed },
        assertNoEmDash(
          'Imported ticket output replaced em dashes with ASCII punctuation',
          importedOutput,
        ),
      ));
    } finally {
      detectFormatSpy.restore();
      getConverterSpy.restore();
      if (fs.existsSync(importedOutputPath)) {
        fs.unlinkSync(importedOutputPath);
      }
    }

    console.log('Test 3: saved generated artifacts exclude em dashes');
    const savedArtifactPath = await (command as any).saveTicketLocally(
      {
        title: 'Saved artifact — Title',
        description: 'Saved artifact — Description',
        type: 'task',
        priority: 'medium',
      },
      'jira',
      'md',
      ['https://example.com/spec'],
    );
    const savedArtifact = fs.readFileSync(savedArtifactPath, 'utf-8');
    ({ passed, failed } = sumResults(
      { passed, failed },
      assertNoEmDash(
        'Saved artifact replaced em dashes with ASCII punctuation',
        savedArtifact,
      ),
    ));

    const savedManifestPath = `${savedArtifactPath}.sources.json`;
    if (fs.existsSync(savedArtifactPath)) {
      fs.unlinkSync(savedArtifactPath);
    }
    if (fs.existsSync(savedManifestPath)) {
      fs.unlinkSync(savedManifestPath);
    }
  } finally {
    AiService.prototype.execute = originalAiExecute;
    if (fs.existsSync(synthesisSourceA)) {
      fs.unlinkSync(synthesisSourceA);
    }
    if (fs.existsSync(synthesisSourceB)) {
      fs.unlinkSync(synthesisSourceB);
    }
    if (fs.existsSync(synthesisOutputPath)) {
      fs.unlinkSync(synthesisOutputPath);
    }
    if (fs.existsSync(importedTicketPath)) {
      fs.unlinkSync(importedTicketPath);
    }
    await app.close();
  }

  console.log('\nSummary');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

/**
 * Keep manual test output formatting simple and dependency-free.
 *
 * @param message Header text to print
 * @returns Unchanged header text
 */
const chalkHeader = (message: string): string => message;

/**
 * Add assertion counters together.
 *
 * @param totals Running totals
 * @param result Latest assertion result
 * @returns Updated totals
 */
const sumResults = (
  totals: { passed: number; failed: number },
  result: { passed: number; failed: number },
): { passed: number; failed: number } => ({
  passed: totals.passed + result.passed,
  failed: totals.failed + result.failed,
});

/**
 * Temporarily replace an object property and expose a restore function.
 *
 * @param target Target object
 * @param key Property name to replace
 * @param replacement Temporary replacement value
 * @returns Handle that restores the original property
 */
const jestlessSpy = <T extends object, K extends keyof T>(
  target: T,
  key: K,
  replacement: T[K],
): { restore: () => void } => {
  const original = target[key];
  target[key] = replacement;

  return {
    restore: () => {
      target[key] = original;
    },
  };
};

void main();
