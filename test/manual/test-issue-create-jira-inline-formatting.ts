/**
 * Manual Test: issue:create Jira inline formatting smoke test
 *
 * Run: nr test:manual -- test-issue-create-jira-inline-formatting
 *
 * Verifies the Jira create payload for generated markdown with inline code
 * does not leak Jira wiki markers or markdown delimiters into Jira fields.
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
        return of({ data: { key: 'WBP-3090' } });
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

  service.resolveCreatePriorityName = async () => 'Low';
  return { service, postCalls };
};

const hasInlineCodeMark = (nodes: AdfNode[]): boolean =>
  nodes.some(
    (node) =>
      node.type === 'text' &&
      Array.isArray(node.marks) &&
      node.marks.some((mark) => mark.type === 'code'),
  );

const hasRawBulletText = (nodes: AdfNode[]): boolean =>
  nodes.some(
    (node) =>
      node.type === 'text' &&
      typeof node.text === 'string' &&
      /^[*-]\s/.test(node.text),
  );

const hasWikiInlineCodeText = (nodes: AdfNode[]): boolean =>
  nodes.some(
    (node) =>
      node.type === 'text' &&
      typeof node.text === 'string' &&
      (node.text.includes('{{') || node.text.includes('}}')),
  );

async function main() {
  console.log('\nManual Test: issue:create Jira inline formatting\n');

  const { service, postCalls } = createJiraService();

  await service.createTicket({
    project: 'WBP',
    summary:
      'Fix `service-document` startup failures: health-check grace period too short',
    description: [
      '### Summary',
      '',
      'The `service-document` ECS task fails to remain healthy during startup because ECS marks the task unhealthy before the Node.js process has fully initialised, causing repeated restarts.',
      '',
      'The `customer-service-identity` task previously required a longer health-check grace period for the same reason; `service-document` needs the same treatment.',
      '',
      '#### Technical Details',
      '',
      '- Increase the ECS service `health_check_grace_period_seconds` for `service-document`. Use the `customer-service-identity` Terraform module as the reference pattern.',
      '',
      '### Acceptance Criteria',
      '',
      '- ECS health checks pass on first deployment without triggering a restart loop.',
    ].join('\n'),
    issueType: 'Bug',
    priority: 'low',
  });

  assert.strictEqual(postCalls.length, 1, 'expected one Jira POST call');
  const payload = postCalls[0][1] as {
    fields: {
      summary: string;
      description: { type: string };
    };
  };
  const adfNodes = collectAdfNodes(payload.fields.description);

  assert.strictEqual(
    payload.fields.summary,
    'Fix service-document startup failures: health-check grace period too short',
  );
  assert.strictEqual(payload.fields.description.type, 'doc');
  assert(adfNodes.some((node) => node.type === 'heading'));
  assert(adfNodes.some((node) => node.type === 'bulletList'));
  assert(hasInlineCodeMark(adfNodes));
  assert(!hasRawBulletText(adfNodes));
  assert(!hasWikiInlineCodeText(adfNodes));

  console.log(
    'PASS: Jira create payload avoids inline wiki and bullet marker leaks.',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
