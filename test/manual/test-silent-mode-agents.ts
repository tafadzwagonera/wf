/**
 * Manual Test: --silent mode for FetcherAgent, PlannerAgent, ReviewerAgent, CommitterAgent
 *
 * Run: nr test:manual -- test-silent-mode-agents
 *
 * Verifies:
 * 1. FetcherAgent.execute() suppresses decorative output when silent
 * 2. FetcherAgent.loadFromDisk() suppresses decorative output when silent
 * 3. PlannerAgent.execute() suppresses decorative output when silent
 * 4. PlannerAgent.loadFromDisk() suppresses decorative output when silent
 * 5. ReviewerAgent.execute() suppresses decorative output when silent
 * 6. CommitterAgent.execute() suppresses decorative output when silent
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { FetcherAgent } from '../../src/agents/fetcher.agent';
import { PlannerAgent } from '../../src/agents/planner.agent';
import { ReviewerAgent } from '../../src/agents/reviewer.agent';
import { CommitterAgent } from '../../src/agents/committer.agent';
import { FetchStageService } from '../../src/workflows/stages/fetch-stage.service';
import { PlanStageService } from '../../src/workflows/stages/plan-stage.service';
import { ReviewStageService } from '../../src/workflows/stages/review-stage.service';
import { CommitStageService } from '../../src/workflows/stages/commit-stage.service';
import { GitService } from '../../src/integrations/git/git.service';

const MOCK_TICKET_CONTENT = '# WBP-TEST: Silent mode test\n\nDescription here.';
const MOCK_PLAN = {
  action: 'fix',
  summary: 'Fix the silent mode',
  estimatedComplexity: 'low',
  steps: ['Step 1'],
  affectedFiles: ['src/test.ts'],
  affectedRepositories: ['wf'],
};

function captureConsole(): { getOutput: () => string; restore: () => void } {
  let captured = '';
  const origLog = console.log;
  console.log = (...args: any[]) => {
    captured += args.map(String).join(' ') + '\n';
  };
  return {
    getOutput: () => captured,
    restore: () => {
      console.log = origLog;
    },
  };
}

async function testSilentModeAgents() {
  console.log('\n🧪 Manual Test: --silent mode for agents\n');

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

  // resolveArtifactDir uses ~/.wf/<basename>/<platform>
  const tmpBaseName = `wf-silent-test-${Date.now()}`;
  const tmpDir = path.join(os.tmpdir(), tmpBaseName);
  fs.mkdirSync(tmpDir, { recursive: true });
  const wfHome = path.join(os.homedir(), '.wf');
  const platformDir = path.join(wfHome, tmpBaseName, 'jira');
  fs.mkdirSync(platformDir, { recursive: true });

  const ticketPath = path.join(platformDir, 'WBP-TEST.md');
  fs.writeFileSync(ticketPath, MOCK_TICKET_CONTENT, 'utf-8');

  const planPath = path.join(platformDir, 'WBP-TEST-plan-fix.json');
  fs.writeFileSync(planPath, JSON.stringify(MOCK_PLAN), 'utf-8');

  // --- Test 1: FetcherAgent.execute() silent ---
  {
    const fetcher = app.get(FetcherAgent);
    const origFetch = FetchStageService.prototype.fetchArtifact;
    (FetchStageService.prototype as any).fetchArtifact = async () => ({
      ticketKey: 'WBP-TEST',
      content: MOCK_TICKET_CONTENT,
      path: ticketPath,
      fromCache: false,
    });

    const cap = captureConsole();
    try {
      await fetcher.execute('WBP-TEST', {
        trackerName: 'jira',
        silent: true,
        baseDir: tmpDir,
      });
    } finally {
      cap.restore();
    }

    const output = cap.getOutput();
    if (output.trim() === '') {
      pass('FetcherAgent.execute() produces no output when silent');
    } else {
      fail('FetcherAgent.execute() leaked output in silent mode', output.slice(0, 200));
    }

    FetchStageService.prototype.fetchArtifact = origFetch;
  }

  // --- Test 2: FetcherAgent.loadFromDisk() silent ---
  {
    const fetcher = app.get(FetcherAgent);
    const cap = captureConsole();
    try {
      fetcher.loadFromDisk('WBP-TEST', 'jira', tmpDir, true);
    } finally {
      cap.restore();
    }

    const output = cap.getOutput();
    if (output.trim() === '') {
      pass('FetcherAgent.loadFromDisk() produces no output when silent');
    } else {
      fail('FetcherAgent.loadFromDisk() leaked output in silent mode', output.slice(0, 200));
    }
  }

  // --- Test 3: PlannerAgent.execute() silent ---
  {
    const planner = app.get(PlannerAgent);
    const origCreate = PlanStageService.prototype.createPlanArtifact;
    (PlanStageService.prototype as any).createPlanArtifact = async () => ({
      plan: MOCK_PLAN,
      action: 'fix',
      path: planPath,
      fromCache: false,
    });

    const cap = captureConsole();
    try {
      await planner.execute(
        {
          ticketKey: 'WBP-TEST',
          content: MOCK_TICKET_CONTENT,
          path: ticketPath,
        },
        { action: 'fix', silent: true }
      );
    } finally {
      cap.restore();
    }

    const output = cap.getOutput();
    if (output.trim() === '') {
      pass('PlannerAgent.execute() produces no output when silent');
    } else {
      fail('PlannerAgent.execute() leaked output in silent mode', output.slice(0, 200));
    }

    PlanStageService.prototype.createPlanArtifact = origCreate;
  }

  // --- Test 4: PlannerAgent.loadFromDisk() silent ---
  {
    const planner = app.get(PlannerAgent);
    const origLoad = PlanStageService.prototype.loadPlanArtifact;
    (PlanStageService.prototype as any).loadPlanArtifact = async () => ({
      plan: MOCK_PLAN,
      action: 'fix',
      path: planPath,
      fromCache: false,
    });

    const cap = captureConsole();
    try {
      await planner.loadFromDisk(ticketPath, 'fix', true);
    } finally {
      cap.restore();
    }

    const output = cap.getOutput();
    if (output.trim() === '') {
      pass('PlannerAgent.loadFromDisk() produces no output when silent');
    } else {
      fail('PlannerAgent.loadFromDisk() leaked output in silent mode', output.slice(0, 200));
    }

    PlanStageService.prototype.loadPlanArtifact = origLoad;
  }

  // --- Test 5: ReviewerAgent.execute() silent (no changes) ---
  {
    const reviewer = app.get(ReviewerAgent);
    const origGetStatus = GitService.prototype.getStatus;
    (GitService.prototype as any).getStatus = async () => ({ files: [] });

    const cap = captureConsole();
    try {
      await reviewer.execute(
        {
          ticketKey: 'WBP-TEST',
          content: MOCK_TICKET_CONTENT,
          path: ticketPath,
        },
        { silent: true }
      );
    } finally {
      cap.restore();
    }

    const output = cap.getOutput();
    if (output.trim() === '') {
      pass('ReviewerAgent.execute() produces no output when silent (no changes)');
    } else {
      fail('ReviewerAgent.execute() leaked output in silent mode', output.slice(0, 200));
    }

    GitService.prototype.getStatus = origGetStatus;
  }

  // --- Test 6: CommitterAgent.execute() silent (no changes) ---
  {
    const committer = app.get(CommitterAgent);
    const origGetStatus = GitService.prototype.getStatus;
    (GitService.prototype as any).getStatus = async () => ({ files: [] });

    const cap = captureConsole();
    try {
      await committer.execute('WBP-TEST', tmpDir, undefined, false, true);
    } finally {
      cap.restore();
    }

    const output = cap.getOutput();
    if (output.trim() === '') {
      pass('CommitterAgent.execute() produces no output when silent (no changes)');
    } else {
      fail('CommitterAgent.execute() leaked output in silent mode', output.slice(0, 200));
    }

    GitService.prototype.getStatus = origGetStatus;
  }

  // --- Test 7: FetcherAgent.execute() non-silent produces output ---
  {
    const fetcher = app.get(FetcherAgent);
    const origFetch = FetchStageService.prototype.fetchArtifact;
    (FetchStageService.prototype as any).fetchArtifact = async () => ({
      ticketKey: 'WBP-TEST',
      content: MOCK_TICKET_CONTENT,
      path: ticketPath,
      fromCache: false,
    });

    const cap = captureConsole();
    try {
      await fetcher.execute('WBP-TEST', {
        trackerName: 'jira',
        silent: false,
        baseDir: tmpDir,
      });
    } finally {
      cap.restore();
    }

    const output = cap.getOutput();
    if (output.includes('STAGE 1') && output.includes('Ticket fetched')) {
      pass('FetcherAgent.execute() produces output when not silent');
    } else {
      fail('FetcherAgent.execute() missing expected output when not silent', output.slice(0, 200));
    }

    FetchStageService.prototype.fetchArtifact = origFetch;
  }

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(path.join(wfHome, tmpBaseName), { recursive: true, force: true });
  await app.close();

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

testSilentModeAgents();
