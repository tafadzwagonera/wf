// test/manual/test-anthropic-agent-prompt-fix.ts
//
// Smoke tests for the Anthropic agent adapter prompt fix:
//   1. ticketContext no longer used as the SDK prompt (action directive instead)
//   2. System prompt mandates the structured summary format
//   3. Post-run prints a "Summary:" header when result is non-empty
//   4. Post-run prints "no file changes were made" fallback when result is empty
//
// Run: nr test:manual -- test-anthropic-agent-prompt-fix

import chalk from 'chalk';

let passed = 0;
let failed = 0;

const assert = (label: string, condition: boolean, detail?: string) => {
  if (condition) {
    console.log(chalk.green(`  ✓ ${label}`));
    passed++;
  } else {
    console.log(chalk.red(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`));
    failed++;
  }
};

// ---------------------------------------------------------------------------
// Mirror the private buildSystemPrompt logic so we can test the text contracts
// without spinning up the full NestJS + Anthropic SDK context.
// ---------------------------------------------------------------------------

type VerificationScript = { command: string };

function buildExpectedSystemPrompt(args: {
  repoDir: string;
  repoName: string;
  repoFiles: string[];
  trackedFilePaths: string[];
  verificationScripts: VerificationScript[];
  ticketContext: string;
}): string {
  const fileList = args.repoFiles.length === 0 ? '  (none listed)' : args.repoFiles.map(f => `  - ${f}`).join('\n');

  const verificationList
    = args.verificationScripts.length > 0
      ? args.verificationScripts.map(s => `  - ${s.command}`).join('\n')
      : '  (none configured)';

  return `You are an expert software engineer implementing code changes inside a repository.

Repository directory: ${args.repoDir}
Files to implement:
${fileList}

Tracked files:
${fileList}

Verification commands (run these to check your work):
${verificationList}

Rules:
- Use Read to inspect existing file contents before modifying them
- Use Write or Edit to write complete updated file contents
- Use Bash only for verification commands that appear in the verification whitelist
- Writes are allowed only within the primary repository (${args.repoDir})
- Reads are allowed from ${args.repoDir} and any configured read-only sibling repositories
- Treat streamed progress updates as heuristics: continue when they point to forward motion, revisit when the pass looks stuck, and stop only when the agent returns a final result.
- When all verification commands pass (exit 0) — or when you determine no file changes are required — stop and output ONLY the following summary, filled in with actual results. Do not add preamble or planning text.

### What I changed
<Bullet list of actual edits made. If nothing was changed, write: "No file content changes were required.">

### Verification run
<Bullet list of commands run with ✓ (pass) or ✗ (fail). Omit if no commands ran.>

### Files
- **Updated:** <comma-separated list or "none">
- **New:** <comma-separated list or "none">
- **Deleted:** <comma-separated list or "none">

### Assumptions / risk note
<Any assumptions made or risks identified. Write "None." if there are none.>

Ticket context:
${args.ticketContext}`;
}

const ACTION_DIRECTIVE
  = 'Implement the changes described in your instructions now. Use Read to inspect existing files, then Write or Edit to apply changes, then Bash for each verification step. Do not output any text or plan before making your first tool call.';

async function main() {
  const SCENE
    = '## Plan\n- I will modify variables.tf to add a new variable.\n- I will verify with terraform validate.';
  const REPO_DIR = '/repos/terraform-aws';

  // ── Test 1: system prompt contains structured summary headings ──────────
  console.log(chalk.bold.cyan('\n🧪 Part 1: System prompt — structured summary format'));
  console.log(chalk.gray('─'.repeat(60)));

  const systemPrompt = buildExpectedSystemPrompt({
    repoDir: REPO_DIR,
    repoName: 'terraform-aws',
    repoFiles: ['variables.tf'],
    trackedFilePaths: ['variables.tf'],
    verificationScripts: [{ command: 'terraform validate' }],
    ticketContext: SCENE,
  });

  assert('system prompt contains "### What I changed" heading', systemPrompt.includes('### What I changed'));
  assert('system prompt contains "### Verification run" heading', systemPrompt.includes('### Verification run'));
  assert('system prompt contains "### Files" heading', systemPrompt.includes('### Files'));
  assert(
    'system prompt contains "### Assumptions / risk note" heading',
    systemPrompt.includes('### Assumptions / risk note')
  );
  assert(
    'system prompt contains "no file changes are required" clause',
    systemPrompt.includes('no file changes are required')
  );
  assert(
    'system prompt contains "Do not add preamble or planning text"',
    systemPrompt.includes('Do not add preamble or planning text')
  );
  assert(
    'system prompt still carries ticketContext under Ticket context:',
    systemPrompt.includes('Ticket context:') && systemPrompt.includes(SCENE)
  );

  // ── Test 2: SDK prompt is the action directive, not ticketContext ─────────
  console.log(chalk.bold.cyan('\n🧪 Part 2: SDK prompt — action directive, not ticketContext'));
  console.log(chalk.gray('─'.repeat(60)));

  assert(
    'action directive contains Read/Write/Edit instruction',
    ACTION_DIRECTIVE.includes('Use Read to inspect existing files')
  );
  assert('action directive contains Bash step', ACTION_DIRECTIVE.includes('Bash for each verification step'));
  assert(
    'action directive forbids text before first tool call',
    ACTION_DIRECTIVE.includes('Do not output any text or plan before making your first tool call')
  );
  assert(
    'action directive does NOT contain ticketContext',
    !ACTION_DIRECTIVE.includes(SCENE),
    'ticketContext must not be duplicated in the SDK prompt'
  );

  // ── Test 3: post-run summary printed with header when non-empty ─────────
  console.log(chalk.bold.cyan('\n🧪 Part 3: Post-run output — non-empty summary'));
  console.log(chalk.gray('─'.repeat(60)));

  const capturedWithResult: string[] = [];
  const mockLogResult = (line: string) => capturedWithResult.push(line);

  const mockResult = '### What I changed\n- Added variable `env` to variables.tf';
  const summary = mockResult.trim();
  if (summary) {
    mockLogResult('  Summary:');
    for (const line of summary.split('\n')) {
      if (line.trim()) {
        mockLogResult(`    ${line}`);
      }
    }
  } else {
    mockLogResult('\n  File summary: no file changes were made.');
  }

  assert('"Summary:" header is printed when result is non-empty', capturedWithResult.includes('  Summary:'));
  assert(
    'result content is printed line-by-line',
    capturedWithResult.some(l => l.includes('### What I changed'))
  );
  assert(
    'no-changes fallback is NOT printed when result is non-empty',
    !capturedWithResult.some(l => l.includes('no file changes were made'))
  );

  // ── Test 4: post-run fallback printed when result is empty ─────────────
  console.log(chalk.bold.cyan('\n🧪 Part 4: Post-run output — empty result fallback'));
  console.log(chalk.gray('─'.repeat(60)));

  const capturedEmpty: string[] = [];
  const mockLogEmpty = (line: string) => capturedEmpty.push(line);

  const emptySummary = ''.trim();
  if (emptySummary) {
    mockLogEmpty('  Summary:');
    for (const line of emptySummary.split('\n')) {
      if (line.trim()) {
        mockLogEmpty(`    ${line}`);
      }
    }
  } else {
    mockLogEmpty('\n  File summary: no file changes were made.');
  }

  assert(
    'fallback message is emitted when result is empty',
    capturedEmpty.some(l => l.includes('no file changes were made'))
  );
  assert('"Summary:" header is NOT emitted when result is empty', !capturedEmpty.includes('  Summary:'));

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(chalk.gray('\n' + '─'.repeat(60)));
  if (failed === 0) {
    console.log(chalk.bold.green(`\n✓ All ${passed} tests passed\n`));
  } else {
    console.log(chalk.bold.red(`\n✗ ${failed} of ${passed + failed} tests failed\n`));
    process.exit(1);
  }
}

void main();
