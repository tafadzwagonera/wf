# Structured Retry Failure Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `issue:implement` retries classify verification failures explicitly, narrow retry scope by failure class, and stop non-converging same-category retries earlier.

**Architecture:** Keep the existing two-phase retry loop in `ImplementerAgent`, but insert a typed classification layer between verification failure capture and retry regeneration. Classification produces retry state and scope, which feeds both retry-context generation and the AI diagnosis prompt. Existing progress tracking remains in place and is combined with category-aware stop and continue decisions.

**Tech Stack:** TypeScript, NestJS, Jest, `nest-commander`

---

## File Structure

- Modify: `src/agents/interfaces.ts`
  Add retry classification types and optional classification metadata to `FixPlan`.
- Modify: `src/agents/implementer.agent.ts`
  Add classification helpers, retry scope helpers, retry-state helpers, and integrate them into the existing retry loop.
- Modify: `src/integrations/ai/ai.service.ts`
  Extend `diagnoseVerificationFailure()` input and prompt wiring with classification metadata.
- Modify: `src/agents/implementer.agent.spec.ts`
  Add focused tests for classification, scope selection, and non-converging retry exits.
- Modify: `src/integrations/ai/ai.service.spec.ts`
  Add prompt-contract coverage for classification-aware diagnosis input.

### Task 1: Add Shared Retry Classification Types

**Files:**
- Modify: `src/agents/interfaces.ts`
- Test: `src/agents/implementer.agent.spec.ts`

- [ ] **Step 1: Add the failing test coverage shape in the implementer spec**

```ts
describe('retry classification', () => {
  it('classifies ESLint unused-variable failures as lint', () => {
    const classification = (agent as any).classifyVerificationFailure({
      results: [
        {
          command: 'npm run lint',
          exitCode: 1,
          stdout:
            "/tmp/repo-a/src/example.ts\n  1:7  error  'value' is assigned a value but never used  @typescript-eslint/no-unused-vars",
          stderr: '',
        },
      ],
    });

    expect(classification.category).toBe('lint');
    expect(classification.suggestedStrategy).toBe('surgical');
  });
});
```

- [ ] **Step 2: Run the targeted spec to verify it fails because classification types and helpers do not exist yet**

Run: `npm run test -- --runInBand src/agents/implementer.agent.spec.ts`
Expected: FAIL with missing `classifyVerificationFailure` or missing retry classification type usage

- [ ] **Step 3: Add the shared retry types in `src/agents/interfaces.ts`**

```ts
export type RetryFailureCategory =
  | 'lint'
  | 'typecheck'
  | 'test-compile'
  | 'test-runtime'
  | 'build'
  | 'unknown';

export type RetryScopeStrategy =
  | 'surgical'
  | 'paired-files'
  | 'broad-context';

export interface RetryFailureClassification {
  category: RetryFailureCategory;
  implicatedFiles: string[];
  companionFiles: string[];
  rootSignal: string;
  suggestedStrategy: RetryScopeStrategy;
  shouldRunDiagnosis: boolean;
}
```

- [ ] **Step 4: Extend `FixPlan` without breaking existing callers**

```ts
export interface FixPlan {
  summary: string;
  fixes: FixPlanEntry[];
  testContext?: string;
  classification?: {
    category: RetryFailureCategory;
    rootSignal: string;
    strategy: RetryScopeStrategy;
  };
}
```

- [ ] **Step 5: Run the targeted spec again and verify the next failure is now in the missing implementer helper, not the type layer**

Run: `npm run test -- --runInBand src/agents/implementer.agent.spec.ts`
Expected: FAIL on missing helper implementation, not on interface/type import errors

- [ ] **Step 6: Commit the type contract change**

```bash
git add src/agents/interfaces.ts src/agents/implementer.agent.spec.ts
git commit -m "feat(implementer): add retry classification contracts"
```

### Task 2: Classify Verification Failures and Compute Retry Scope

**Files:**
- Modify: `src/agents/implementer.agent.ts`
- Test: `src/agents/implementer.agent.spec.ts`

