# issue:create ADF Verification Gate with AI Self-Correction

**Date**: 2026-06-04
**Status**: Approved
**Scope**: Config extension, validation script, self-correction loop, smoke test integration

## Problem

The `issue:create` command converts markdown to Jira ADF via `markdownToADF`, but wiki markup patterns (`{code:lang}`, `{noformat}`, `{{monospace}}`, `* bullet`) leak through as literal text when the AI generates non-standard markdown. There is no pre-send validation gate — malformed ADF reaches Jira and renders as raw wiki syntax.

## Solution

Add a verification gate between `buildCreatePayload()` and the Jira HTTP POST. When validation fails, feed the structured errors back to the AI to regenerate the description. Retry up to `maxAttempts` times before hard-failing.

## Design

### 1. Config Changes

#### `public-config.ts`

`WfVerificationConditionsConfig` gains `maxAttempts`:

```typescript
export interface WfVerificationConditionsConfig {
  maxAttempts?: number;
  policyFile?: string;
  scripts?: Record<string, string>;
}
```

New `WfCreateStageConfig` follows the same shape as `WfImplementStageConfig`:

```typescript
export interface WfCreateStageConfig extends WfAiStageTargetConfig {
  verificationConditions?: WfVerificationConditionsConfig;
}
```

The `stages` union adds `create`:

```typescript
stages?: Partial<
  Record<'plan' | 'review' | 'generate' | 'commit', WfAiStageTargetConfig>
> & {
  create?: WfCreateStageConfig;
  implement?: WfImplementStageConfig;
  fetch?: string;
};
```

#### `wf-config-loader.ts`

`SupportedStageName` adds `'create'`. `NormalizedVerificationConditionsConfig` adds `maxAttempts: number` (normalized default: `1`). A new `NormalizedCreateStageConfig` mirrors `NormalizedImplementStageConfig` with `provider`, `model`, `agent`, and `verificationConditions`.

#### Consumer config example

```js
module.exports = defineConfig({
  stages: {
    create: {
      provider: 'openai',
      model: 'gpt-5.4-mini',
      verificationConditions: {
        maxAttempts: 2,
        scripts: {
          format: 'nr test:manual -- test-verify-request-format',
        },
      },
    },
  },
});
```

When `maxAttempts` is `1` (default), validation runs once and failure is a hard error with no AI correction call. When `verificationConditions` is absent from the `create` stage, validation is skipped entirely.

### 2. Validation Script

**File**: `test/manual/test-verify-request-format.ts`

**Contract**: Reads serialized JSON payload from stdin. Outputs structured JSON to stdout. Exits 0 (pass) or 1 (fail).

**Output shape**:

```jsonc
{
  "passed": false,
  "issues": [
    {
      "error": "raw `{noformat}` marker in text node at `doc.content[2].content[0]`",
      "suggestion": "Replace `{noformat}...{noformat}` with markdown code fences: ```\\n...\\n```"
    }
  ]
}
```

**Validation rules**:

| Rule | Suggestion |
|---|---|
| No `{code}` / `{code:lang}` in text nodes | "Replace `{code:lang}...{code}` with markdown code fences: `` ```lang\n...\n``` ``" |
| No `{noformat}` in text nodes | "Replace `{noformat}...{noformat}` with markdown code fences: `` ```\n...\n``` ``" |
| No `{{...}}` in text nodes | "Replace `{{text}}` with markdown inline code: `` `text` ``" |
| No `* ` at line start in text nodes | "Replace wiki `* item` with markdown `- item` at line start" |
| ADF root is `type: 'doc'` | "Description must be a valid ADF document with `type: 'doc'`" |
| At least one block node in content | "Description must contain at least one block node (paragraph, heading, etc.)" |

**No external dependencies** — uses only Node.js builtins so it runs cleanly as a child process without import overhead.

**Accepts two payload shapes**: `{ fields: { description: <adf> } }` (full Jira REST payload) and bare ADF document `{ type: 'doc', ... }` (for direct piping).

### 3. Self-Correction Loop in `issue:create`

Runs after `buildCreatePayload()`, before the HTTP POST.

#### Context preservation

Uses `AiService.executeWithHistory()` with an accumulating `{ role, content }[]` message array. Each correction turn sees the full conversation history: system prompt, original generation, validation issues, corrected attempt, and so on.

The `create` stage routes to its own `provider`/`model` via the same resolution chain as `implement`. The `stage` union in `AIConversationRequest` adds `'create'`.

#### Loop logic

