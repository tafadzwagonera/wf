# issue:create — Priority Validation & URL Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two bugs in `issue:create`: (1) proactively validate the priority name against Jira's priority scheme before creating a ticket, eliminating the silent 400 + retry; (2) replace the hardcoded `https://jira.example.com` base URL with `ATLASSIAN_BASE_URL` from config.

**Architecture:** `JiraService.createTicket()` will call a new `resolveValidPriorityName()` method that fetches `GET /rest/api/3/priority` and does a case-insensitive match. If no match is found, the priority field is omitted from the initial payload. The existing retry fallback is kept as a safety net. `JiraAdapter.getTicketUrl()` will inject `ConfigService` and read `atlassian.baseUrl` to build the URL.

**Tech Stack:** NestJS, TypeScript, `@nestjs/axios` (HttpService), `@nestjs/config` (ConfigService), Jest

---

### Task 1: Add `resolveValidPriorityName()` to `JiraService`

**Files:**
- Modify: `src/integrations/jira/jira.service.ts`

- [ ] **Step 1: Write the failing tests**

Add inside the existing `describe('JiraService', ...)` block in `src/integrations/jira/jira.service.spec.ts`:

```typescript
describe('resolveValidPriorityName', () => {
  it('should return the exact Jira priority name when a case-insensitive match is found', async () => {
    mockHttpService.get.mockReturnValue(
      of({
        data: [
          { id: '1', name: 'Highest' },
          { id: '2', name: 'High' },
          { id: '3', name: 'Medium' },
          { id: '4', name: 'Low' },
          { id: '5', name: 'Lowest' },
        ],
      }),
    );

    const result = await service.resolveValidPriorityName('high');
    expect(result).toBe('High');
  });

  it('should return undefined when no matching priority exists', async () => {
    mockHttpService.get.mockReturnValue(
      of({
        data: [
          { id: '1', name: 'P1' },
          { id: '2', name: 'P2' },
          { id: '3', name: 'P3' },
        ],
      }),
    );

    const result = await service.resolveValidPriorityName('High');
    expect(result).toBeUndefined();
  });

  it('should return undefined when the priority fetch fails', async () => {
    mockHttpService.get.mockReturnValue(
      throwError(() => new Error('Network error')),
    );

    const result = await service.resolveValidPriorityName('High');
    expect(result).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx jest --testPathPattern="jira.service.spec" --no-coverage 2>&1 | grep -E "(PASS|FAIL|resolveValidPriorityName)"
```

Expected: `FAIL` — `service.resolveValidPriorityName is not a function`

- [ ] **Step 3: Implement `resolveValidPriorityName()` in `jira.service.ts`**

Add this method after `private ensureConfigured()` (line 50), before `private getAuthHeaders()`:

```typescript
/**
 * Fetch all available Jira priorities and return the exact name that
 * matches the requested priority (case-insensitive). Returns undefined
 * if no match is found or the fetch fails.
 */
async resolveValidPriorityName(requested: string): Promise<string | undefined> {
  try {
    const url = `${this.baseUrl}/rest/api/3/priority`;
    const response = await firstValueFrom(
      this.httpService.get(url, { headers: this.getAuthHeaders() }),
    );
    const priorities: Array<{ id: string; name: string }> = response.data;
    const lower = requested.toLowerCase();
    const match = priorities.find((p) => p.name.toLowerCase() === lower);
    return match?.name;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx jest --testPathPattern="jira.service.spec" --no-coverage 2>&1 | grep -E "(PASS|FAIL|resolveValidPriorityName)"
```

Expected: `PASS` — all three `resolveValidPriorityName` tests green

- [ ] **Step 5: Commit**

```bash
git add src/integrations/jira/jira.service.ts src/integrations/jira/jira.service.spec.ts
git commit -m "feat(jira): add resolveValidPriorityName to validate priority against project scheme"
```

---

### Task 2: Use `resolveValidPriorityName()` in `createTicket()`

**Files:**
- Modify: `src/integrations/jira/jira.service.ts`

- [ ] **Step 1: Write the failing test**

Add inside `describe('JiraService', ...)` in `src/integrations/jira/jira.service.spec.ts`:

```typescript
describe('createTicket priority handling', () => {
  it('should omit priority when no matching priority name is found', async () => {
    // Priority lookup returns no match
    mockHttpService.get.mockReturnValue(
      of({ data: [{ id: '1', name: 'P1' }, { id: '2', name: 'P2' }] }),
    );
    // Create ticket succeeds
    mockHttpService.post.mockReturnValue(
      of({ data: { key: 'WBP-100' } }),
    );

    const key = await service.createTicket({
      project: 'WBP',
      summary: 'Test ticket',
      description: 'desc',
      issueType: 'Task',
      priority: 'High',
    });

    expect(key).toBe('WBP-100');
    const payload = mockHttpService.post.mock.calls[0][1];
    expect(payload.fields.priority).toBeUndefined();
  });

  it('should include priority when the resolved name matches', async () => {
    // Priority lookup returns a match
    mockHttpService.get.mockReturnValue(
      of({ data: [{ id: '2', name: 'High' }, { id: '3', name: 'Medium' }] }),
    );
    mockHttpService.post.mockReturnValue(
      of({ data: { key: 'WBP-101' } }),
    );

    const key = await service.createTicket({
      project: 'WBP',
      summary: 'Test ticket',
      description: 'desc',
      issueType: 'Task',
      priority: 'High',
    });

    expect(key).toBe('WBP-101');
    const payload = mockHttpService.post.mock.calls[0][1];
    expect(payload.fields.priority).toEqual({ name: 'High' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx jest --testPathPattern="jira.service.spec" --no-coverage 2>&1 | grep -E "(PASS|FAIL|createTicket priority)"
```

Expected: `FAIL` — current `createTicket()` does not call `resolveValidPriorityName`

- [ ] **Step 3: Update `createTicket()` to call `resolveValidPriorityName()`**

Replace the `createTicket()` method body in `src/integrations/jira/jira.service.ts` (lines 71–145). The key change is to resolve the priority before building the initial payload:

```typescript
async createTicket(request: CreateTicketRequest): Promise<string> {
  this.ensureConfigured();

  const project = request.project || this.defaultProject;
  if (!project) {
    throw new JiraApiError(
      'No project specified and no default project configured',
    );
  }

  // Resolve priority against the Jira instance's priority scheme
  let resolvedPriority: string | undefined;
  if (request.priority) {
    resolvedPriority = await this.resolveValidPriorityName(request.priority);
    if (!resolvedPriority) {
      this.logger.warn(
        `Priority "${request.priority}" not found in Jira priority scheme. Creating ticket without priority.`,
      );
    }
  }

  try {
    const payload = {
      fields: {
        project: { key: project },
        summary: request.summary,
        description: this.markdownToADF(request.description),
        issuetype: { name: request.issueType || 'Task' },
        ...(resolvedPriority && { priority: { name: resolvedPriority } }),
        ...(request.labels && { labels: request.labels }),
        ...(request.assignee && {
          assignee: { accountId: request.assignee },
        }),
        ...(request.components && {
          components: request.components.map((name) => ({ name })),
        }),
      },
    };

    const url = `${this.baseUrl}/rest/api/3/issue`;
    const response = await firstValueFrom(
      this.httpService.post(url, payload, { headers: this.getAuthHeaders() }),
    );

    const ticketKey = response.data.key;
    this.logger.success(`Created Jira ticket: ${ticketKey}`);

    return ticketKey;
  } catch (error) {
    const isPriorityError =
      error?.response?.status === 400 &&
      error?.response?.data?.errors?.priority;

    if (isPriorityError) {
      this.logger.warn(
        `Priority rejected by Jira (${request.priority}). Retrying without priority field.`,
      );
      const retryPayload = {
        fields: {
          project: { key: project },
          summary: request.summary,
          description: this.markdownToADF(request.description),
          issuetype: { name: request.issueType || 'Task' },
          ...(request.labels && { labels: request.labels }),
          ...(request.assignee && {
            assignee: { accountId: request.assignee },
          }),
          ...(request.components && {
            components: request.components.map((name) => ({ name })),
          }),
        },
      };
      const url = `${this.baseUrl}/rest/api/3/issue`;
      const response = await firstValueFrom(
        this.httpService.post(url, retryPayload, {
          headers: this.getAuthHeaders(),
        }),
      );
      const ticketKey = response.data.key;
      this.logger.success(`Created Jira ticket: ${ticketKey}`);
      return ticketKey;
    }

    this.handleJiraError(error, 'create ticket');
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx jest --testPathPattern="jira.service.spec" --no-coverage 2>&1 | grep -E "(PASS|FAIL|Tests:)"
```

Expected: `PASS` — all tests green

- [ ] **Step 5: Commit**

```bash
git add src/integrations/jira/jira.service.ts src/integrations/jira/jira.service.spec.ts
git commit -m "fix(jira): resolve priority against project scheme before creating ticket"
```

---

### Task 3: Fix hardcoded URL in `JiraAdapter.getTicketUrl()`

**Files:**
- Modify: `src/integrations/platforms/jira/jira-adapter.ts`

- [ ] **Step 1: Write the failing test**

