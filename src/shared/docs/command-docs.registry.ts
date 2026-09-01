export interface CommandDocs {
  summary: string;
  examples: { command: string; comment?: string }[];
}

export const COMMAND_DOCS = {
  issue: {
    summary: 'Complete workflow: fetch, plan, implement, review, and commit.',
    examples: [
      {
        comment: 'Run full workflow from fetch',
        command: 'wf issue -k WBP-2971 --from fetch --action fix',
      },
      {
        comment: 'Resume from implement stage',
        command: 'wf issue -k WBP-2971 --from implement --action fix --tracker jira',
      },
      {
        comment: 'Run the workflow from a custom markdown plan source (--from defaults to plan)',
        command: 'wf issue -c bar.md --action fix',
      },
      {
        comment: 'Resume from a hashed plan artifact without --action (--from defaults to implement)',
        command: 'wf issue 2026-05-04-1a2b3c4d-fix-plan.json --to review',
      },
      {
        comment: 'Resume a saved workflow session without restating source flags',
        command: 'wf issue --session-id 550e8400-e29b-41d4-a716-446655440000',
      },
    ],
  },
  'issue:plan': {
    summary: 'Plan ticket implementation from a local artifact or repo-scoped custom artifact.',
    examples: [
      {
        comment: 'Create a custom feature plan from a markdown artifact',
        command: 'wf issue:plan --action feature --custom-plan bar.md',
      },
      {
        comment: 'Prefer the repo-scoped custom artifact when a repo is supplied',
        command: 'wf issue:plan --action feature --custom-plan bar.md --repos repo-a',
      },
      {
        comment: 'Plan a fix for a ticket',
        command: 'wf issue:plan -k WBP-2971 --action fix',
      },
      {
        comment: 'Plan against a repo so prior plan artifacts feed plan correlation',
        command: 'wf issue:plan -k WBP-2971 --action fix --repos repo-a',
      },
      {
        comment: 'Force re-fetch before planning',
        command: 'wf issue:plan -k WBP-2971 --action fix --force --tracker jira',
      },
    ],
  },
  'issue:fetch': {
    summary: 'Fetch ticket description from a tracker.',
    examples: [
      {
        comment: 'Fetch ticket from primary tracker',
        command: 'wf issue:fetch WBP-2971',
      },
      {
        comment: 'Specify tracker and format',
        command: 'wf issue:fetch WBP-2971 --tracker jira --format md',
      },
    ],
  },
  'issue:implement': {
    summary: 'Carry out an implementation plan from a ticket-backed, hashed, or custom plan artifact.',
    examples: [
      {
        comment: 'Implement from a ticket key',
        command: 'wf issue:implement -k PROJ-123',
      },
      {
        comment: 'Implement from a hashed plan artifact',
        command: 'wf issue:implement 2026-05-04-1a2b3c4d-fix-plan.json',
      },
      {
        comment: 'Implement across multiple repos',
        command: 'wf issue:implement -k PROJ-123 --repos my-repo',
      },
      {
        comment: 'Suppress interactive branch prompts',
        command: 'wf issue:implement -k PROJ-123 --silent',
      },
      {
        comment: 'Work directly on the current branch',
        command: 'wf issue:implement -k PROJ-123 --no-branch',
      },
      {
        comment: 'Preview changes without running the agent',
        command: 'wf issue:implement -k PROJ-123 --dry-run',
      },
    ],
  },
  'issue:review': {
    summary: 'AI-powered code review of local changes, ticket-associated pull requests, or PR diffs.',
    examples: [
      {
        comment: 'Review current repo changes',
        command: 'wf issue:review',
      },
      {
        comment: 'Replace the default review guidelines while keeping ticket context and Sonar findings',
        command: 'wf issue:review --ticket-key WBP-2971 --replace-criteria review-guidelines.md --sonar',
      },
      {
        comment: 'Review a ticket and associated pull requests from credentialed adapters using a remote repo hint',
        command: 'wf issue:review --ticket-key WBP-3057 -r service-bookingv3',
      },
      {
        comment: 'Review a ticket and its associated pull requests across credentialed repos',
        command: 'wf issue:review --ticket-key WBP-2971 --tracker jira --repos service-tourv3',
      },
      {
        comment: 'Force re-review a ticket, ignoring cached artifacts',
        command: 'wf issue:review --ticket-key WBP-2971 --force --tracker jira -r service-bookingv3',
      },
      {
        comment: 'Review a pull request and post review comments with diff-aligned inline anchors',
        command: 'wf issue:review https://bitbucket.org/workspace/repo/pull-requests/160 --comment',
      },
      {
        comment: 'Review ticket changes with SonarQube and continue on recoverable failures',
        command: 'wf issue:review --ticket-key WBP-2971 --sonar',
      },
      {
        comment: 'Sonar-review a chained implement→review run, recovering the source branch from that session',
        command: 'wf issue:review --ticket-key WBP-2971 --session-id {providerSessionId} --sonar',
      },
      {
        comment: 'Skip pre-review verification (lint, typecheck, test) in the target repository',
        command: 'wf issue:review --ticket-key WBP-2971 --skip-verification',
      },
      {
        comment:
          'Resume a provider-backed review session; CLI review sessions fork the epilogue session so manual resume stays readable',
        command: 'wf issue:review --ticket-key WBP-2971 --session-id {UUID} -r service-bookingv3',
      },
    ],
  },
  'issue:create': {
    summary: 'Create tickets from standardized input (file or stdin); Jira live runs enforce the ADF safety gate.',
    examples: [
      {
        comment: 'Create ticket from JSON on primary tracker',
        command: 'wf issue:create ticket.json',
      },
      {
        comment: 'Create on a specific tracker and override the Jira project',
        command: 'wf issue:create ticket.md --tracker jira --ticket-project WBP --type story',
      },
      {
        comment: 'Create Jira ticket with project-specific priority resolution',
        command: 'wf issue:create ticket.md --tracker jira --ticket-project WBP --priority medium',
      },
      {
        comment:
          'Dry-run a repo-scoped generated Jira artifact to inspect the ADF safety verdict before creation',
        command:
          'wf issue:create 2026-05-12-d38b5be9-ticket-description.md --ticket-project WBP -r terraform-aws --dry-run',
      },
      {
        comment:
          'Live smoke-test a Jira description update using a generated artifact; --live requires --confirm-live-update and shows a y/N prompt before the PUT',
        command:
          'yarn test:manual test-issue-update-jira-adf-smoke WBP-3092 --description-file /Users/tafadzwagonera/.wf/terraform-aws/jira/2026-05-13-3d6f5adb-ticket-description.md --live --confirm-live-update',
      },
    ],
  },
  'issue:generate': {
    summary: 'Generate ticket descriptions from local files, repo-scoped artifacts via --repos, URLs, or ticket keys.',
    examples: [
      {
        comment: 'Generate ticket from a URL',
        command: 'wf issue:generate https://example.com/spec',
      },
      {
        comment: 'Generate from a tracker browse URL (fetches via REST API, not HTML)',
        command: 'wf issue:generate https://touraxis.atlassian.net/browse/WBP-3371 --type bug -r service-document-v1',
      },
      {
        comment: 'Generate from a Slack thread permalink with query params',
        command:
          'wf issue:generate "https://workspace.slack.com/archives/C0AP5MMCP53/p1775650646860809?thread_ts=1775650646.860809&cid=C0AP5MMCP53"',
      },
      {
        comment: 'Generate from a repo-scoped artifact (requires -r, --repos)',
        command: 'wf issue:generate itinerary-pdf-generation.md -r service-tourv3',
      },
      {
        comment: 'Generate with repo context so prior plan artifacts inform plan correlation',
        command: 'wf issue:generate ./requirements.md -r service-tourv3 --save',
      },
      {
        comment: 'Generate with multiple repos so repo conventions, formatter rules, and git hooks are compared across checkouts',
        command: 'wf issue:generate ./requirements.md -r primary-repo secondary-repo --save',
      },
      {
        comment: 'Save with overridden title',
        command: 'wf issue:generate ./requirements.md --title "Add OAuth2" --save',
      },
      {
        comment: 'Silent mode: pipe generated ticket directly into issue:create',
        command: 'wf issue:generate ./spec.md -s | wf issue:create',
      },
      {
        comment: 'Silent mode: pipe saved artifact path to issue:create',
        command: 'wf issue:generate ./spec.md --save --silent | xargs wf issue:create',
      },
    ],
  },
  'issue:pr': {
    summary: 'Create a pull request from a plan artifact (auto-detects ticket from branch).',
    examples: [
      {
        comment: 'Create a PR from a fix plan',
        command: 'wf issue:pr WBP-2971 --action fix',
      },
      {
        comment: 'Dry-run to preview PR title and body',
        command: 'wf issue:pr WBP-2971 --dry-run',
      },
    ],
  },
  'issue:commit': {
    summary: 'Create a git commit with an AI-generated message.',
    examples: [
      {
        comment: 'AI-generated commit message',
        command: 'wf issue:commit -k WBP-2971',
      },
      {
        comment: 'Run from source with conventional commits enabled',
        command: 'yarn start issue:commit -c',
      },
      {
        comment: 'Force conventional format',
        command: 'wf issue:commit -k WBP-2971 --conventional --tracker jira',
      },
    ],
  },
  'issue:generate:lookup': {
    summary: 'Lookup the original source list for a generated ticket artifact hash.',
    examples: [
      {
        comment: 'Look up the sources for a generated artifact hash',
        command: 'wf issue:generate:lookup 1a2b3c4d',
      },
    ],
  },
} satisfies Record<string, CommandDocs>;
