# Implement Verification Observability And Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `wf issue:implement` report its selected backend explicitly, persist machine-readable verification attempt artifacts, and use deterministic failure classification to narrow retries for parse failures.

**Architecture:** Keep the existing `ImplementerAgent` two-phase retry loop intact, but add a thin deterministic classification layer between verification failure capture and retry regeneration. Persist compact JSON artifacts for run-level and attempt-level observability, thread classification into retry prompts, and add one category-specific guardrail for repeated parse failures without redesigning the Anthropic agent backend.

**Tech Stack:** NestJS, TypeScript, Jest, Node.js filesystem utilities, existing `wf` config and AI service abstractions

---

### Task 1: Define Shared Types And Artifact Contracts

**Files:**
- Modify: `src/agents/interfaces.ts`
- Test: `src/agents/implementer.agent.spec.ts`

- [ ] **Step 1: Add the shared backend and classification types**

```ts
export type ImplementBackendName = 'two-phase' | 'anthropic-agent';

export interface ImplementBackendSelection {
  configured: ImplementBackendName;
  selected: ImplementBackendName;
  provider: string;
  fallbackReason?: string;
}

export type VerificationFailureCategory =
  | 'parse'
  | 'lint'
  | 'typecheck'
  | 'test-compile'
  | 'test-runtime'
  | 'build'
  | 'command'
  | 'unknown';

export type RetryScopeStrategy =
  | 'surgical'
  | 'paired-files'
  | 'broad-context';

export interface VerificationFailureClassification {
  category: VerificationFailureCategory;
  implicatedFiles: string[];
  companionFiles: string[];
  rootSignal: string;
  strategy: RetryScopeStrategy;
  confidence: 'high' | 'medium' | 'low';
}

export interface ImplementRunArtifact {
  ticketKey: string;
  repoDir: string;
  backendConfigured: ImplementBackendName;
  backendSelected: ImplementBackendName;
  provider: string;
  fallbackReason?: string;
  verificationScripts: Array<{ id: string; command: string }>;
  startedAt: string;
}

export interface VerificationAttemptArtifact {
  ticketKey: string;
  attemptNumber: number;
  backend: ImplementBackendName;
  command: string;
  exitCode: number;
  failed: boolean;
  classification: VerificationFailureClassification;
  fingerprint: string;
  progress: {
    advancedStage: boolean;
    reducedDiagnostics: boolean;
    narrowedFileSet: boolean;
  };
  retryScope: string[];
  createdAt: string;
}
```

- [ ] **Step 2: Extend `FixPlan` so retry diagnosis can receive classification context cleanly**

```ts
export interface FixPlan {
  summary: string;
  fixes: FixPlanEntry[];
  testContext?: string;
  classification?: {
    category: VerificationFailureCategory;
    rootSignal: string;
    strategy: RetryScopeStrategy;
  };
}
```

- [ ] **Step 3: Run the focused agent spec file to catch type drift early**

Run: `npm test -- --runInBand src/agents/implementer.agent.spec.ts`
Expected: existing failures are acceptable at this point, but there must be no TypeScript parse errors caused by `interfaces.ts`

- [ ] **Step 4: Commit the type-only change**

```bash
git add src/agents/interfaces.ts src/agents/implementer.agent.spec.ts
git commit -m "feat(agent): add implement verification artifact contracts"
```

### Task 2: Add Deterministic Classification And Artifact Helpers

**Files:**
- Create: `src/common/utils/implement-verification.ts`
- Test: `src/common/utils/implement-verification.spec.ts`

- [ ] **Step 1: Write the failing helper tests first**