- [ ] **Step 1: Add failing tests for category detection and scope strategy**

```ts
it('classifies TS diagnostics reported during lint/build as typecheck', () => {
  const classification = (agent as any).classifyVerificationFailure({
    results: [
      {
        command: 'npm run build',
        exitCode: 1,
        stdout: 'src/example.ts:1:1 - error TS2339: Property x does not exist',
        stderr: '',
      },
    ],
  });

  expect(classification.category).toBe('typecheck');
  expect(classification.suggestedStrategy).toBe('paired-files');
});

it('classifies assertion failures as test-runtime', () => {
  const classification = (agent as any).classifyVerificationFailure({
    results: [
      {
        command: 'npm run test',
        exitCode: 1,
        stdout: 'FAIL src/example.spec.ts\nexpect(received).toBe(expected)',
        stderr: '',
      },
    ],
  });

  expect(classification.category).toBe('test-runtime');
});

it('keeps lint retries scoped to the implicated file', () => {
  const failure = {
    results: [
      {
        command: 'npm run lint',
        exitCode: 1,
        stdout:
          "/tmp/repo-a/src/example.ts\n  1:7  error  'value' is assigned a value but never used",
        stderr: '',
      },
    ],
  };

  const classification = (agent as any).classifyVerificationFailure(failure);
  const retryFiles = (agent as any).selectRetryRepoFiles({
    failure,
    classification,
    repoFiles: ['repo-a/src/example.ts', 'repo-a/src/example.spec.ts'],
    repoName: 'repo-a',
    repoDir: '/tmp/repo-a',
  });

  expect(retryFiles).toEqual(['repo-a/src/example.ts']);
});
```

- [ ] **Step 2: Run the implementer spec and verify the new tests fail**

Run: `npm run test -- --runInBand src/agents/implementer.agent.spec.ts`
Expected: FAIL because `classifyVerificationFailure()` and `selectRetryRepoFiles()` are not implemented

- [ ] **Step 3: Add the classification helpers in `src/agents/implementer.agent.ts`**

```ts
private classifyVerificationFailure(
  failure: VerificationFailure,
): RetryFailureClassification {
  const diagnosticText = failure.results
    .flatMap((result) => [result.stdout, result.stderr])
    .filter(Boolean)
    .join('\n');

  if (/@typescript-eslint\/|eslint/i.test(diagnosticText)) {
    return {
      category: 'lint',
      implicatedFiles: this.extractImplicatedFilesFromFailure(failure),
      companionFiles: [],
      rootSignal: 'eslint-diagnostic',
      suggestedStrategy: 'surgical',
      shouldRunDiagnosis: true,
    };
  }

  if (/FAIL .*\.spec|FAIL .*\.test|expect\(|received|toBe\(/i.test(diagnosticText)) {
    return {
      category: /TS\d{4}/.test(diagnosticText) ? 'test-compile' : 'test-runtime',
      implicatedFiles: this.extractImplicatedFilesFromFailure(failure),
      companionFiles: [],
      rootSignal: /TS\d{4}/.test(diagnosticText) ? 'jest-typescript' : 'jest-assertion',
      suggestedStrategy: 'paired-files',
      shouldRunDiagnosis: true,
    };
  }

  if (/TS\d{4}/.test(diagnosticText)) {
    return {
      category: 'typecheck',
      implicatedFiles: this.extractImplicatedFilesFromFailure(failure),
      companionFiles: [],
      rootSignal: 'typescript-diagnostic',
      suggestedStrategy: 'paired-files',
      shouldRunDiagnosis: true,
    };
  }

  if (/Cannot find module|Build failed|webpack|rollup|vite build/i.test(diagnosticText)) {
    return {
      category: 'build',
      implicatedFiles: this.extractImplicatedFilesFromFailure(failure),
      companionFiles: [],
      rootSignal: 'build-diagnostic',
      suggestedStrategy: 'broad-context',
      shouldRunDiagnosis: true,
    };
  }

  return {
    category: 'unknown',
    implicatedFiles: this.extractImplicatedFilesFromFailure(failure),
    companionFiles: [],
    rootSignal: 'unclassified-diagnostic',
    suggestedStrategy: 'broad-context',
    shouldRunDiagnosis: true,
  };
}
```

