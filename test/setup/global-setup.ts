import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Creates one directory that the whole test run writes into.
 *
 * Specs previously called `mkdtempSync` directly and mostly never removed the result: a
 * single run leaked roughly 500 directories, and 10,327 of them had accumulated in the
 * system temp directory. Rooting everything under one run-scoped directory means teardown
 * can remove the lot without having to find it.
 *
 * Runs in the main process before any worker starts, so the exported variable is inherited
 * by every worker.
 */
export default (): void => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-test-run-'));
  process.env['WF_TEST_RUN_DIR'] = runDir;
};
