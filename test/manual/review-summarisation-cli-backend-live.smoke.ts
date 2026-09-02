/**
 * Manual smoke test: oversized review diff summarisation uses the CLI backend and fails loudly
 *
 * Scenario: The review diff exceeds the summarisation threshold while
 * `stages.review.backend` is `cli`. The summarisation helper must route through
 * the CLI session, log failures with file-level detail when summarisation
 * breaks, and warn if the rebuilt diff is still oversized.
 *
 * Config under test:
 *   ```ts
 *   ai: [
 *     { provider: 'anthropic', model: 'claude-sonnet-4-6', default: true, apiKey: 'k' },
 *   ]
 *   stages: {
 *     review: { provider: 'anthropic', backend: 'cli' }
 *   }
 *   ```
 *
 * Verify:
 *   1. Oversized diff summarisation runs through the live CLI backend rather
 *      than a separate platform completion call.
 *   2. If one file summary fails, the live output logs the file name and the
 *      failure is visible in the review-stage warning stream.
 *   3. If the rebuilt diff still exceeds the threshold, the command emits the
 *      oversized-diff warning instead of silently proceeding.
 *   4. The review still completes with the raw patch content for the failed
 *      segment rather than aborting the whole review.
 *
 * Wire up: create a temp git repo with a single very large diff, then run the
 * compiled CLI in a live shell with a fake `claude` binary that can either
 * return a short bullet summary or force a failure on the summarisation turn.
 * Capture stdout and the review-stage log file so the live side effects can be
 * inspected without Jest mocks.
 *
 * Teardown: remove the temp repo, fake executable, captured logs, and isolated
 * HOME tree.
 */