- [ ] **Step 4: Add a helper that derives retry scope from classification instead of raw inference alone**

```ts
private selectRetryRepoFiles(params: {
  failure: VerificationFailure;
  classification: RetryFailureClassification;
  repoFiles: string[];
  repoName: string;
  repoDir?: string;
}): string[] {
  const inferredFiles =
    this.inferRetryRepoFiles(
      params.failure,
      params.repoFiles,
      params.repoName,
      params.repoDir,
    ) ?? params.repoFiles;

  if (params.classification.category === 'lint') {
    return params.repoFiles.filter((filePath) =>
      params.classification.implicatedFiles.some((implicatedFile) =>
        filePath.endsWith(implicatedFile),
      ),
    );
  }

  if (
    params.classification.category === 'typecheck' ||
    params.classification.category === 'test-compile' ||
    params.classification.category === 'test-runtime'
  ) {
    return inferredFiles;
  }

  return inferredFiles;
}
```

- [ ] **Step 5: Add a small helper for implicated file extraction so classification and scope share the same file evidence**

```ts
private extractImplicatedFilesFromFailure(
  failure: VerificationFailure,
): string[] {
  return failure.results
    .flatMap((result) => [result.stdout, result.stderr])
    .filter(Boolean)
    .flatMap((output) =>
      output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /\.(ts|tsx|js|jsx|spec\.ts|test\.ts)/.test(line)),
    );
}
```

- [ ] **Step 6: Run the implementer spec and verify the new tests pass before integrating the retry loop**

Run: `npm run test -- --runInBand src/agents/implementer.agent.spec.ts`
Expected: PASS for the new helper-level tests

- [ ] **Step 7: Commit the helper layer**

```bash
git add src/agents/implementer.agent.ts src/agents/implementer.agent.spec.ts
git commit -m "feat(implementer): classify verification failures"
```

### Task 3: Integrate Retry Attempt State Into the Main Loop

**Files:**
- Modify: `src/agents/implementer.agent.ts`
- Test: `src/agents/implementer.agent.spec.ts`

- [ ] **Step 1: Add failing tests for repeated-category stop conditions and downgraded residual retries**

```ts
it('stops retrying when the same retry category and scope repeat without reduction', async () => {
  installMockRepoFiles();

  aiService.generateFileChange.mockResolvedValue('export const value = 1;\n');

  jest
    .spyOn(agent as any, 'runCommand')
    .mockResolvedValue({
      command: 'npm run lint',
      exitCode: 1,
      stdout:
        "/tmp/repo-a/src/example.ts\n  1:7  error  'value' is assigned a value but never used",
      stderr: '',
    });

  await expect(
    agent.execute(ticketArtifact, buildPlan(), {
      platformName: 'jira',
      repoDir: '/tmp/repo-a',
    }),
  ).rejects.toThrow(/same category.*scope.*repeat/i);
});
```

- [ ] **Step 2: Run the targeted spec and confirm it fails on current retry-loop behavior**

Run: `npm run test -- --runInBand src/agents/implementer.agent.spec.ts`
Expected: FAIL because the retry loop does not yet compare category and scope repetition

- [ ] **Step 3: Introduce local retry attempt state and feed classification into the loop**

```ts
let previousRetryState: RetryAttemptState | undefined;

const classification = this.classifyVerificationFailure(verificationFailure);
const nextRetryRepoFiles = this.selectRetryRepoFiles({
  failure: verificationFailure,
  classification,
  repoFiles,
  repoName,
  repoDir: options.repoDir,
});

const retryState: RetryAttemptState = {
  attemptNumber,
  classification,
  retryRepoFiles: nextRetryRepoFiles,
  trackedFilesChanged,
  repeatedCategory:
    previousRetryState?.classification.category === classification.category,
  repeatedScope:
    JSON.stringify(previousRetryState?.retryRepoFiles ?? []) ===
    JSON.stringify(nextRetryRepoFiles),
  repeatedFingerprint:
    previousFailureFingerprint === failureFingerprint,
};
```

