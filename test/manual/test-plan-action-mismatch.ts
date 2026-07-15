/**
 * Manual Smoke Test: plan action mismatch handling
 *
 * Run: nr test:manual -- test-plan-action-mismatch
 *
 * Verifies:
 *   A. createPlanArtifact returns cached plan when prompt picks plan's action
 *   B. loadPlanArtifact returns cached plan when prompt picks plan's action
 *   C. resolveCustomPlanToken returns artifact with plan's action when prompt picks it
 *   D. Non-interactive mode: all three methods throw ValidationError with actionable guidance
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PlanStageService } from '../../src/workflows/stages/plan-stage.service';
import { IssueCommand } from '../../src/commands/issue.command';
import { ValidationError } from '../../src/shared/utils/errors';
import {
  buildPlanArtifactFilename,
  buildPlanArtifactManifest,
  hashPlanArtifactSources,
  writePlanArtifactManifest,
} from '../../src/shared/utils/plan-artifact';
import inquirer from 'inquirer';
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

const setInteractiveSession = () => {
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
};

const setNonInteractiveSession = () => {
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
};

/**
 * Build a cached plan fixture where the file content's action differs from
 * the filename/manifest action. This simulates a hand-edited or mis-stamped plan.
 *
 * @param tempDir - Temp directory for the fixture
 * @param filenameAction - Action encoded in the filename and manifest (what resolution will match)
 * @param contentAction - Action stored inside the plan file content (what readPlan will return)
 * @param sourceName - Ticket key used as source identifier
 */
