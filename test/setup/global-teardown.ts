import * as fs from 'node:fs';

/**
 * Removes the run-scoped directory created by `global-setup`.
 *
 * `force` so a run that created nothing still exits cleanly, and the whole teardown is
 * best-effort: failing to tidy up temporary files should never fail an otherwise green run.
 */
export default (): void => {
  const runDir = process.env['WF_TEST_RUN_DIR'];
  if (!runDir) return;
  try {
    fs.rmSync(runDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; the OS reclaims the temp directory regardless.
  }
};
