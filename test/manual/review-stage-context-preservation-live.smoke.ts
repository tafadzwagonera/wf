/**
 * Manual smoke test: replace-criteria review still preserves ticket context and Sonar findings
 *
 * Scenario: The user supplies `--replace-criteria` for review, and the review
 * stage also has additional context from the ticket summary and Sonar findings.
 * The replacement path must not drop those context sections before the review
 * prompt is sent.
 *
 * Config under test:
 *   ```ts
 *   ai: [
 *     { provider: 'anthropic', model: 'claude-sonnet-4-6', default: true, apiKey: 'k' },
 *   ]
 *   stages: {
 *     review: { provider: 'anthropic', backend: 'cli', sonar: true }
 *   }
 *   ```
 *
 * Verify:
 *   1. The live review prompt contains the custom replacement criteria file
 *      content.
 *   2. The same prompt still contains the ticket context section.
 *   3. When Sonar returns findings, the prompt also includes the Sonar findings
 *      text instead of discarding it.
 *   4. The review continues even if Sonar reports a recoverable CLI setup
 *      failure, and the live output warns instead of aborting the batch.
 *
 * Wire up: run `issue:review` against a temp git repo with a fake `claude`
 * binary that logs its stdin to disk, plus a fake Sonar executable or temp PATH
 * shim that can return either findings or a recoverable setup error. Inspect the
 * recorded prompt text from the live CLI run and assert that the replacement
 * criteria, ticket context, and Sonar findings all survive the request path.
 *
 * Teardown: delete the temp repo, fake binaries, prompt log, and isolated HOME
 * tree.
 */
