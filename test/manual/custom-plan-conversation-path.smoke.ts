/**
 * Manual smoke test for conversation save paths.
 *
 * Verifies against a temporary WF_HOME:
 * 1. artifactDir without a tracker saves to <project>/<key>-conversation.json
 * 2. artifactDir with a tracker dir saves to <project>/<tracker>/<key>-conversation.json
 * 3. Ticket-based issue-review chat saves to <tracker>/<ticketKey>-conversation.json
 * 4. Ticket-less issue-review chat keeps <project>/review-conversation.json
 * 5. A pre-fix conversation moved to the project root re-saves in place (backfill on load)
 *
 * Run:
 *   nr test:manual custom-plan-conversation-path.smoke
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConversationService } from '../../src/integrations/ai/conversation/conversation.service';
import { ConversationContext } from '../../src/shared/types/conversation.types';
import { resolveArtifactDir, resolveCustomArtifactDir } from '../../src/agents/utils';
import { IssueReviewCommand } from '../../src/commands/issue-review.command';

const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-conv-smoke-'));
process.env.WF_HOME = wfHome;
const repoDir = '/tmp/smoke-project';

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
};

const noop = () => undefined;
const mockLogger = { debug: noop, error: noop, warn: noop, log: noop };

const makeService = (): ConversationService =>
  new ConversationService({} as any, {} as any, mockLogger as any, {} as any);

const buildContext = (ticketKey: string, extra: Partial<ConversationContext>): ConversationContext => ({
  ticketKey, stage: 'plan', repoDir, workflowState: { ticketContent: 'smoke' }, ...extra,
});

const testCustomPlanPath = async (): Promise<void> => {
  const artifactDir = resolveCustomArtifactDir(repoDir);
  const service = makeService();
  const conversation = await service.createConversation(
    'shop-fix-plan', buildContext('shop-fix-plan', { artifactDir })
  );
  await service.saveConversation(conversation);
  const expected = path.join(wfHome, 'smoke-project', 'shop-fix-plan-conversation.json');
  assert(fs.existsSync(expected), `Expected ${expected}`);
  assert(!fs.existsSync(path.join(wfHome, 'smoke-project', 'jira')), 'Did not expect a jira dir');
  console.log('  Test 1 passed: custom-plan conversation saved beside plan artifacts');
};

const testTicketPath = async (): Promise<void> => {
  const artifactDir = resolveArtifactDir(repoDir, 'jira');
  const service = makeService();
  const conversation = await service.createConversation(
    'TAD-1', buildContext('TAD-1', { artifactDir, trackerName: 'jira' })
  );
  await service.saveConversation(conversation);
  const expected = path.join(wfHome, 'smoke-project', 'jira', 'TAD-1-conversation.json');
  assert(fs.existsSync(expected), `Expected ${expected}`);
  console.log('  Test 2 passed: ticket conversation saved under tracker dir');
};

const saveReviewChat = async (
  tracker: string | undefined, ticketKey: string | undefined
): Promise<void> => {
  const resolveTarget = (IssueReviewCommand.prototype as any).resolveChatConversationTarget;
  const fakeCommand = { resolveTrackerNameSafely: () => tracker };
  const { conversationKey, artifactDir } = resolveTarget.call(fakeCommand, repoDir, { ticketKey });
  const service = makeService();
  const conversation = await service.createConversation(
    conversationKey, buildContext(conversationKey, { stage: 'review', artifactDir })
  );
  await service.saveConversation(conversation);
};

const testTicketReviewPath = async (): Promise<void> => {
  await saveReviewChat('jira', 'TAD-9');
  const expected = path.join(wfHome, 'smoke-project', 'jira', 'TAD-9-conversation.json');
  assert(fs.existsSync(expected), `Expected ${expected}`);
  console.log('  Test 3 passed: ticket-based review chat saved under tracker dir');
};

const testTicketlessReviewPath = async (): Promise<void> => {
  await saveReviewChat(undefined, undefined);
  const expected = path.join(wfHome, 'smoke-project', 'review-conversation.json');
  assert(fs.existsSync(expected), `Expected ${expected}`);
  console.log('  Test 4 passed: ticket-less review chat kept review-conversation.json at project root');
};

const moveLegacyConversation = async (legacyDir: string, projectRoot: string): Promise<string> => {
  const seed = makeService();
  const created = await seed.createConversation('moved-plan', buildContext('moved-plan', { trackerName: 'jira' }));
  await seed.saveConversation(created);
  const movedPath = path.join(projectRoot, 'moved-plan-conversation.json');
  fs.renameSync(path.join(legacyDir, 'moved-plan-conversation.json'), movedPath);
  return movedPath;
};

const testBackfillOnLoad = async (): Promise<void> => {
  const legacyDir = path.join(wfHome, 'smoke-project', 'jira');
  const projectRoot = resolveCustomArtifactDir(repoDir);
  const movedPath = await moveLegacyConversation(legacyDir, projectRoot);

  const service = makeService();
  const loaded = await service.loadConversation('moved-plan', repoDir, 'jira', projectRoot);
  assert(loaded !== null, 'Expected moved conversation to load');
  await service.saveConversation(loaded as NonNullable<typeof loaded>);
  assert(!fs.existsSync(path.join(legacyDir, 'moved-plan-conversation.json')), 'Legacy path was resurrected');
  const saved = JSON.parse(fs.readFileSync(movedPath, 'utf8'));
  assert(saved.context.artifactDir === projectRoot, 'artifactDir not backfilled');
  console.log('  Test 5 passed: moved conversation re-saves in place');
};

const run = async (): Promise<void> => {
  try {
    await testCustomPlanPath();
    await testTicketPath();
    await testTicketReviewPath();
    await testTicketlessReviewPath();
    await testBackfillOnLoad();
    console.log('All conversation path smoke tests passed');
  } finally {
    fs.rmSync(wfHome, { recursive: true, force: true });
  }
};

run().catch(error => {
  console.error(error);
  process.exit(1);
});
