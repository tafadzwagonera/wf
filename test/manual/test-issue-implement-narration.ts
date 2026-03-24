/**
 * Manual Test: issue:implement plan narration
 *
 * Run: nr test:manual -- test-issue-implement-narration
 *
 * Verifies:
 *   1. narrateImplementationPlan is called and its output is printed to console
 *   2. Each ## section heading is rendered (Goal, Approach, Tasks)
 *   3. Narration body text is printed
 *   4. sceneContext passed to generateFileChange includes "Plan narration:"
 *   5. Generated file content is written to disk
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { ImplementerAgent } from '../../src/agents/implementer.agent';
import type { TicketArtifact, PlanArtifact } from '../../src/agents/interfaces';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

function captureStdout(): { restore: () => string } {
  let out = '';
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout.write as any) = (chunk: string) => {
    out += chunk;
    return true;
  };
  return {
    restore: () => {
      (process.stdout.write as any) = orig;
      return out;
    },
  };
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  const implementer = app.get(ImplementerAgent);

  // ── Test: narration is called, printed, and passed to generateFileChange ──
  console.log('\n🧪 Test: plan narration output\n' + '─'.repeat(60));
  {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wf-narration-test-'),
    );
    // Create the source file that filesAffected references
    const repoName = 'my-repo';
    const repoDir = path.join(tmpDir, repoName);
    const srcDir = path.join(repoDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'foo.ts'), '// original\n');

    // Track what generateFileChange receives
    let sceneContextSeen = '';

    // Monkey-patch services on the implementer instance
    (implementer as any).claudeService.narrateImplementationPlan = async () =>
      '## Goal\nTest goal.\n\n## Approach\nTest approach.\n\n## Tasks\n1. my-repo/src/foo.ts — add bar';

    (implementer as any).claudeService.generateFileChange = async (p: {
      ticketContent: string;
    }) => {
      sceneContextSeen = p.ticketContent;
      return '// updated content\n';
    };

    (implementer as any).gitService.getCurrentBranch = async () => '';
    (implementer as any).gitService.createBranch = async () => {};

    const ticket: TicketArtifact = {
      ticketKey: 'TEST-001',
      content: '# TEST-001\nAdd bar to foo.',
      path: path.join(tmpDir, 'TEST-001.md'),
    };

    const planArtifact: PlanArtifact = {
      plan: {
        action: 'feature',
        summary: 'Add bar function to foo module',
        steps: ['Add bar to src/foo.ts'],
        estimatedComplexity: 'low',
        filesAffected: [`${repoName}/src/foo.ts`],
        repositoriesAffected: [repoName],
        risks: [],
      },
      action: 'feature',
      path: path.join(tmpDir, 'TEST-001-plan-feature.json'),
    };

    const stdoutCapture = captureStdout();
    await implementer.execute(ticket, planArtifact, {
      platformName: 'jira',
      repoDir,
    });
    const output = stdoutCapture.restore();

    // Assertions on console output
    if (output.includes('Narrating plan')) {
      pass('Output contains "Narrating plan"');
    } else {
      fail('Output missing "Narrating plan"', output.slice(0, 500));
    }

    if (output.includes('## Goal')) {
      pass('Output contains "## Goal" section heading');
    } else {
      fail('Output missing "## Goal"', output.slice(0, 500));
    }

    if (output.includes('## Approach')) {
      pass('Output contains "## Approach" section heading');
    } else {
      fail('Output missing "## Approach"', output.slice(0, 500));
    }

    if (output.includes('## Tasks')) {
      pass('Output contains "## Tasks" section heading');
    } else {
      fail('Output missing "## Tasks"', output.slice(0, 500));
    }

    if (output.includes('Test goal.')) {
      pass('Narration body text is printed');
    } else {
      fail('Narration body text not found in output', output.slice(0, 500));
    }

    // Assertions on scene context propagation
    if (sceneContextSeen.includes('Plan narration:')) {
      pass('generateFileChange received sceneContext with "Plan narration:"');
    } else {
      fail(
        'generateFileChange did not receive "Plan narration:" in ticketContent',
        sceneContextSeen.slice(0, 300),
      );
    }

    // Assertions on written file
    const writtenPath = path.join(srcDir, 'foo.ts');
    const writtenContent = fs.existsSync(writtenPath)
      ? fs.readFileSync(writtenPath, 'utf-8')
      : '';
    if (writtenContent.includes('// updated content')) {
      pass('Generated file content written to disk');
    } else {
      fail('Generated file content not found on disk', writtenContent.slice(0, 200));
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  await app.close();

  console.log('\n' + '━'.repeat(60));
  console.log(`Results: ✅ ${passed} passed   ❌ ${failed} failed`);
  if (failed === 0) console.log('✅ All tests passed!');
  console.log('━'.repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