```ts
describe('classifyVerificationFailure', () => {
  it('classifies prettier syntax failures as parse', () => {
    const result = classifyVerificationFailure({
      command: 'npm run format',
      stdout: '',
      stderr:
        "[error] src/example.spec.ts: SyntaxError: Unterminated template literal. (9:13)",
    });

    expect(result.category).toBe('parse');
    expect(result.implicatedFiles).toEqual(['src/example.spec.ts']);
    expect(result.strategy).toBe('surgical');
    expect(result.confidence).toBe('high');
  });

  it('classifies eslint unused-var failures as lint', () => {
    const result = classifyVerificationFailure({
      command: 'npm run lint:fix',
      stdout: '/tmp/repo/src/example.ts\n  4:7  error  x is assigned a value but never used',
      stderr: '',
    });

    expect(result.category).toBe('lint');
    expect(result.implicatedFiles).toEqual(['/tmp/repo/src/example.ts']);
  });
});

describe('writeImplementVerificationArtifact', () => {
  it('appends attempt records to a single run file', () => {
    writeImplementVerificationArtifact(mockPath, { attempts: [mockAttempt] });

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      mockPath,
      expect.stringContaining('"attemptNumber": 1'),
      'utf-8',
    );
  });
});
```

- [ ] **Step 2: Implement the pure helper module**

```ts
export const classifyVerificationFailure = (params: {
  command: string;
  stdout: string;
  stderr: string;
}): VerificationFailureClassification => {
  const output = `${params.stdout}\n${params.stderr}`;
  const implicatedFiles = extractDiagnosticFiles(output);

  if (/SyntaxError|Unterminated template literal|'\}' expected/i.test(output)) {
    return {
      category: 'parse',
      implicatedFiles,
      companionFiles: [],
      rootSignal: 'syntax-error',
      strategy: 'surgical',
      confidence: 'high',
    };
  }

  if (/eslint|no-unused-vars|prettier|code style/i.test(output)) {
    return {
      category: 'lint',
      implicatedFiles,
      companionFiles: [],
      rootSignal: 'lint-diagnostic',
      strategy: 'surgical',
      confidence: 'high',
    };
  }

  return {
    category: 'unknown',
    implicatedFiles,
    companionFiles: [],
    rootSignal: 'unclassified',
    strategy: 'broad-context',
    confidence: 'low',
  };
};
```

- [ ] **Step 3: Add backend selection summary formatting and append-only artifact writing helpers**

```ts
export const formatBackendSelection = (
  selection: ImplementBackendSelection,
): string =>
  `Implement backend: ${selection.selected} (configured: ${selection.configured}, provider: ${selection.provider}${selection.fallbackReason ? `, reason: ${selection.fallbackReason}` : ''})`;

export const appendAttemptArtifact = (
  existing: ImplementVerificationRunFile,
  attempt: VerificationAttemptArtifact,
): ImplementVerificationRunFile => ({
  ...existing,
  attempts: [...existing.attempts, attempt],
});
```

- [ ] **Step 4: Run the focused helper test file**

Run: `npm test -- --runInBand src/common/utils/implement-verification.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit the helper layer**

```bash
git add src/common/utils/implement-verification.ts src/common/utils/implement-verification.spec.ts
git commit -m "feat(agent): add verification classification helpers"
```

### Task 3: Wire Backend Selection And Run Artifacts Into `ImplementerAgent`

**Files:**
- Modify: `src/agents/implementer.agent.ts`
- Test: `src/agents/implementer.agent.spec.ts`

- [ ] **Step 1: Write the failing backend-selection tests**

```ts
describe('backend selection logging', () => {
  it('logs the selected anthropic-agent backend when enabled with anthropic provider', async () => {
    await agent.execute(ticketArtifact, buildPlan(), {
      platformName: 'jira',
      repoDir: '/tmp/repo-a',
    });

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Implement backend: anthropic-agent'),
    );
  });

  it('logs two-phase with a fallback reason when provider is not anthropic', async () => {
    await fallbackAgent.execute(ticketArtifact, buildPlan(), {
      platformName: 'jira',
      repoDir: '/tmp/repo-a',
    });

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('reason: provider mismatch'),
    );
  });
});
```

- [ ] **Step 2: Add a backend selection helper near the top of `ImplementerAgent`**

```ts
private resolveImplementBackendSelection(): ImplementBackendSelection {
  const experimentalAgent =
    this.configService.get<boolean>('stages.implement.experimentalAgent', false) === true;
  const provider = this.configService.get<string>('ai.provider', 'anthropic');

  if (!experimentalAgent) {
    return {
      configured: 'two-phase',
      selected: 'two-phase',
      provider,
    };
  }

  if (provider !== 'anthropic') {
    return {
      configured: 'anthropic-agent',
      selected: 'two-phase',
      provider,
      fallbackReason: 'provider mismatch',
    };
  }

  return {
    configured: 'anthropic-agent',
    selected: 'anthropic-agent',
    provider,
  };
}
```

- [ ] **Step 3: Log backend selection once and persist the run artifact before generation starts**

```ts
const backendSelection = this.resolveImplementBackendSelection();
console.log(chalk.cyan(`  ${formatBackendSelection(backendSelection)}`));