const buildCachedPlanFixture = (
  tempDir: string,
  filenameAction: string,
  contentAction: string,
  sourceName: string
) => {
  const hash = hashPlanArtifactSources([sourceName]);
  const createdAt = new Date('2026-04-16T00:00:00.000Z');
  const planFilename = buildPlanArtifactFilename({ createdAt, hash, action: filenameAction as any, format: 'json' });
  const planPath = path.join(tempDir, planFilename);
  const plan = {
    action: contentAction,
    summary: 'Test plan for mismatch smoke test',
    estimatedComplexity: 'low' as const,
    steps: ['Step A'],
    affectedFiles: [],
    affectedRepositories: [],
  };
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  const manifest = buildPlanArtifactManifest(
    planPath, filenameAction as any, 'json', hash, sourceName, 'ticket', createdAt
  );
  writePlanArtifactManifest(manifest);
  return { planPath, plan, hash };
};

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  const planStageService = app.get(PlanStageService);
  const issueCommand = app.get(IssueCommand);

  // ── Test A: createPlanArtifact — interactive, user picks plan's action ──
  console.log('\n🧪 Test A: createPlanArtifact — interactive, user picks plan action\n' + '─'.repeat(60));
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-mismatch-smoke-'));
    const ticketPath = path.join(tempDir, 'WBP-SM01.md');
    fs.writeFileSync(ticketPath, '# WBP-SM01: Smoke test');
    buildCachedPlanFixture(tempDir, 'fix', 'investigate', 'WBP-SM01');

    setInteractiveSession();
    const origPrompt = inquirer.prompt.bind(inquirer);
    (inquirer as any).prompt = async () => ({ selectedAction: 'investigate' });

    try {
      const artifact = await planStageService.createPlanArtifact(
        { ticketKey: 'WBP-SM01', content: '# WBP-SM01: Smoke test', path: ticketPath },
        { action: 'fix', skipExisting: true }
      );

      if (artifact.fromCache && artifact.action === 'investigate' && artifact.plan.action === 'investigate') {
        pass('createPlanArtifact returns consistent cached artifact with plan action');
      } else {
        fail('createPlanArtifact returned unexpected artifact', JSON.stringify({ fromCache: artifact.fromCache, action: artifact.action, planAction: artifact.plan.action }));
      }
    } catch (err) {
      fail('createPlanArtifact threw unexpectedly', String(err));
    } finally {
      (inquirer as any).prompt = origPrompt;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  // ── Test B: loadPlanArtifact — interactive, user picks plan's action ──
  console.log('\n🧪 Test B: loadPlanArtifact — interactive, user picks plan action\n' + '─'.repeat(60));
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-mismatch-smoke-'));
    const ticketPath = path.join(tempDir, 'WBP-SM02.md');
    fs.writeFileSync(ticketPath, '# WBP-SM02: Smoke test');
    buildCachedPlanFixture(tempDir, 'fix', 'investigate', 'WBP-SM02');

    setInteractiveSession();
    const origPrompt = inquirer.prompt.bind(inquirer);
    (inquirer as any).prompt = async () => ({ selectedAction: 'investigate' });

    try {
      const artifact = await planStageService.loadPlanArtifact(ticketPath, 'fix');

      if (artifact.fromCache && artifact.action === 'investigate' && artifact.plan.action === 'investigate') {
        pass('loadPlanArtifact returns consistent cached artifact with plan action');
      } else {
        fail('loadPlanArtifact returned unexpected artifact', JSON.stringify({ fromCache: artifact.fromCache, action: artifact.action, planAction: artifact.plan.action }));
      }
    } catch (err) {
      fail('loadPlanArtifact threw unexpectedly', String(err));
    } finally {
      (inquirer as any).prompt = origPrompt;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  // ── Test C: resolveCustomPlanToken — interactive, user picks plan's action ──
  console.log('\n🧪 Test C: resolveCustomPlanToken — interactive, user picks plan action\n' + '─'.repeat(60));
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-mismatch-smoke-'));
    const planPath = path.join(tempDir, '2026-04-16-abc1234-investigate-plan.json');
    const plan = {
      action: 'investigate',
      summary: 'Custom token smoke test',
      estimatedComplexity: 'low' as const,
      steps: ['Step X'],
      affectedFiles: [],
      affectedRepositories: [],
    };
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

    setInteractiveSession();
    const origPrompt = inquirer.prompt.bind(inquirer);
    (inquirer as any).prompt = async () => ({ selectedAction: 'investigate' });

    try {
      const result = await (issueCommand as any).resolveCustomPlanToken(
        { kind: 'custom', action: 'fix', artifactPath: planPath },
        undefined
      );

      if (
        result
        && result.action === 'investigate'
        && result.planArtifact.action === 'investigate'
        && result.planArtifact.plan.action === 'investigate'
      ) {
        pass('resolveCustomPlanToken returns consistent artifact with plan action');
      } else {
        fail('resolveCustomPlanToken returned unexpected result', JSON.stringify(result ? { action: result.action, planAction: result.planArtifact?.action } : null));
      }
    } catch (err) {
      fail('resolveCustomPlanToken threw unexpectedly', String(err));
    } finally {
      (inquirer as any).prompt = origPrompt;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  // ── Test D: Non-interactive — all three throw ValidationError ──
  console.log('\n🧪 Test D: Non-interactive — all three methods throw ValidationError\n' + '─'.repeat(60));
  setNonInteractiveSession();

  // D1: createPlanArtifact
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-mismatch-smoke-'));
    const ticketPath = path.join(tempDir, 'WBP-SM03.md');
    fs.writeFileSync(ticketPath, '# WBP-SM03: Non-interactive smoke');
    buildCachedPlanFixture(tempDir, 'fix', 'investigate', 'WBP-SM03');

    try {
      await planStageService.createPlanArtifact(
        { ticketKey: 'WBP-SM03', content: '# WBP-SM03: Non-interactive smoke', path: ticketPath },
        { action: 'fix', skipExisting: true }
      );
      fail('createPlanArtifact should have thrown in non-interactive mode');
    } catch (err) {
      if (err instanceof ValidationError && /mismatch/i.test(err.message)) {
        pass('createPlanArtifact throws ValidationError with "mismatch" in non-interactive mode');
      } else if (err instanceof ValidationError) {
        fail('createPlanArtifact threw ValidationError but message lacks "mismatch"', err.message);
      } else {
        fail('createPlanArtifact threw wrong error type', String(err));
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  // D2: loadPlanArtifact
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-mismatch-smoke-'));
    const ticketPath = path.join(tempDir, 'WBP-SM04.md');
    fs.writeFileSync(ticketPath, '# WBP-SM04: Non-interactive smoke');
    buildCachedPlanFixture(tempDir, 'fix', 'investigate', 'WBP-SM04');

    try {
      await planStageService.loadPlanArtifact(ticketPath, 'fix');
      fail('loadPlanArtifact should have thrown in non-interactive mode');
    } catch (err) {
      if (err instanceof ValidationError && /mismatch/i.test(err.message)) {
        pass('loadPlanArtifact throws ValidationError with "mismatch" in non-interactive mode');
      } else if (err instanceof ValidationError) {
        fail('loadPlanArtifact threw ValidationError but message lacks "mismatch"', err.message);
      } else {
        fail('loadPlanArtifact threw wrong error type', String(err));
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  // D3: resolveCustomPlanToken
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-mismatch-smoke-'));
    const planPath = path.join(tempDir, '2026-04-16-abc1234-investigate-plan.json');
    const plan = {
      action: 'investigate',
      summary: 'Non-interactive smoke',
      estimatedComplexity: 'low' as const,
      steps: ['Step Y'],
      affectedFiles: [],
      affectedRepositories: [],
    };
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

    try {
      await (issueCommand as any).resolveCustomPlanToken(
        { kind: 'custom', action: 'fix', artifactPath: planPath },
        undefined
      );
      fail('resolveCustomPlanToken should have thrown in non-interactive mode');
    } catch (err) {
      if (err instanceof ValidationError && /mismatch/i.test(err.message)) {
        pass('resolveCustomPlanToken throws ValidationError with "mismatch" in non-interactive mode');
      } else if (err instanceof ValidationError) {
        fail('resolveCustomPlanToken threw ValidationError but message lacks "mismatch"', err.message);
      } else {
        fail('resolveCustomPlanToken threw wrong error type', String(err));
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  await app.close();

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