- [ ] **Step 4: Replace direct `inferRetryRepoFiles()` assignment with classification-driven scope selection**

```ts
retryRepoFiles = retryState.retryRepoFiles.length
  ? retryState.retryRepoFiles
  : repoFiles;
```

- [ ] **Step 5: Add a focused stop helper that preserves existing progress extensions but rejects non-converging same-category loops**

```ts
private shouldStopForRepeatedRetryState(params: {
  retryState: RetryAttemptState;
  progress: VerificationProgress;
}): boolean {
  return (
    params.retryState.repeatedCategory &&
    params.retryState.repeatedScope &&
    params.retryState.repeatedFingerprint &&
    !params.progress.isMeaningful
  );
}
```

- [ ] **Step 6: Wire the stop helper into `execute()` before the retry budget extension branch**

```ts
if (
  this.shouldStopForRepeatedRetryState({
    retryState,
    progress,
  })
) {
  throw new Error(
    this.formatVerificationExitMessage({
      ticketKey: ticket.ticketKey,
      repoDir: options.repoDir,
      summary:
        'Verification retry stopped because the same category and retry scope repeated without meaningful reduction.',
      failure: verificationFailure,
    }),
  );
}
```

- [ ] **Step 7: Run the implementer spec and verify the retry-loop tests pass**

Run: `npm run test -- --runInBand src/agents/implementer.agent.spec.ts`
Expected: PASS for the new repeated-category retry tests

- [ ] **Step 8: Commit the loop integration**

```bash
git add src/agents/implementer.agent.ts src/agents/implementer.agent.spec.ts
git commit -m "feat(implementer): track structured retry state"
```

### Task 4: Pass Classification Into Diagnosis and Retry Context

**Files:**
- Modify: `src/agents/implementer.agent.ts`
- Modify: `src/integrations/ai/ai.service.ts`
- Test: `src/integrations/ai/ai.service.spec.ts`
- Test: `src/agents/implementer.agent.spec.ts`

- [ ] **Step 1: Add failing AI-service test coverage for classification-aware diagnosis prompts**

```ts
it('includes retry classification details in diagnoseVerificationFailure prompts', async () => {
  const adapter = createAdapter();
  const service = new AiService(mockLogger, adapter, createConfigService());

  await service.diagnoseVerificationFailure({
    implicatedFileContents: {},
    relatedFileContents: {},
    testSources: {},
    diagnostics: 'error',
    planSteps: ['Fix retry logic'],
    classification: {
      category: 'lint',
      implicatedFiles: ['src/example.ts'],
      companionFiles: [],
      rootSignal: 'eslint-diagnostic',
      suggestedStrategy: 'surgical',
      shouldRunDiagnosis: true,
    },
  });

  expect(adapter.execute).toHaveBeenCalledWith(
    expect.objectContaining({
      prompt: expect.stringContaining('Failure classification:'),
    }),
  );
});
```

- [ ] **Step 2: Run the AI-service spec and verify it fails because the new input field is unsupported**

Run: `npm run test -- --runInBand src/integrations/ai/ai.service.spec.ts`
Expected: FAIL on the missing `classification` parameter and prompt wiring

- [ ] **Step 3: Extend `diagnoseRetryFailure()` to pass classification explicitly**

```ts
const classification = this.classifyVerificationFailure(failure);

const fixPlan = await this.aiService.diagnoseVerificationFailure({
  implicatedFileContents,
  relatedFileContents,
  testSources,
  repoContext,
  diagnostics,
  planSteps,
  classification,
});
```

- [ ] **Step 4: Update `buildRetryContext()` so the next generation pass sees scope and class clearly**

