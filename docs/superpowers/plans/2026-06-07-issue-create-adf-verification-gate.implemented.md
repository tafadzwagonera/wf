# issue:create ADF Verification Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pre-send validation gate to `issue:create` that catches wiki markup leaks in the ADF payload, with an AI self-correction loop that regenerates the description when validation fails.

**Architecture:** A shared validation script (`test-verify-request-format.ts`) reads a Jira ADF payload from stdin and outputs structured JSON diagnostics. The `issue:create` command spawns this script after building the payload; if it fails and `maxAttempts > 1`, the command calls `AiService.executeWithHistory()` to regenerate the markdown, re-validates, and repeats up to `maxAttempts` times. The same script replaces hardcoded assertions in `test-issue-update-jira-adf-smoke.ts`.

**Tech Stack:** TypeScript 5.7, Node.js 22, NestJS 11, nest-commander, Jest 30

**Spec:** `docs/superpowers/specs/2026-06-04-issue-create-adf-verification-gate-design.md`

---

### Task 1: Fix `{{monospace}}` gap on the WRITE path

The WRITE normalizer (`normalizeMarkdownForADF`) does not convert `{{text}}` → `` `text` ``. This is the remaining conversion gap that leaks wiki markup into ADF text nodes.

**Files:**
- Modify: `src/integrations/jira/jira.service.ts:23-36`
- Modify: `src/integrations/jira/jira.service.spec.ts:831-845`

- [ ] **Step 1: Write the failing test**

Add a test after the existing `{noformat}` write-path tests in `src/integrations/jira/jira.service.spec.ts` (after line 845):

```typescript
it('should handle {{monospace}} on write path via normalizeMarkdownForADF', () => {
  const markdown = 'The {{bufferPx}} variable controls spacing.';
  const adf = service.markdownToADF(markdown);
  const nodes = JSON.stringify(adf);
  expect(nodes).not.toContain('{{');
  expect(nodes).not.toContain('}}');
  expect(nodes).toContain('code');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/integrations/jira/jira.service.spec.ts --no-coverage -t "monospace"`
Expected: FAIL — `{{bufferPx}}` passes through as literal text.

- [ ] **Step 3: Add `{{text}}` replacement to `normalizeMarkdownForADF`**

In `src/integrations/jira/jira.service.ts`, add a fourth replacement after line 35 (the `* ` bullet replacement):

```typescript
const normalizeMarkdownForADF = (markdown: string): string =>
  markdown
    .replace(
      /\{code(?::([^}\n]+))?\}([\s\S]*?)\{code\}/g,
      (_match, language: string | undefined, code: string) => {
        const lang = language?.trim() ?? '';
        return `\`\`\`${lang}\n${code.trim()}\n\`\`\``;
      },
    )
    .replace(
      /\{noformat\}([\s\S]*?)\{noformat\}/g,
      (_match, content: string) => `\`\`\`\n${content.trim()}\n\`\`\``,
    )
    .replace(/^[ \t]*\*\s+/gm, '- ')
    .replace(/\{\{([^}]+)\}\}/g, (_match, content: string) => `\`${content}\``);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/integrations/jira/jira.service.spec.ts --no-coverage`
Expected: All tests pass including the new `{{monospace}}` test.

- [ ] **Step 5: Run manual smoke tests to verify no regressions**

Run: `npx ts-node test/manual/test-adf-to-markdown-regression.ts && npx ts-node test/manual/test-adf-to-markdown-wiki-normalization.ts`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/integrations/jira/jira.service.ts src/integrations/jira/jira.service.spec.ts
git commit -m "fix(jira): normalize {{monospace}} on write path in normalizeMarkdownForADF"
```

---

### Task 2: Add `maxAttempts` to config types

**Files:**
- Modify: `src/config/public-config.ts:31-34`
- Modify: `src/config/public-config.ts:41-44`
- Modify: `src/config/public-config.ts:95-100`
- Modify: `src/config/wf-config-loader.ts:33-38`
- Modify: `src/config/wf-config-loader.ts:57-60`
- Modify: `src/config/wf-config-loader.ts:62-68`
- Modify: `src/config/wf-config-loader.ts:98-104`
- Modify: `src/config/wf-config-loader.ts:659-669`
- Modify: `src/config/wf-config-loader.ts:870-876`
- Test: `src/config/wf-config-loader.spec.ts`