Create `src/integrations/platforms/jira/jira-adapter.spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JiraAdapter } from './jira-adapter';
import { JiraService } from '../../jira/jira.service';

describe('JiraAdapter', () => {
  let adapter: JiraAdapter;

  const mockJiraService = {
    createTicket: jest.fn(),
    getTicket: jest.fn(),
    updateTicket: jest.fn(),
    searchTickets: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === 'atlassian.baseUrl') return 'https://mycompany.atlassian.net';
      return undefined;
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JiraAdapter,
        { provide: JiraService, useValue: mockJiraService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    adapter = module.get<JiraAdapter>(JiraAdapter);
  });

  afterEach(() => jest.clearAllMocks());

  describe('createTicket URL', () => {
    it('should build the ticket URL from ATLASSIAN_BASE_URL', async () => {
      mockJiraService.createTicket.mockResolvedValue('WBP-999');

      const ref = await adapter.createTicket({
        project: 'WBP',
        title: 'Test',
        description: 'desc',
      } as any);

      expect(ref.url).toBe('https://mycompany.atlassian.net/browse/WBP-999');
    });

    it('should fall back to empty string when ATLASSIAN_BASE_URL is not set', async () => {
      mockConfigService.get.mockReturnValue(undefined);
      mockJiraService.createTicket.mockResolvedValue('WBP-998');

      const ref = await adapter.createTicket({
        project: 'WBP',
        title: 'Test',
        description: 'desc',
      } as any);

      expect(ref.url).toBe('/browse/WBP-998');
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx jest --testPathPattern="jira-adapter.spec" --no-coverage 2>&1 | grep -E "(PASS|FAIL|URL)"
```

Expected: `FAIL` — URL is `https://jira.example.com/browse/WBP-999` instead of `https://mycompany.atlassian.net/browse/WBP-999`

- [ ] **Step 3: Inject `ConfigService` and fix `getTicketUrl()` in `jira-adapter.ts`**

Replace the constructor and `getTicketUrl()` method:

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JiraService } from '../../jira/jira.service';
// ... existing imports remain unchanged
```

Update the constructor (currently line 26):

```typescript
constructor(
  private readonly jiraService: JiraService,
  private readonly configService: ConfigService,
) {}
```

Replace `getTicketUrl()` (currently lines 238–242):

```typescript
/**
 * Get Jira ticket URL using ATLASSIAN_BASE_URL from config
 */
private getTicketUrl(ticketKey: string): string {
  const baseUrl = this.configService.get<string>('atlassian.baseUrl') ?? '';
  return `${baseUrl}/browse/${ticketKey}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx jest --testPathPattern="jira-adapter.spec" --no-coverage 2>&1 | grep -E "(PASS|FAIL|Tests:)"
```

Expected: `PASS` — both URL tests green

- [ ] **Step 5: Commit**

```bash
git add src/integrations/platforms/jira/jira-adapter.ts src/integrations/platforms/jira/jira-adapter.spec.ts
git commit -m "fix(jira): build ticket URL from ATLASSIAN_BASE_URL instead of hardcoded placeholder"
```

---

### Task 4: Build, manually test, and commit

**Files:**
- No code changes — build verification and manual test only

- [ ] **Step 1: Run the full test suite**

```bash
npx jest --no-coverage 2>&1 | tail -10
```

Expected: All tests pass. Fix any failures before continuing.

- [ ] **Step 2: Build**

```bash
npm run build 2>&1 | tail -20
```

Expected: Build succeeds with no errors.

- [ ] **Step 3: Run the manual test**

```bash
nr test:manual -- test-issue-create
```

**What to verify:**
1. No line matching `Priority rejected by Jira` appears in the output — the priority is either resolved correctly upfront, or the warning says `Priority "High" not found in Jira priority scheme` (the new message)
2. The `URL:` line in the output matches `https://<your-atlassian-domain>/browse/WBP-XXXX` — NOT `https://jira.example.com/...`

If the output still shows `Priority rejected by Jira`, the WBP project scheme uses names other than `High`. Run:

```bash
curl -s -u "$ATLASSIAN_EMAIL:$ATLASSIAN_JIRA_API_TOKEN" \
  "$ATLASSIAN_BASE_URL/rest/api/3/priority" | \
  node -e "const d=require('fs').readFileSync(0,'utf8'); JSON.parse(d).forEach(p=>console.log(p.name))"
```

This shows the exact priority names your Jira instance supports. Confirm the new warning message matches `Priority "High" not found in Jira priority scheme` — meaning the proactive lookup is working as expected.

- [ ] **Step 4: Commit all changes with `issue:commit`**

```bash
yarn start issue:commit -c
```