const runArtifactPath = this.getImplementArtifactPath(ticket.ticketKey, options.repoDir);
this.writeImplementRunArtifact(runArtifactPath, {
  ticketKey: ticket.ticketKey,
  repoDir: options.repoDir ?? process.cwd(),
  backendConfigured: backendSelection.configured,
  backendSelected: backendSelection.selected,
  provider: backendSelection.provider,
  fallbackReason: backendSelection.fallbackReason,
  verificationScripts: verificationScripts.map(({ id, command }) => ({ id, command })),
  startedAt: new Date().toISOString(),
});
```

- [ ] **Step 4: Replace the current inline backend gate with the helper result**

```ts
if (backendSelection.selected === 'anthropic-agent') {
  const adapter = new AnthropicAgentAdapter(this.configService);
  await adapter.generateAndVerify({
    ticket,
    planArtifact,
    options,
    verificationScripts,
    sceneContext,
    repoFiles,
    repoName,
    trackedFilePaths,
  });
  return { type: 'implementation', branchName };
}
```

- [ ] **Step 5: Run the focused implementer spec file**

Run: `npm test -- --runInBand src/agents/implementer.agent.spec.ts`
Expected: PASS

- [ ] **Step 6: Commit the backend observability wiring**

```bash
git add src/agents/implementer.agent.ts src/agents/implementer.agent.spec.ts
git commit -m "feat(agent): log implement backend selection"
```

### Task 4: Persist Attempt Artifacts And Classification-Aware Retry Context

**Files:**
- Modify: `src/agents/implementer.agent.ts`
- Modify: `src/integrations/ai/ai.service.ts`
- Modify: `src/integrations/ai/ai.service.spec.ts`
- Modify: `src/agents/implementer.agent.spec.ts`

- [ ] **Step 1: Write the failing retry artifact and diagnosis metadata tests**

```ts
it('persists a verification attempt artifact with classification and retry scope', async () => {
  await expect(
    agent.execute(ticketArtifact, buildPlan({ filesAffected: ['repo-a/src/example.ts'] }), {
      platformName: 'jira',
      repoDir: '/tmp/repo-a',
    }),
  ).rejects.toThrow();

  expect(fs.writeFileSync).toHaveBeenCalledWith(
    expect.stringContaining('implement-verification'),
    expect.stringContaining('"classification"'),
    'utf-8',
  );
});