- [ ] **Step 1: Write the failing test**

Add a test to `src/config/wf-config-loader.spec.ts`:

```typescript
it('should normalize create stage with verificationConditions and maxAttempts', async () => {
  const config = await loadAndNormalizeConfig({
    ai: [{ provider: 'openai', model: 'gpt-5.4-mini', default: true }],
    stages: {
      create: {
        provider: 'openai',
        verificationConditions: {
          maxAttempts: 3,
          scripts: { format: 'nr test:manual -- test-verify-request-format' },
        },
      },
    },
  });

  expect(config.stages.create).toBeDefined();
  expect(config.stages.create!.provider).toBe('openai');
  expect(config.stages.create!.verificationConditions).toEqual({
    maxAttempts: 3,
    policyFile: undefined,
    scripts: { format: 'nr test:manual -- test-verify-request-format' },
  });
});

it('should default maxAttempts to 1 when not specified', async () => {
  const config = await loadAndNormalizeConfig({
    ai: [{ provider: 'openai', model: 'gpt-5.4-mini', default: true }],
    stages: {
      create: {
        provider: 'openai',
        verificationConditions: {
          scripts: { format: 'nr test:manual -- test-verify-request-format' },
        },
      },
    },
  });

  expect(config.stages.create!.verificationConditions!.maxAttempts).toBe(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/config/wf-config-loader.spec.ts --no-coverage -t "create stage"`
Expected: FAIL — `create` is not a recognized stage.

- [ ] **Step 3: Add `maxAttempts` to `WfVerificationConditionsConfig`**

In `src/config/public-config.ts`, update the interface at line 31:

```typescript
export interface WfVerificationConditionsConfig {
  maxAttempts?: number;
  policyFile?: string;
  scripts?: Record<string, string>;
}
```

- [ ] **Step 4: Add `WfCreateStageConfig` and extend `stages` union**

In `src/config/public-config.ts`, add after line 44:

```typescript
export interface WfCreateStageConfig extends WfAiStageTargetConfig {
  verificationConditions?: WfVerificationConditionsConfig;
}
```

Update the `stages` property in `WfConfig` (line 95-100):

```typescript
  stages?: Partial<
    Record<'plan' | 'review' | 'generate' | 'commit', WfAiStageTargetConfig>
  > & {
    create?: WfCreateStageConfig;
    implement?: WfImplementStageConfig;
    fetch?: string;
  };
```

- [ ] **Step 5: Extend `wf-config-loader.ts` normalized types**

In `src/config/wf-config-loader.ts`:

Add `'create'` to `SupportedStageName` (line 33-38):

```typescript
type SupportedStageName =
  | 'plan'
  | 'implement'
  | 'review'
  | 'generate'
  | 'commit'
  | 'create';
```

Add `maxAttempts` to `NormalizedVerificationConditionsConfig` (line 57-60):

```typescript
export interface NormalizedVerificationConditionsConfig {
  maxAttempts: number;
  policyFile?: string;
  scripts: Record<string, string>;
}
```

Add `NormalizedCreateStageConfig` after `NormalizedImplementStageConfig` (after line 68):

```typescript
export interface NormalizedCreateStageConfig {
  provider: WfAiProviderName;
  model: string;
  agent: boolean;
  verificationConditions?: NormalizedVerificationConditionsConfig;
}
```

Add `create` to `NormalizedWfConfig.stages` (line 98-104):

```typescript
  stages: {
    plan?: NormalizedAiStageTargetConfig;
    implement?: NormalizedImplementStageConfig;
    create?: NormalizedCreateStageConfig;
    review?: NormalizedAiStageTargetConfig;
    generate?: NormalizedAiStageTargetConfig;
    commit?: NormalizedAiStageTargetConfig;
  };
```

- [ ] **Step 6: Normalize `maxAttempts` with default**

