import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Creates temporary directories that clean themselves up.
 *
 * Specs calling `fs.mkdtempSync` directly leaked roughly 500 directories per run, because
 * cleanup was left to each spec to remember and eight spec files never did. Directories
 * created through this helper are rooted in the run-scoped directory that global teardown
 * removes, and are also removed when the spec file finishes — whichever happens first.
 *
 * Cleanup is registered per importing spec file via `afterAll` rather than `afterEach`, so a
 * directory created once in `beforeAll` survives for every test in the file.
 */

const created: string[] = [];

/** Root for test scratch space: the run-scoped directory when present, else the system temp dir. */
const tempRoot = (): string => process.env['WF_TEST_RUN_DIR'] ?? os.tmpdir();

/**
 * Creates a uniquely-named temporary directory that is removed when the spec file ends.
 *
 * @param prefix - Short label included in the directory name, to make stray dirs traceable
 * @returns Absolute path to the created directory
 */
export const createTempDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(tempRoot(), `wf-${prefix}-`));
  created.push(dir);
  return dir;
};

/** Removes every directory this helper created. Exposed for specs that clean up mid-file. */
export const removeCreatedTempDirs = (): void => {
  while (created.length > 0) {
    const dir = created.pop();
    if (!dir) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort: a spec that already removed its own directory must not fail the run.
    }
  }
};

afterAll(removeCreatedTempDirs);
