import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createReporter } from './support/reporter';

const { counts, pass, fail } = createReporter();

const assertEarlyExitOutcome = (outcome: { status: string }, startedAt: number): void => {
  if (outcome.status === 'passed' && Date.now() - startedAt < 5_000) {
    pass('Early exit returns before the sleeping command');
    return;
  }
  fail('Expected an early passed outcome', JSON.stringify(outcome));
};

const assertDescendantStopped = (pidPath: string): void => {
  const pid = Number(fs.readFileSync(pidPath, 'utf-8').trim());
  try {
    process.kill(pid, 0);
    fail('Descendant process survived early exit', String(pid));
  } catch {
    pass('Early exit terminates the descendant process');
  }
};

const run = async (): Promise<void> => {
  const pidPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-early-exit-')), 'child.pid');
  const { runProgrammaticVerification } = require('../../dist/integrations/ai/adapters/verification-report');
  const command = `sh -c 'sleep 30 & echo $! > "${pidPath}"; echo "Preparing the remote plan"; wait'`;
  const startedAt = Date.now();
  const [outcome] = await runProgrammaticVerification([
    { id: 'tf', name: 'tf', command, policy: 'enforced', aliases: [], earlyExitPattern: '(?:^|\\n)Preparing the remote plan' },
  ], process.cwd());
  assertEarlyExitOutcome(outcome, startedAt);
  assertDescendantStopped(pidPath);
};

run().then(() => process.exit(counts.failed > 0 ? 1 : 0)).catch(error => {
  fail('Early-exit smoke execution', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