Update `normalizeVerificationConditionsConfig` (line 659-669):

```typescript
const normalizeVerificationConditionsConfig = (
  config?: WfVerificationConditionsConfig,
): NormalizedVerificationConditionsConfig | undefined => {
  if (!config) {
    return undefined;
  }

  return {
    maxAttempts: config.maxAttempts ?? 1,
    policyFile: config.policyFile,
    scripts: config.scripts ?? {},
  };
};
```

- [ ] **Step 7: Add create stage normalization and wire into output**

Add a `normalizedCreateStage` block near the `normalizedImplementStage` block (after line 837), following the same IIFE pattern:

```typescript
  const normalizedCreateStage = (() => {
    const createStageConfig = validatedConfig.stages?.create as
      | import('./public-config').WfCreateStageConfig
      | undefined;

    if (!createStageConfig) {
      return undefined;
    }

    const createTarget = normalizeStageTarget({
      stageName: 'create',
      stageTarget: createStageConfig,
      configuredProviderNames,
      configuredProvidersByName,
    });

    if (!createTarget) {
      return undefined;
    }

    return {
      ...createTarget,
      verificationConditions: normalizeVerificationConditionsConfig(
        createStageConfig.verificationConditions,
      ),
    };
  })();
```

Add `create: normalizedCreateStage` to the `stages` object at line 870-876:

```typescript
    stages: {
      plan: aiStages.plan,
      implement: normalizedImplementStage,
      create: normalizedCreateStage,
      review: aiStages.review,
      generate: aiStages.generate,
      commit: aiStages.commit,
    },
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx jest src/config/wf-config-loader.spec.ts --no-coverage`
Expected: All tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/config/public-config.ts src/config/wf-config-loader.ts src/config/wf-config-loader.spec.ts
git commit -m "feat(config): add create stage with maxAttempts in verificationConditions"
```

---

### Task 3: Add `'create'` to `AIConversationRequest.stage`

**Files:**
- Modify: `src/integrations/ai/ai.service.ts:291`

- [ ] **Step 1: Extend the stage union**

In `src/integrations/ai/ai.service.ts`, update line 291:

```typescript
  stage?: 'plan' | 'implement' | 'review' | 'generate' | 'commit' | 'create';
```

- [ ] **Step 2: Run typecheck to verify no errors**

Run: `npx tsc --noEmit`
Expected: Clean exit.

- [ ] **Step 3: Commit**

```bash
git add src/integrations/ai/ai.service.ts
git commit -m "feat(ai): add create stage to AIConversationRequest"
```

---

### Task 4: Create the validation script `test-verify-request-format.ts`

**Files:**
- Create: `test/manual/test-verify-request-format.ts`

- [ ] **Step 1: Create the validation script**

Create `test/manual/test-verify-request-format.ts`:

```typescript
/**
 * ADF Request Format Validator
 *
 * Run: echo '{"fields":{"description":{...}}}' | nr test:manual -- test-verify-request-format
 *
 * Reads a serialized Jira REST payload (or bare ADF doc) from stdin,
 * walks the node tree, and outputs structured JSON diagnostics.
 * Exits 0 when valid, 1 when issues are found.
 */

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  [key: string]: unknown;
}

interface ValidationIssue {
  error: string;
  suggestion: string;
}

interface ValidationResult {
  passed: boolean;
  issues: ValidationIssue[];
}

const RULES: Array<{
  pattern: RegExp;
  error: (path: string) => string;
  suggestion: string;
}> = [
  {
    pattern: /\{code(?::[^}]*)?\}/,
    error: (p) => `raw \`{code}\` marker in text node at \`${p}\``,
    suggestion:
      'Replace `{code:lang}...{code}` with markdown code fences: ```lang\\n...\\n```',
  },
  {
    pattern: /\{noformat\}/,
    error: (p) => `raw \`{noformat}\` marker in text node at \`${p}\``,
    suggestion:
      'Replace `{noformat}...{noformat}` with markdown code fences: ```\\n...\\n```',
  },
  {
    pattern: /\{\{[^}]+\}\}/,
    error: (p) => `raw \`{{...}}\` marker in text node at \`${p}\``,
    suggestion: 'Replace `{{text}}` with markdown inline code: `text`',
  },
  {
    pattern: /^\*\s+/m,
    error: (p) => `raw \`* \` bullet marker in text node at \`${p}\``,
    suggestion:
      'Replace wiki `* item` with markdown `- item` at line start',
  },
];

