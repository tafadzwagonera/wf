# Anthropic Progress Tool Formatter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Format Anthropic agent progress events into stable, human-readable terminal lines so `wf issue:implement` can show task progress, tool progress, and last-tool context without requiring users to inspect raw SDK event payloads.

**Architecture:** Keep the Anthropic agent backend responsible for event subscription and output routing, but move all event-to-line formatting into a small pure helper. The helper should normalize task summaries, tool names, durations, and last-tool labels into concise lines that remain stable across SDK message shape changes.

**Tech Stack:** TypeScript, NestJS, Jest, `@anthropic-ai/claude-agent-sdk`

---

### Task 1: Define the Formatter Contract

**Files:**
- Modify: `src/integrations/ai/adapters/anthropic-agent.adapter.ts`
- Test: `src/integrations/ai/adapters/anthropic-agent.adapter.spec.ts`

- [ ] **Step 1: Add a focused spec for progress message formatting**

```ts
describe('formatProgressMessage', () => {
  it('formats task progress with the last tool label when present', () => {
    const message = {
      type: 'system',
      subtype: 'task_progress',
      summary: 'Inspecting verification output',
      last_tool_name: 'Bash',
    } as any;

    expect(formatProgressMessage(message)).toBe(
      '  [claude-agent-sdk] Task progress: Inspecting verification output · last tool: Bash',
    );
  });

  it('formats tool progress with elapsed time and task id', () => {
    const message = {
      type: 'tool_progress',
      tool_name: 'Write',
      elapsed_time_seconds: 2.4,
      task_id: 'task-1',
    } as any;

    expect(formatProgressMessage(message)).toBe(
      '  [claude-agent-sdk] Tool progress: Write (2.4s) · task: task-1',
    );
  });
});
```

- [ ] **Step 2: Verify the current adapter behavior fails if the formatter is missing or incorrect**

Run: `npm test -- --runInBand src/integrations/ai/adapters/anthropic-agent.adapter.spec.ts`

- [ ] **Step 3: Keep the formatter pure and reusable**

```ts
const formatProgressMessage = (message: SDKMessage): string | null => {
  if (message.type === 'system' && message.subtype === 'task_progress') {
    const summary = message.summary?.trim() || message.description.trim();
    const lastToolLabel = message.last_tool_name
      ? ` · last tool: ${message.last_tool_name}`
      : '';
    return `  [claude-agent-sdk] Task progress: ${summary}${lastToolLabel}`;
  }

  if (message.type === 'tool_progress') {
    const elapsedSeconds = message.elapsed_time_seconds.toFixed(1);
    const taskLabel = message.task_id ? ` · task: ${message.task_id}` : '';
    return `  [claude-agent-sdk] Tool progress: ${message.tool_name} (${elapsedSeconds}s)${taskLabel}`;
  }

  return null;
};
```

- [ ] **Step 4: Add a small logger helper that prints only progress-like events**

```ts
const logProgressMessage = (message: SDKMessage): boolean => {
  const formattedMessage = formatProgressMessage(message);
  if (!formattedMessage) {
    return false;
  }

  console.log(chalk.cyan(formattedMessage));
  return true;
};
```

- [ ] **Step 5: Commit the formatter documentation and spec updates**

```bash
git add src/integrations/ai/adapters/anthropic-agent.adapter.ts \
  src/integrations/ai/adapters/anthropic-agent.adapter.spec.ts \
  docs/superpowers/plans/2026-04-09-anthropic-progress-tool-formatter.md
git commit -m "docs(agent): document anthropic progress formatter"
```

