/**
 * Manual Test: issue:create Jira priority metadata smoke test
 *
 * Run: nr test:manual -- test-issue-create-jira-priority-metadata
 *
 * Verifies JiraService resolves normalized priorities against project and
 * issue-type create metadata without making real Jira network requests.
 */

import assert from 'assert';
import { of, throwError } from 'rxjs';
import { JiraService } from '../../src/integrations/jira/jira.service';

type MockHttpGetResponse = {
  data: unknown;
};

type MockPostCall = {
  payload: {
    fields: {
      priority?: {
        name: string;
      };
    };
  };
};

/**
 * Build a configured Jira service with deterministic HTTP responses.
 *
 * @param getResponses - Ordered mock responses returned by HTTP GET calls
 * @param postResponses - Ordered mock responses or errors returned by HTTP POST calls
 * @returns Jira service and captured create payload calls
 */
const createJiraService = (
  getResponses: MockHttpGetResponse[],
  postResponses: unknown[],
): {
  service: JiraService;
  postCalls: MockPostCall[];
} => {
  const postCalls: MockPostCall[] = [];
  let getIndex = 0;
  let postIndex = 0;

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
      get: () => of(getResponses[getIndex++]),
      post: (_url: string, payload: MockPostCall['payload']) => {
        postCalls.push({ payload });
        const response = postResponses[postIndex++];
        if (response instanceof Error) {
          return throwError(() => response);
        }
        return of(response);
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

  return { service, postCalls };
};

/**
 * Create a Jira 400 priority rejection error.
 *
 * @returns Error shaped like Axios' Jira 400 priority response
 */
const createPriorityRejection = (): Error => {
  const error = new Error('Priority is not valid') as Error & {
    response: {
      status: number;
      data: {
        errors: {
          priority: string;
        };
      };
    };
  };

  error.response = {
    status: 400,
    data: {
      errors: {
        priority: 'Priority is not valid',
      },
    },
  };

  return error;
};

/**
 * Build create metadata responses for a Task issue type.
 *
 * @param allowedPriorityNames - Priority names exposed by Jira create metadata
 * @returns Ordered issue-type and field metadata GET responses
 */
const createMetadataResponses = (
  allowedPriorityNames?: string[],
): MockHttpGetResponse[] => [
  {
    data: {
      issueTypes: [{ id: '10001', name: 'Task' }],
    },
  },
  {
    data: {
      fields: allowedPriorityNames
        ? {
            priority: {
              allowedValues: allowedPriorityNames.map((name, index) => ({
                id: String(index + 1),
                name,
              })),
            },
          }
        : {},
    },
  },
];

/**
 * Execute a create request through the mocked service.
 *
 * @param service - Jira service under test
 * @returns Created Jira ticket key
 */
const createTicket = (service: JiraService): Promise<string> =>
  service.createTicket({
    project: 'WBP',
    summary: 'Priority metadata smoke test',
    description: 'Validate priority metadata resolution.',
    issueType: 'Task',
    priority: 'medium',
  });

/**
 * Execute the manual smoke checks.
 *
 * @returns Promise that resolves when all checks pass
 */
const main = async (): Promise<void> => {
  console.log('\nManual Test: issue:create Jira priority metadata\n');

  {
    const { service, postCalls } = createJiraService(
      createMetadataResponses(['Major', 'Minor', 'Trivial']),
      [{ data: { key: 'WBP-101' } }],
    );

    const key = await createTicket(service);

    assert.strictEqual(key, 'WBP-101');
    assert.deepStrictEqual(postCalls[0].payload.fields.priority, {
      name: 'Minor',
    });
  }

  {
    const { service, postCalls } = createJiraService(
      createMetadataResponses(['Medium', 'Minor']),
      [{ data: { key: 'WBP-102' } }],
    );

    const key = await createTicket(service);

    assert.strictEqual(key, 'WBP-102');
    assert.deepStrictEqual(postCalls[0].payload.fields.priority, {
      name: 'Medium',
    });
  }

  {
    const { service, postCalls } = createJiraService(
      createMetadataResponses(),
      [{ data: { key: 'WBP-103' } }],
    );

    const key = await createTicket(service);

    assert.strictEqual(key, 'WBP-103');
    assert.strictEqual(postCalls[0].payload.fields.priority, undefined);
  }

  {
    const { service, postCalls } = createJiraService(
      createMetadataResponses(['Medium']),
      [createPriorityRejection(), { data: { key: 'WBP-104' } }],
    );

    const key = await createTicket(service);

    assert.strictEqual(key, 'WBP-104');
    assert.deepStrictEqual(postCalls[0].payload.fields.priority, {
      name: 'Medium',
    });
    assert.strictEqual(postCalls[1].payload.fields.priority, undefined);
  }

  console.log(
    'PASS: Jira create priority metadata resolution behaves as expected.',
  );
};

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