const walkNodes = (
  node: AdfNode,
  path: string,
  issues: ValidationIssue[],
): void => {
  if (node.type === 'text' && typeof node.text === 'string') {
    for (const rule of RULES) {
      if (rule.pattern.test(node.text)) {
        issues.push({
          error: rule.error(path),
          suggestion: rule.suggestion,
        });
      }
    }
  }

  if (Array.isArray(node.content)) {
    node.content.forEach((child, i) => {
      walkNodes(child, `${path}.content[${i}]`, issues);
    });
  }
};

const validate = (input: unknown): ValidationResult => {
  const issues: ValidationIssue[] = [];

  // Accept both { fields: { description } } and bare ADF doc
  let doc: AdfNode;
  const asPayload = input as { fields?: { description?: AdfNode } };
  if (asPayload?.fields?.description) {
    doc = asPayload.fields.description;
  } else {
    doc = input as AdfNode;
  }

  if (doc?.type !== 'doc') {
    issues.push({
      error: 'ADF root node is not `type: "doc"`',
      suggestion:
        'Description must be a valid ADF document with `type: "doc"`',
    });
    return { passed: false, issues };
  }

  if (!Array.isArray(doc.content) || doc.content.length === 0) {
    issues.push({
      error: 'ADF document has no block nodes in `content`',
      suggestion:
        'Description must contain at least one block node (paragraph, heading, etc.)',
    });
    return { passed: false, issues };
  }

  walkNodes(doc, 'doc', issues);

  return { passed: issues.length === 0, issues };
};

const main = (): void => {
  const chunks: Buffer[] = [];

  process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));

  process.stdin.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf-8').trim();

    if (!raw) {
      const result: ValidationResult = {
        passed: false,
        issues: [
          {
            error: 'No input received on stdin',
            suggestion:
              'Pipe a JSON payload to stdin: echo \'{"fields":...}\' | nr test:manual -- test-verify-request-format',
          },
        ],
      };
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      process.exit(1);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const result: ValidationResult = {
        passed: false,
        issues: [
          {
            error: 'Invalid JSON on stdin',
            suggestion: 'Input must be valid JSON',
          },
        ],
      };
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      process.exit(1);
    }

    const result = validate(parsed);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.passed ? 0 : 1);
  });
};

