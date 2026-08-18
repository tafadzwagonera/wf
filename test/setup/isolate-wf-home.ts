import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Redirects the wf home directory for the whole test run.
 *
 * Without this, every spec that logs appends to the real `~/.wf/logs/agent-<date>.log`. A
 * single command spec added ~8KB of fixture noise per run, and 99.7% of the records in a
 * day's production log turned out to be test doubles rather than real CLI activity — which
 * made that log close to useless when it was needed to diagnose a live incident.
 *
 * Rooted in the run-scoped directory from `global-setup` so teardown removes it; falls back
 * to a fixed temp path when run without the global hooks, which keeps a stray directory per
 * run rather than one per spec file.
 *
 * Runs as a `setupFiles` entry so the variable is in place before any module reads it.
 * The directory ends in `.wf` so assertions matching the conventional path segment hold.
 */
const runDir = process.env['WF_TEST_RUN_DIR'] ?? path.join(os.tmpdir(), 'wf-test-home');
const wfHome = path.join(runDir, '.wf');

fs.mkdirSync(wfHome, { recursive: true });
process.env['WF_HOME'] = wfHome;
