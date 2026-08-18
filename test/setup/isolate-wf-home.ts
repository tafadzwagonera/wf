import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Redirects the wf home directory for the whole test run.
 *
 * Without this, every spec that logs appends to the real `~/.wf/logs/agent-<date>.log`.
 * A single command spec added ~8KB of fixture noise per run, and 99.7% of the records in a
 * day's production log turned out to be test doubles rather than real CLI activity — which
 * made that log close to useless when it was needed to diagnose a live incident.
 *
 * Runs as a `setupFiles` entry so the variable is in place before any module reads it.
 */
// A fixed name, not mkdtemp: this file runs once per spec file, so a unique directory per
// invocation would leave one temp tree per suite behind on every run.
// Ends in `.wf` so assertions that match on the conventional path segment still hold.
const wfHome = path.join(os.tmpdir(), 'wf-test-home', '.wf');

fs.mkdirSync(wfHome, { recursive: true });
process.env['WF_HOME'] = wfHome;