main();
```

- [ ] **Step 2: Test with a known-bad payload**

Run:
```bash
echo '{"fields":{"description":{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"The {{bufferPx}} variable and {noformat}raw{noformat} text."}]}]}}}' | npx ts-node test/manual/test-verify-request-format.ts
```
Expected: Exit 1, JSON output with `passed: false` and issues for `{{...}}` and `{noformat}`.

- [ ] **Step 3: Test with a known-good payload**

Run:
```bash
echo '{"fields":{"description":{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"Clean text here."}]}]}}}' | npx ts-node test/manual/test-verify-request-format.ts
```
Expected: Exit 0, `{ "passed": true, "issues": [] }`.

- [ ] **Step 4: Commit**

```bash
git add test/manual/test-verify-request-format.ts
git commit -m "feat(validation): add ADF request format validator script"
```

---

### Task 5: Wire the validation gate into `issue:create`

**Files:**
- Modify: `src/commands/issue-create.command.ts:1-16` (imports)
- Modify: `src/commands/issue-create.command.ts:221-231` (constructor)
- Modify: `src/commands/issue-create.command.ts:357-361` (pre-send gate)

- [ ] **Step 1: Write the failing test**

Add a test to `src/commands/issue-create.command.spec.ts`:

```typescript
it('should reject ticket creation when ADF validation fails and maxAttempts is 1', async () => {
  // Configure create stage with validation that will fail
  jest.spyOn(mockConfigService, 'get').mockImplementation((key: string) => {
    if (key === 'stages.create.verificationConditions') {
      return {
        maxAttempts: 1,
        scripts: { format: 'echo \'{"passed":false,"issues":[{"error":"test error","suggestion":"fix it"}]}\' && exit 1' },
      };
    }
    if (key === 'platforms.primary') return 'jira';
    return undefined;
  });

  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit called');
  });

  await expect(
    command.run(['ticket.md'], { platform: 'jira' }),
  ).rejects.toThrow();

  exitSpy.mockRestore();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/commands/issue-create.command.spec.ts --no-coverage -t "reject ticket"`
Expected: FAIL — validation gate does not exist yet.

- [ ] **Step 3: Add `AiService` to constructor and imports**

In `src/commands/issue-create.command.ts`, add import:

```typescript
import { spawnSync } from 'child_process';
import { AiService, stripCodeFences } from '../integrations/ai/ai.service';
import type { NormalizedVerificationConditionsConfig } from '../config/wf-config-loader';
```

Update the constructor to inject `AiService`:

```typescript
export class IssueCreateCommand extends CommandRunner {
  constructor(
    private readonly platformService: PlatformService,
    private readonly jiraAdapter: JiraAdapter,
    private readonly formatConverterService: FormatConverterService,
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
    private readonly dryRunPreview: DryRunPreviewService,
    private readonly aiService: AiService,
  ) {
    super();
  }
```

- [ ] **Step 4: Add the validation + correction loop**

Add a private method to `IssueCreateCommand`:

```typescript
  private async validateAndCorrectDescription(
    description: string,
    verificationConditions: NormalizedVerificationConditionsConfig,
  ): Promise<string> {
    const scriptEntries = Object.entries(verificationConditions.scripts);
    if (scriptEntries.length === 0) {
      return description;
    }

    const maxAttempts = verificationConditions.maxAttempts;
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    let currentDescription = description;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const payload = this.jiraAdapter.buildCreatePayload(
        new (
          await import('../common/dto/universal-ticket.dto')
        ).UniversalTicket({ description: currentDescription }),
      );
      const serializedPayload = JSON.stringify(payload);

      this.logger.info(
        `[issue:create] Validation attempt ${attempt + 1}/${maxAttempts}`,
      );

      let allPassed = true;

      for (const [name, command] of scriptEntries) {
        const result = spawnSync('sh', ['-c', command], {
          input: serializedPayload,
          encoding: 'utf-8',
          timeout: 30_000,
        });

        let validationResult: {
          passed: boolean;
          issues: Array<{ error: string; suggestion: string }>;
        };

        try {
          validationResult = JSON.parse(result.stdout);
        } catch {
          this.logger.warn(
            `[issue:create] Validation script "${name}" returned non-JSON output`,
          );
          allPassed = false;
          continue;
        }

        if (validationResult.passed) {
          this.logger.success(`[issue:create] Validation "${name}" passed`);
          continue;
        }

        allPassed = false;

        this.logger.warn(
          `[issue:create] Validation "${name}" failed: ${validationResult.issues.length} issue(s)`,
        );
        for (const issue of validationResult.issues) {
          this.logger.warn(`  - ${issue.error}`);
        }

        if (attempt + 1 >= maxAttempts) {
          throw new Error(
            `ADF validation failed after ${maxAttempts} attempt(s):\n` +
              validationResult.issues
                .map((issue) => `  - ${issue.error}`)
                .join('\n'),
          );
        }

        const issueList = validationResult.issues
          .map(
            (issue, i) =>
              `${i + 1}. Error: ${issue.error}\n   Fix: ${issue.suggestion}`,
          )
          .join('\n\n');

        const correctionContent = [
          'The markdown description you produced generated an invalid Jira ADF payload.',
          'Fix the following issues and return ONLY the corrected markdown.',
          '',
          'Issues:',
          issueList,
          '',
          'Original markdown:',
          currentDescription,
        ].join('\n');

        messages.push({ role: 'user', content: correctionContent });

        this.logger.info(
          `[issue:create] Requesting AI correction (attempt ${attempt + 2}/${maxAttempts})`,
        );

        const response = await this.aiService.executeWithHistory({
          messages,
          systemPrompt:
            'You are rewriting a Jira ticket description. Return ONLY the corrected markdown with no preamble, explanation, or wrapping.',
          stage: 'create',
        });

        messages.push({ role: 'assistant', content: response.content });
        currentDescription = stripCodeFences(response.content.trim());
      }

      if (allPassed) {
        return currentDescription;
      }
    }

