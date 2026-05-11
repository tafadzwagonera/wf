/**
 * Manual Test: issue:create Jira ADF payload smoke test
 *
 * Run: nr test:manual -- test-issue-create-jira-adf-smoke
 *
 * Verifies the live JiraService create path builds a Jira ADF description
 * payload for generated service-document markdown without making a network
 * request or creating a real Jira ticket.
 */

import assert from 'assert';
import { of } from 'rxjs';
import { JiraService } from '../../src/integrations/jira/jira.service';

interface AdfNode {
  type?: string;
  text?: string;
  marks?: Array<{ type: string }>;
  [key: string]: unknown;
}

const collectAdfNodes = (node: unknown): AdfNode[] => {
  if (!node || typeof node !== 'object') {
    return [];
  }

  if (Array.isArray(node)) {
    return node.flatMap(collectAdfNodes);
  }

  const objectNode = node as AdfNode;
  return [
    objectNode,
    ...Object.values(objectNode).flatMap((value) => collectAdfNodes(value)),
  ];
};

const createJiraService = (): {
  service: JiraService;
  postCalls: unknown[][];
} => {
  const postCalls: unknown[][] = [];
  const service = new JiraService(
    {
      get: (key: string) =>
        ({
          'atlassian.baseUrl': 'https://test.atlassian.net',
          'atlassian.email': 'test@example.com',
          'atlassian.apiToken': 'test-token',
          'atlassian.jira.defaultProject': 'WBP',
        })[key],
    } as any,
    {
      post: (...args: unknown[]) => {
        postCalls.push(args);
        return of({ data: { key: 'WBP-123' } });
      },
    } as any,
    {
      warn: () => undefined,
      success: () => undefined,
    } as any,
    {
      isPlatformEnabled: () => true,
    } as any,
  );

  jestResolvePriority(service);
  return { service, postCalls };
};

const jestResolvePriority = (service: JiraService): void => {
  service.resolveValidPriorityName = async () => 'Medium';
};

async function main() {
  console.log('\nManual Test: issue:create Jira ADF payload smoke test\n');

  const { service, postCalls } = createJiraService();

  await service.createTicket({
    project: 'WBP',
    summary: 'Create service document storage',
    description: [
      '### Summary',
      'Create a persisted service document flow.',
      '',
      '```typescript',
      'export class CreateServiceDocumentDto {',
      '  serviceId: string;',
      '}',
      '```',
      '',
      '### Technical Details',
      '- **Storage selection:** Persist documents in the existing service document namespace.',
      '',
      '### Acceptance Criteria',
      '- Documents can be created from the API.',
      '',
      '### Unit Test Scope',
      '- DTO validation covers required fields.',
    ].join('\n'),
    issueType: 'Story',
    priority: 'medium',
  });

  assert.strictEqual(postCalls.length, 1, 'expected one Jira POST call');
  const payload = postCalls[0][1] as {
    fields: { description: { type: string } };
  };
  const adfNodes = collectAdfNodes(payload.fields.description);
  const serializedPayload = JSON.stringify(payload);

  assert.strictEqual(payload.fields.description.type, 'doc');
  assert(adfNodes.some((node) => node.type === 'heading'));
  assert(adfNodes.some((node) => node.type === 'codeBlock'));
  assert(adfNodes.some((node) => node.type === 'bulletList'));
  assert(!serializedPayload.includes('{noformat}'));
  assert(!serializedPayload.includes('{code}'));
  assert(
    !adfNodes.some(
      (node) =>
        node.type === 'text' &&
        typeof node.text === 'string' &&
        node.text.startsWith('- **Storage selection:**'),
    ),
  );

  console.log('PASS: Jira create payload contains Jira-safe ADF formatting.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