```
attempt = 0
messages = []
description = original markdown

while attempt < maxAttempts:
  payload = markdownToADF(description)
  serializedPayload = JSON.stringify({ fields: { description: payload } })

  logger.info(`[issue:create] Validation attempt ${attempt + 1}/${maxAttempts}`)

  result = spawnSync(script, { input: serializedPayload, encoding: 'utf-8' })
  validationResult = JSON.parse(result.stdout)

  if validationResult.passed:
    logger.success(`[issue:create] ADF payload validated`)
    → proceed to POST
    return payload

  logger.warn(`[issue:create] Validation failed: ${validationResult.issues.length} issue(s)`)
  for issue in validationResult.issues:
    logger.warn(`  - ${issue.error}`)
    logger.debug(`    Suggestion: ${issue.suggestion}`)

  attempt++
  if attempt >= maxAttempts:
    break

  correctionContent = formatCorrectionPrompt(description, validationResult.issues)
  messages.push({ role: 'user', content: correctionContent })

  logger.info(`[issue:create] Requesting AI correction (attempt ${attempt + 1}/${maxAttempts})`)

  response = aiService.executeWithHistory({
    messages,
    systemPrompt: CORRECTION_SYSTEM_PROMPT,
    stage: 'create',
  })

  messages.push({ role: 'assistant', content: response.content })
  description = extractMarkdown(response.content)
  // extractMarkdown strips outer ```markdown fences if the AI wraps its response.
  // Uses the existing stripCodeFences() utility from the codebase.

logger.error(`[issue:create] Validation failed after ${maxAttempts} attempt(s)`)
→ print final issues to console
→ exit with error (do NOT send to Jira)
```

#### Correction prompt

The user message fed to the AI on each correction turn:

```
The markdown description you produced generated an invalid Jira ADF payload.
Fix the following issues and return ONLY the corrected markdown.

Issues:
1. Error: raw `{noformat}` marker in text node at `doc.content[2].content[0]`
   Fix: Replace `{noformat}...{noformat}` with markdown code fences: ```\n...\n```

2. Error: raw `{{bufferPx}}` marker in text node at `doc.content[4].content[0]`
   Fix: Replace `{{text}}` with markdown inline code: `text`

Original markdown:
<the full description>
```

### 4. Integration with `test-issue-update-jira-adf-smoke`

The existing hardcoded assertions in `test-issue-update-jira-adf-smoke.ts`:

```typescript
assert(!result.serializedPayload.includes('{code}'));
assert(!result.serializedPayload.includes('{noformat}'));
```

Are replaced with a call to the shared validation script:

```typescript
const validation = spawnSync(validationScript, { input: result.serializedPayload });
const { passed, issues } = JSON.parse(validation.stdout);

for (const issue of issues) {
  console.log(`  FAIL: ${issue.error}`);
  console.log(`        ${issue.suggestion}`);
}
assert(passed, `ADF payload has ${issues.length} formatting issue(s)`);
```

Both create and update paths share the same validation rules. New rules added to the script are picked up automatically.

### 5. Manual Test Script

**File**: `test/manual/test-issue-create-request-body-format.ts`

Exercises the validation + correction loop end-to-end:

1. Creates a mock `JiraService` (same pattern as `test-issue-create-jira-adf-smoke.ts`)
2. Feeds known-bad markdown containing wiki markup (`{noformat}`, `{{monospace}}`, `* bullets`)
3. Runs `markdownToADF` and pipes the payload to the validation script
4. Asserts the validation reports expected issues
5. Feeds known-good markdown (proper code fences, inline code, `- bullets`)
6. Asserts validation passes
7. Exits 0 on success, 1 on failure

## File Change Summary

| File | Change |
|---|---|
| `src/config/public-config.ts` | Add `maxAttempts` to `WfVerificationConditionsConfig`. Add `WfCreateStageConfig`. Add `create` to `stages` union. |
| `src/config/wf-config-loader.ts` | Add `'create'` to `SupportedStageName`. Add `NormalizedCreateStageConfig`. Normalize `maxAttempts` (default `1`). |
| `src/commands/issue-create.command.ts` | After `buildCreatePayload()`, run validation script, AI correction loop, then POST or fail. Wire up `AiService` and `LoggerService`. |
| `src/integrations/ai/ai.service.ts` | Add `'create'` to the `stage` union in `AIConversationRequest`. |
| `test/manual/test-verify-request-format.ts` | New: stdin JSON validator, structured output, no external dependencies. |
| `test/manual/test-issue-update-jira-adf-smoke.ts` | Replace hardcoded assertions with shared validation script call. |
| `test/manual/test-issue-create-request-body-format.ts` | New: end-to-end test for validation + known-bad/known-good markdown. |

## Not Changed

`normalizeMarkdownForADF`, `normalizeWikiMarkupInMarkdown`, `adfToMarkdown`, `markdownToADF` — existing conversion functions stay as-is. This design adds a verification gate, not more conversion logic.