    return currentDescription;
  }
```

- [ ] **Step 5: Wire the gate before the platform POST**

Replace the live creation block at line 357-361:

```typescript
      // Create ticket on platform
      const verificationConditions =
        this.configService.get<NormalizedVerificationConditionsConfig>(
          'stages.create.verificationConditions',
        );

      if (verificationConditions?.scripts) {
        ticket.description = await this.validateAndCorrectDescription(
          ticket.description,
          verificationConditions,
        );
      }

      const adapter = this.platformService.getAdapter(platformName);
      console.log(chalk.cyan('🚀 Creating ticket on platform...\n'));
      const reference = await adapter.createTicket(ticket);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx jest src/commands/issue-create.command.spec.ts --no-coverage`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/commands/issue-create.command.ts src/commands/issue-create.command.spec.ts
git commit -m "feat(issue-create): add ADF validation gate with AI self-correction loop"
```

---

### Task 6: Integrate validation into `test-issue-update-jira-adf-smoke`

**Files:**
- Modify: `test/manual/test-issue-update-jira-adf-smoke.ts:104-109`

- [ ] **Step 1: Replace hardcoded assertions with validation script call**

In `test/manual/test-issue-update-jira-adf-smoke.ts`, replace lines 104-109:

```typescript
    assert.strictEqual(
      (result.payload.fields.description as { type: string }).type,
      'doc',
    );
    assert(!result.serializedPayload.includes('{code}'));
    assert(!result.serializedPayload.includes('{noformat}'));
```

With:

Add `import { spawnSync } from 'child_process';` to the top-level imports at line 4.

Then replace the assertion block:

```typescript
    assert.strictEqual(
      (result.payload.fields.description as { type: string }).type,
      'doc',
    );

    const validation = spawnSync(
      'npx',
      ['ts-node', 'test/manual/test-verify-request-format.ts'],
      {
        input: result.serializedPayload,
        encoding: 'utf-8',
        timeout: 30_000,
      },
    );

    const validationResult: {
      passed: boolean;
      issues: Array<{ error: string; suggestion: string }>;
    } = JSON.parse(validation.stdout);

    for (const issue of validationResult.issues) {
      console.log(`  FAIL: ${issue.error}`);
      console.log(`        ${issue.suggestion}`);
    }

    assert(
      validationResult.passed,
      `ADF payload has ${validationResult.issues.length} formatting issue(s)`,
    );
```

- [ ] **Step 2: Run the smoke test to verify it works**

Run: `npx ts-node test/manual/test-issue-update-jira-adf-smoke.ts` (with the test arguments from the file header comment)
Expected: PASS — the test now uses the shared validation script.

- [ ] **Step 3: Commit**

```bash
git add test/manual/test-issue-update-jira-adf-smoke.ts
git commit -m "refactor(smoke): use shared ADF validator in update smoke test"
```

---

### Task 7: Create end-to-end manual test `test-issue-create-request-body-format`

**Files:**
- Create: `test/manual/test-issue-create-request-body-format.ts`

- [ ] **Step 1: Create the end-to-end test**

Create `test/manual/test-issue-create-request-body-format.ts`:

```typescript
/**
 * Manual Test: issue:create request body format validation
 *
 * Run: nr test:manual -- test-issue-create-request-body-format
 *
 * Exercises the ADF validation script with known-bad and known-good
 * markdown through the full markdownToADF pipeline.
 */

import assert from 'assert';
import { spawnSync } from 'child_process';
import { JiraService } from '../../src/integrations/jira/jira.service';

interface ValidationResult {
  passed: boolean;
  issues: Array<{ error: string; suggestion: string }>;
}

const createJiraService = (): JiraService =>
  new JiraService(
    {
      get: (key: string) =>
        ({
          'atlassian.baseUrl': 'https://test.atlassian.net',
          'atlassian.email': 'test@example.com',
          'atlassian.apiToken': 'test-token',
          'atlassian.jira.defaultProject': 'WBP',
        })[key],
    } as any,
    { post: () => undefined } as any,
    { warn: () => undefined, success: () => undefined } as any,
    { isPlatformEnabled: () => true } as any,
  );

const runValidator = (payload: unknown): ValidationResult => {
  const result = spawnSync(
    'npx',
    ['ts-node', 'test/manual/test-verify-request-format.ts'],
    {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      timeout: 30_000,
    },
  );
  return JSON.parse(result.stdout);
};

function main() {
  console.log(
    '\nManual Test: issue:create request body format validation\n',
  );

  const service = createJiraService();

  // 1. Known-bad: wiki markup leaks
  {
    const adf = service.markdownToADF(
      '### Summary\n\nThe {{bufferPx}} variable.\n\n{noformat}raw text{noformat}\n\n* First item.\n* Second item.',
    );
    const payload = { fields: { description: adf } };
    const result = runValidator(payload);

    // After normalizeMarkdownForADF, {noformat} and * should be converted.
    // {{monospace}} should also be converted after Task 1.
    // If Task 1 is complete, this should PASS.
    // If Task 1 is NOT complete, this will FAIL with {{...}} issue.
    console.log(
      `  ${result.passed ? 'PASS' : 'FAIL'}: known-bad wiki markup through markdownToADF (${result.issues.length} issue(s))`,
    );

    if (!result.passed) {
      for (const issue of result.issues) {
        console.log(`    - ${issue.error}`);
      }
    }
  }

  // 2. Known-good: proper markdown
  {
    const adf = service.markdownToADF(
      '### Summary\n\nClean description.\n\n```css\n.a4 { display: block; }\n```\n\n- First item.\n- Second item.',
    );
    const payload = { fields: { description: adf } };
    const result = runValidator(payload);

    assert(
      result.passed,
      `Expected clean markdown to pass validation but got: ${JSON.stringify(result.issues)}`,
    );
    console.log('  PASS: known-good markdown produces valid ADF');
  }

  // 3. Empty description
  {
    const adf = service.markdownToADF('');
    const payload = { fields: { description: adf } };
    const result = runValidator(payload);

    assert(
      !result.passed,
      'Expected empty description to fail validation',
    );
    assert(
      result.issues.some((i) => i.error.includes('no block nodes')),
      `Expected 'no block nodes' issue but got: ${JSON.stringify(result.issues)}`,
    );
    console.log('  PASS: empty description correctly rejected');
  }

  // 4. Bare ADF doc (no fields wrapper)
  {
    const adf = service.markdownToADF('### Summary\n\nClean text.');
    const result = runValidator(adf);

    assert(
      result.passed,
      `Expected bare ADF doc to pass but got: ${JSON.stringify(result.issues)}`,
    );
    console.log('  PASS: bare ADF doc (no fields wrapper) accepted');
  }

  console.log(
    '\nAll issue:create request body format tests passed.\n',
  );
}

main();
```

- [ ] **Step 2: Run the end-to-end test**

Run: `nr test:manual -- test-issue-create-request-body-format`
Expected: All 4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add test/manual/test-issue-create-request-body-format.ts
git commit -m "test(smoke): add issue:create request body format validation e2e test"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run full verification chain**

```bash
nr lint && nr format && nr typecheck && nr test && nr generated-docs:check && nr build
```

Expected: All pass. 0 errors.

- [ ] **Step 2: Run all manual smoke tests**

```bash
npx ts-node test/manual/test-adf-to-markdown-regression.ts
npx ts-node test/manual/test-adf-to-markdown-wiki-normalization.ts
npx ts-node test/manual/test-issue-create-jira-adf-smoke.ts
nr test:manual -- test-issue-create-request-body-format
```

Expected: All pass.

- [ ] **Step 3: Verify clean working tree**

```bash
git status
```

Expected: `nothing to commit, working tree clean`.