```ts
const retryGuidance = [
  'Retry guidance:',
  `Failure category: ${classification.category}`,
  `Retry strategy: ${classification.suggestedStrategy}`,
  `Root signal: ${classification.rootSignal}`,
  'Treat verification diagnostics as evidence of a mismatch, not as the source of truth.',
  'Apply the minimum code change that fixes the diagnostic. Do not output explanation, reasoning, or commentary.',
  `Only update the implicated file(s) for this retry: ${relativeRetryFiles.join(', ')}`,
].join('\n');
```

- [ ] **Step 5: Extend `AiService.diagnoseVerificationFailure()` input and prompt**

```ts
async diagnoseVerificationFailure(params: {
  implicatedFileContents: Record<string, string>;
  relatedFileContents: Record<string, string>;
  testSources: Record<string, string>;
  repoContext?: {
    packageJson?: string;
    configFiles: Record<string, string>;
  };
  diagnostics: string;
  planSteps: string[];
  classification: RetryFailureClassification;
}): Promise<FixPlan> {
```

```ts
const prompt = `Plan steps:
${params.planSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

Failure classification:
- Category: ${params.classification.category}
- Strategy: ${params.classification.suggestedStrategy}
- Root signal: ${params.classification.rootSignal}
- Implicated files: ${params.classification.implicatedFiles.join(', ') || '(none)'}

Diagnostics:
${params.diagnostics}
`;
```

- [ ] **Step 6: Run both focused specs and verify the prompt-contract tests pass**

Run: `npm run test -- --runInBand src/agents/implementer.agent.spec.ts src/integrations/ai/ai.service.spec.ts`
Expected: PASS

- [ ] **Step 7: Commit the diagnosis wiring**

```bash
git add src/agents/implementer.agent.ts src/integrations/ai/ai.service.ts src/agents/implementer.agent.spec.ts src/integrations/ai/ai.service.spec.ts
git commit -m "feat(implementer): pass retry classification into diagnosis"
```

### Task 5: Verify the Whole Change Set

**Files:**
- Modify: `src/agents/interfaces.ts`
- Modify: `src/agents/implementer.agent.ts`
- Modify: `src/integrations/ai/ai.service.ts`
- Modify: `src/agents/implementer.agent.spec.ts`
- Modify: `src/integrations/ai/ai.service.spec.ts`

- [ ] **Step 1: Run the targeted tests for the touched areas**

Run: `npm run test -- --runInBand src/agents/implementer.agent.spec.ts src/integrations/ai/ai.service.spec.ts`
Expected: PASS

- [ ] **Step 2: Run the broader verification commands required for TypeScript changes**

Run: `npm run lint`
Expected: PASS

Run: `npm run test -- --runInBand`
Expected: PASS

- [ ] **Step 3: Inspect the diff to confirm the change stayed within the planned files**

Run: `git diff -- src/agents/interfaces.ts src/agents/implementer.agent.ts src/integrations/ai/ai.service.ts src/agents/implementer.agent.spec.ts src/integrations/ai/ai.service.spec.ts`
Expected: Only the planned classification, retry-state, and test updates appear

- [ ] **Step 4: Create the final commit**

```bash
git add src/agents/interfaces.ts src/agents/implementer.agent.ts src/integrations/ai/ai.service.ts src/agents/implementer.agent.spec.ts src/integrations/ai/ai.service.spec.ts
git commit -m "feat(implementer): add structured retry failure classification"
```

## Self-Review

- Spec coverage check:
  - classification model covered in Tasks 1 and 2
  - retry attempt state covered in Task 3
  - diagnosis prompt integration covered in Task 4
  - convergence and stop conditions covered in Tasks 3 and 5
- Placeholder scan:
  - no `TODO`, `TBD`, or “implement later” placeholders remain
  - each task references exact file paths and concrete commands
- Type consistency:
  - `RetryFailureCategory`, `RetryScopeStrategy`, `RetryFailureClassification`, and `FixPlan.classification` use one naming set throughout