it('passes classification metadata into diagnoseVerificationFailure', async () => {
  await (agent as any).diagnoseRetryFailure(
    mockFailure,
    ['repo-a/src/example.spec.ts'],
    'repo-a',
    ['Update example spec'],
    '/tmp/repo-a',
  );

  expect(aiService.diagnoseVerificationFailure).toHaveBeenCalledWith(
    expect.objectContaining({
      classification: expect.objectContaining({
        category: 'parse',
        strategy: 'surgical',
      }),
    }),
  );
});
```

- [ ] **Step 2: Classify failures immediately after verification fails and before retry diagnosis runs**

```ts
const classification = classifyVerificationFailure({
  command: verificationFailure.results[verificationFailure.results.length - 1]?.command ?? '',
  stdout: verificationFailure.results.map((result) => result.stdout).join('\n'),
  stderr: verificationFailure.results.map((result) => result.stderr).join('\n'),
});
```

- [ ] **Step 3: Persist a compact attempt artifact before any retry mutation**

```ts
this.appendVerificationAttemptArtifact(runArtifactPath, {
  ticketKey: ticket.ticketKey,
  attemptNumber,
  backend: backendSelection.selected,
  command: failingResult.command,
  exitCode: failingResult.exitCode,
  failed: true,
  classification,
  fingerprint: failureFingerprint,
  progress: {
    advancedStage: progress.advancedStage,
    reducedDiagnostics: progress.reducedDiagnostics,
    narrowedFileSet: progress.narrowedFileSet,
  },
  retryScope: retryRepoFiles,
  createdAt: new Date().toISOString(),
});
```

- [ ] **Step 4: Extend `diagnoseRetryFailure()` and `buildRetryContext()` to receive classification**

```ts
const fixPlan = await this.aiService.diagnoseVerificationFailure({
  implicatedFileContents,
  relatedFileContents,
  testSources,
  repoContext,
  diagnostics,
  planSteps,
  classification: {
    category: classification.category,
    rootSignal: classification.rootSignal,
    strategy: classification.strategy,
  },
});
```

```ts
return `${baseContext}

Latest verification failure category: ${classification.category}
Root signal: ${classification.rootSignal}
Retry scope strategy: ${classification.strategy}
Implicated files:
${classification.implicatedFiles.map((file) => `- ${file}`).join('\n') || '- (none)'}

If the failure is parse or lint scoped, do not broaden edits beyond the implicated files unless the diagnostics require it.`;
```

- [ ] **Step 5: Update `AiService` prompt and tests to include classification metadata**

```ts
const prompt = `Plan steps:
${params.planSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

Failure classification:
- Category: ${params.classification?.category ?? 'unknown'}
- Root signal: ${params.classification?.rootSignal ?? 'n/a'}
- Retry strategy: ${params.classification?.strategy ?? 'broad-context'}

Diagnostics:
${params.diagnostics}
`;
```

- [ ] **Step 6: Run the focused unit tests**

Run: `npm test -- --runInBand src/agents/implementer.agent.spec.ts src/integrations/ai/ai.service.spec.ts`
Expected: PASS

- [ ] **Step 7: Commit the retry observability wiring**

```bash
git add src/agents/implementer.agent.ts src/agents/implementer.agent.spec.ts src/integrations/ai/ai.service.ts src/integrations/ai/ai.service.spec.ts
git commit -m "feat(agent): persist verification retry artifacts"
```

### Task 5: Add Parse-Failure Narrowing And Early Stop Guardrail

**Files:**
- Modify: `src/agents/implementer.agent.ts`
- Modify: `src/agents/implementer.agent.spec.ts`

- [ ] **Step 1: Write failing specs for parse-specific narrowing and early exit**

```ts
describe('parse failure guardrail', () => {
  it('pins retry scope to the implicated parse file and companion', () => {
    const result = (agent as any).selectRetryRepoFiles({
      currentRetryRepoFiles: [
        'repo-a/src/example.spec.ts',
        'repo-a/src/example.ts',
        'repo-a/src/extra.ts',
      ],
      repoFiles: [
        'repo-a/src/example.spec.ts',
        'repo-a/src/example.ts',
        'repo-a/src/extra.ts',
      ],
      repoName: 'repo-a',
      repoDir: '/tmp/repo-a',
      failure: parseFailure,
      classification: {
        category: 'parse',
        implicatedFiles: ['repo-a/src/example.spec.ts'],
        companionFiles: ['repo-a/src/example.ts'],
        rootSignal: 'syntax-error',
        strategy: 'surgical',
        confidence: 'high',
      },
      fixPlan: undefined,
    });

    expect(result).toEqual([
      'repo-a/src/example.spec.ts',
      'repo-a/src/example.ts',
    ]);
  });

  it('stops early when the same parse fingerprint repeats without progress', async () => {
    await expect(runRepeatedParseFailureScenario()).rejects.toThrow(
      'Repeated parse failure fingerprint',
    );
  });
});
```

- [ ] **Step 2: Add parse-aware branching to retry scope selection**

```ts
if (classification.category === 'parse' && classification.implicatedFiles.length > 0) {
  const parseScope = new Set([
    ...classification.implicatedFiles,
    ...classification.companionFiles,
  ]);
  return repoFiles.filter((file) => parseScope.has(file));
}
```

- [ ] **Step 3: Add early-stop logic before spending another retry on identical parse failures**

```ts
if (
  classification.category === 'parse' &&
  previousClassification?.category === 'parse' &&
  previousFailureFingerprint === failureFingerprint &&
  sameImplicatedFileSet(previousClassification.implicatedFiles, classification.implicatedFiles)
) {
  throw new Error(
    this.formatVerificationExitMessage({
      ticketKey: ticket.ticketKey,
      repoDir: options.repoDir,
      summary: 'Repeated parse failure fingerprint on the same file set. User intervention is required.',
      failure: verificationFailure,
    }),
  );
}
```

- [ ] **Step 4: Update retry context text to force surgical parse repair**

```ts
if (classification.category === 'parse') {
  retryLines.push(
    'This is a parse-repair retry. Fix the syntax error first and do not rewrite unrelated files.',
  );
}
```

- [ ] **Step 5: Run the focused implementer spec file again**

Run: `npm test -- --runInBand src/agents/implementer.agent.spec.ts`
Expected: PASS

- [ ] **Step 6: Commit the parse guardrail**

```bash
git add src/agents/implementer.agent.ts src/agents/implementer.agent.spec.ts
git commit -m "feat(agent): narrow parse verification retries"
```

### Task 6: Add Minimal Anthropic Adapter Parity And Final Verification

**Files:**
- Modify: `src/integrations/ai/adapters/anthropic-agent.adapter.ts`
- Modify: `src/integrations/ai/adapters/anthropic-agent.adapter.spec.ts`

- [ ] **Step 1: Add a focused adapter test for run artifact compatibility**

```ts
it('can reuse the implement run artifact metadata when the anthropic backend is selected', async () => {
  await adapter.generateAndVerify(makeParams());

  expect(fs.writeFileSync).not.toHaveBeenCalledWith(
    expect.anything(),
    expect.stringContaining('"attemptNumber": 1'),
    'utf-8',
  );
});
```

- [ ] **Step 2: Keep adapter changes minimal**

```ts
// Only consume shared backend metadata or shared artifact helpers when they
// can be passed in without changing the agent loop contract.
```

- [ ] **Step 3: Run the targeted adapter tests**

Run: `npm test -- --runInBand src/integrations/ai/adapters/anthropic-agent.adapter.spec.ts`
Expected: PASS

- [ ] **Step 4: Run the full verification stack**

Run: `npm run lint`
Expected: PASS

Run: `npm test -- --runInBand src/common/utils/implement-verification.spec.ts src/agents/implementer.agent.spec.ts src/integrations/ai/ai.service.spec.ts src/integrations/ai/adapters/anthropic-agent.adapter.spec.ts`
Expected: PASS

Run: `npm run build`
Expected: PASS

- [ ] **Step 5: Commit the final integrated change**

```bash
git add src/integrations/ai/adapters/anthropic-agent.adapter.ts src/integrations/ai/adapters/anthropic-agent.adapter.spec.ts
git commit -m "feat(agent): classify implement verification failures"
```

## Spec Coverage Check

- Backend selection terminal logging: covered by Task 3.
- Persisted run artifact: covered by Task 3.
- Persisted per-attempt verification artifacts: covered by Task 4.
- Deterministic failure classification: covered by Task 2 and Task 4.
- Parse-only behavioral guardrail: covered by Task 5.
- Minimal Anthropic backend scope: covered by Task 6.

## Placeholder Scan

- No `TODO`, `TBD`, or “implement later” placeholders remain.
- All file paths are concrete.
- All verification commands are explicit.

## Type Consistency Check

- Shared names are consistent across tasks:
  - `ImplementBackendSelection`
  - `VerificationFailureClassification`
  - `classifyVerificationFailure`
  - `formatBackendSelection`
  - `appendVerificationAttemptArtifact`
