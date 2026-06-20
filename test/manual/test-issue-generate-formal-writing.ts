/**
 * Manual Test: issue:generate formal writing conventions smoke test
 *
 * Run: nr test:manual -- test-issue-generate-formal-writing
 *
 * Verifies:
 *   1. AI-synthesized `issue:generate` output expands contractions.
 *   2. Single-source imported ticket output expands contractions.
 *   3. Saved generated artifacts expand contractions.
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

const MOCK_AI_RESPONSE = `# Generated Title That Don't Work

**Type:** task
**Priority:** medium

## Description

### Summary
It's a summary that can't be used as-is

#### Technical Details
- None

### Acceptance Criteria
- None

### Risks & Assumptions
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
  console.log(`  \u2713 ${message}`);
};

/**
 * Print a failing assertion result.
 *
 * @param message Human-readable failure message
 * @param detail Optional failure detail
 * @returns Nothing
 */
const fail = (message: string, detail?: string): void => {
  console.error(`  \u2717 ${message}${detail ? `\n    \u2192 ${detail}` : ''}`);
};

const CONTRACTION_PATTERN =
  /don't|can't|won't|isn't|aren't|doesn't|wasn't|weren't|couldn't|wouldn't|shouldn't|it's|that's|there's|here's|what's|who's|let's|i'm|we're|they're|you're|we've|they've|you've|i've|we'll|they'll|you'll|i'll|he's|she's/i;

/**
 * Verify a serialized output string contains no contractions.
 *
 * @param label Human-readable assertion label
 * @param content Serialized output content
 * @returns Pass/fail counters for aggregation
 */
const assertNoContractions = (
  label: string,
  content: string,
): { passed: number; failed: number } => {
  const match = content.match(CONTRACTION_PATTERN);
  if (match) {
    fail(label, `Found contraction "${match[0]}" in serialized output`);
    return { passed: 0, failed: 1 };
  }

  pass(label);
  return { passed: 1, failed: 0 };
};

async function main() {
  console.log(
    chalkHeader(
      '\n\ud83e\uddea issue:generate formal writing conventions smoke test\n',
    ),
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
    `wf-gen-formal-a-${Date.now()}.txt`,
  );
  const synthesisSourceB = path.join(
    os.tmpdir(),
    `wf-gen-formal-b-${Date.now()}.txt`,
  );
  const synthesisOutputPath = path.join(
    os.tmpdir(),
    `wf-gen-formal-output-${Date.now()}.md`,
  );
  const importedTicketPath = path.join(
    os.tmpdir(),
    `wf-imported-formal-${Date.now()}.md`,
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
      'Test 1: synthesized output written via --output expands contractions',
    );
    await command.run([synthesisSourceA, synthesisSourceB], {
      format: 'md',
      output: synthesisOutputPath,
    } as any);
    const synthesizedOutput = fs.readFileSync(synthesisOutputPath, 'utf-8');
    ({ passed, failed } = sumResults(
      { passed, failed },
      assertNoContractions(
        'Synthesized output expanded contractions to formal equivalents',
        synthesizedOutput,
      ),
    ));

    console.log(
      'Test 2: single-source imported ticket output expands contractions',
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
              title: "Imported ticket that don't comply",
              description:
                "Imported description that can't be used and it's long enough to bypass synthesis. ".repeat(
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
      `wf-imported-formal-output-${Date.now()}.md`,
    );

    try {
      await command.run([importedTicketPath], {
        format: 'md',
        output: importedOutputPath,
      } as any);
      const importedOutput = fs.readFileSync(importedOutputPath, 'utf-8');
      ({ passed, failed } = sumResults(
        { passed, failed },
        assertNoContractions(
          'Imported ticket output expanded contractions to formal equivalents',
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

    console.log('Test 3: saved generated artifacts expand contractions');
    const savedArtifactPath = await (command as any).saveTicketLocally(
      {
        title: "Saved artifact that don't comply",
        description: "It's a saved artifact that can't stay informal",
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
      assertNoContractions(
        'Saved artifact expanded contractions to formal equivalents',
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
