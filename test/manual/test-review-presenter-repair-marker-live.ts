/**
 * Manual smoke test: repaired review output surfaces the validation repair marker
 *
 * Scenario: The review pipeline repairs a parsed review payload through the
 * validation fallback path. The live terminal presenter must make that repair
 * explicit so the output does not look like a plain standard execution.
 *
 * Config under test:
 *   ```ts
 *   ai: [
 *     { provider: 'anthropic', model: 'claude-sonnet-4-6', default: true, apiKey: 'k' },
 *   ]
 *   stages: {
 *     review: { provider: 'anthropic', backend: 'standard' }
 *   }
 *   ```
 *
 * Verify:
 *   1. The live review output contains `Repair strategy: validation` when the
 *      review is repaired by schema validation.
 *   2. The review still prints the normal summary and approval state alongside
 *      the repair marker.
 *   3. The stored review artifact preserves `executionMode: 'standard'` so the
 *      presenter is not overstating CLI provenance.
 *
 * Wire up: run the compiled CLI against a temp git repo with a fake AI provider
 * or CLI shim that first returns a parseable-but-invalid review payload and then
 * returns a repaired payload that carries the validation repair path. Capture
 * the live terminal output from the command and confirm the repair note is
 * visible in the presenter output. Do not use Jest mocks for the presenter.
 *
 * Teardown: remove the temp repo, fake provider binary, and isolated HOME tree.
 */
