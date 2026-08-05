import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SessionService } from './session.service';
import type { SessionState, StageConfigFingerprint } from '../types/session.types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const createMockSessionState = (overrides?: Partial<SessionState>): SessionState => ({
  sessionId: 'test-session-id',
  ticketKey: 'PROJ-123',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  completedAt: null,
  stages: {},
  ...overrides,
});

const mockFingerprint: StageConfigFingerprint = {
  provider: 'anthropic',
  backend: 'agent',
};

describe('SessionService', () => {
  let service: SessionService;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-session-test-'));

    const moduleRef = await Test.createTestingModule({
      providers: [
        SessionService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue(null),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(SessionService);
    jest.spyOn(service, 'getSessionDir').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('save/load round-trip preserves all fields', async () => {
    const session = createMockSessionState();
    await service.save(session);

    const loaded = await service.load(session.sessionId);

    expect(loaded).not.toBeNull();
    expect(loaded?.sessionId).toBe(session.sessionId);
    expect(loaded?.ticketKey).toBe(session.ticketKey);
    expect(loaded?.createdAt).toBe(session.createdAt);
    expect(loaded?.updatedAt).toBe(session.updatedAt);
    expect(loaded?.completedAt).toBe(session.completedAt);
    expect(loaded?.stages).toEqual(session.stages);
  });

  it('findByTicketKey returns the active session', async () => {
    const completed = createMockSessionState({
      sessionId: 'completed-session',
      completedAt: new Date().toISOString(),
    });
    const active = createMockSessionState({
      sessionId: 'active-session',
      completedAt: null,
    });
    await service.save(completed);
    await service.save(active);

    const found = await service.findByTicketKey('PROJ-123');

    expect(found).not.toBeNull();
    expect(found?.sessionId).toBe('active-session');
  });

  it('recordStageStart creates a stage record with provider/backend/model', async () => {
    const session = createMockSessionState();
    const updated = await service.recordStageStart(session, 'plan', mockFingerprint, 'claude-sonnet-4-20250514');

    expect(updated.stages['plan']).toBeDefined();
    expect(updated.stages['plan'].config.provider).toBe('anthropic');
    expect(updated.stages['plan'].config.backend).toBe('agent');
    expect(updated.stages['plan'].model).toBe('claude-sonnet-4-20250514');
    expect(updated.stages['plan'].startedAt).toBeDefined();
    expect(updated.stages['plan'].completedAt).toBeNull();
  });

  it('recordStageStart skips re-recording an incomplete stage with same fingerprint', async () => {
    const session = createMockSessionState();
    const after1 = await service.recordStageStart(session, 'plan', mockFingerprint, 'claude-sonnet-4-20250514');
    const originalStartedAt = after1.stages['plan'].startedAt;

    const after2 = await service.recordStageStart(after1, 'plan', mockFingerprint, 'claude-sonnet-4-20250514');
    expect(after2.stages['plan'].startedAt).toBe(originalStartedAt);
  });

  it('recordStageStart creates a fresh record for an interrupted non-resumable stage', async () => {
    const openaiAgentFingerprint: StageConfigFingerprint = { provider: 'openai', backend: 'agent' };
    let session = createMockSessionState();
    session = await service.recordStageStart(session, 'plan', openaiAgentFingerprint, 'gpt-5.4');
    session = await service.recordProviderSessionId(session, 'plan', 'thread-123');
    const originalRecord = session.stages['plan'];

    const updated = await service.recordStageStart(session, 'plan', openaiAgentFingerprint, 'gpt-5.4');

    expect(updated.stages['plan']).not.toBe(originalRecord);
    expect(updated.stages['plan'].providerSessionId).toBeNull();
    expect(updated.stages['plan'].completedAt).toBeNull();
  });

  it('recordProviderSessionId updates only the providerSessionId field', async () => {
    const session = createMockSessionState();
    const s1 = await service.recordStageStart(session, 'plan', mockFingerprint, 'claude-sonnet-4-20250514');
    const s2 = await service.recordProviderSessionId(s1, 'plan', 'provider-sid-abc');

    expect(s2.stages['plan'].providerSessionId).toBe('provider-sid-abc');
    expect(s2.stages['plan'].config.provider).toBe('anthropic');
    expect(s2.stages['plan'].completedAt).toBeNull();
  });

  it('recordStageComplete sets summary and completedAt', async () => {
    const session = createMockSessionState();
    const s1 = await service.recordStageStart(session, 'plan', mockFingerprint, 'claude-sonnet-4-20250514');
    const s2 = await service.recordStageComplete(s1, 'plan', 'Plan completed successfully');

    expect(s2.stages['plan'].summary).toBe('Plan completed successfully');
    expect(s2.stages['plan'].completedAt).not.toBeNull();
  });

  it('markComplete sets session-level completedAt', async () => {
    const session = createMockSessionState();
    await service.save(session);
    const updated = await service.markComplete(session);

    expect(updated.completedAt).not.toBeNull();
  });

  it('isExpired returns true for a session older than TTL', () => {
    const eightDaysAgo = new Date();
    eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);

    const session = createMockSessionState({
      createdAt: eightDaysAgo.toISOString(),
    });

    expect(service.isExpired(session)).toBe(true);
  });

  it('isExpired returns false for a fresh session', () => {
    const session = createMockSessionState();
    expect(service.isExpired(session)).toBe(false);
  });

  it('load returns null for non-existent session', async () => {
    const loaded = await service.load('does-not-exist');
    expect(loaded).toBeNull();
  });

  it('deleteBySessionId removes the session', async () => {
    const session = createMockSessionState();
    await service.save(session);

    await service.deleteBySessionId(session.sessionId);

    const loaded = await service.load(session.sessionId);
    expect(loaded).toBeNull();
  });

  it('listSessions returns all sessions and filters by ticketKey', async () => {
    const s1 = createMockSessionState({ sessionId: 'session-1' });
    const s2 = createMockSessionState({ sessionId: 'session-2' });
    const s3 = createMockSessionState({ sessionId: 'session-3', ticketKey: 'PROJ-456' });
    await service.save(s1);
    await service.save(s2);
    await service.save(s3);

    const all = await service.listSessions();
    expect(all).toHaveLength(3);

    const filtered = await service.listSessions({ ticketKey: 'PROJ-123' });
    expect(filtered).toHaveLength(2);
    expect(filtered.every(s => s.ticketKey === 'PROJ-123')).toBe(true);
  });

  describe('validateForStage', () => {
    const defaultResolveFingerprint = (_stage: string): StageConfigFingerprint => mockFingerprint;

    it('returns canResume with same provider across stages', async () => {
      let session = createMockSessionState();
      session = await service.recordStageStart(session, 'plan', mockFingerprint, 'claude-sonnet-4-20250514');
      session = await service.recordProviderSessionId(session, 'plan', 'sid-1');
      session = await service.recordStageComplete(session, 'plan', 'Plan done');

      const result = service.validateForStage(session, 'implement', mockFingerprint, defaultResolveFingerprint);

      expect(result.canResume).toBe(true);
      expect(result.resumableProviderSessionId).toBe('sid-1');
      expect(result.warnings).toHaveLength(0);
    });

    it('returns canResume false when provider changed between stages', async () => {
      let session = createMockSessionState();
      session = await service.recordStageStart(session, 'plan', mockFingerprint, 'claude-sonnet-4-20250514');
      session = await service.recordProviderSessionId(session, 'plan', 'sid-1');
      session = await service.recordStageComplete(session, 'plan', 'Plan done');

      const openaiFingerprint: StageConfigFingerprint = { provider: 'openai', backend: 'agent' };
      const result = service.validateForStage(session, 'implement', openaiFingerprint, _s => openaiFingerprint);

      expect(result.canResume).toBe(false);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.priorSummary).toBe('Plan done');
    });

    it('returns canResume true for interrupted stage with same provider', async () => {
      let session = createMockSessionState();
      session = await service.recordStageStart(session, 'plan', mockFingerprint, 'claude-sonnet-4-20250514');
      session = await service.recordProviderSessionId(session, 'plan', 'sid-1');

      const result = service.validateForStage(session, 'plan', mockFingerprint, defaultResolveFingerprint);

      expect(result.canResume).toBe(true);
      expect(result.resumableProviderSessionId).toBe('sid-1');
    });

    it('returns canResume false for interrupted stage with different provider', async () => {
      let session = createMockSessionState();
      session = await service.recordStageStart(session, 'plan', mockFingerprint, 'claude-sonnet-4-20250514');
      session = await service.recordProviderSessionId(session, 'plan', 'sid-1');

      const openaiFingerprint: StageConfigFingerprint = { provider: 'openai', backend: 'agent' };
      const result = service.validateForStage(session, 'plan', openaiFingerprint, _s => openaiFingerprint);

      expect(result.canResume).toBe(false);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('returns canResume false when re-running a completed stage', async () => {
      let session = createMockSessionState();
      session = await service.recordStageStart(session, 'plan', mockFingerprint, 'claude-sonnet-4-20250514');
      session = await service.recordStageComplete(session, 'plan', 'Plan done');

      const result = service.validateForStage(session, 'plan', mockFingerprint, defaultResolveFingerprint);

      expect(result.canResume).toBe(false);
      expect(result.warnings.some(w => w.includes('already completed'))).toBe(true);
    });

    it('handles google/standard with no providerSessionId', async () => {
      const googleFingerprint: StageConfigFingerprint = { provider: 'google', backend: 'standard' };
      let session = createMockSessionState();
      session = await service.recordStageStart(session, 'plan', googleFingerprint, 'gemini-2.5-pro');
      session = await service.recordStageComplete(session, 'plan', 'Plan done');

      const result = service.validateForStage(session, 'implement', googleFingerprint, _s => googleFingerprint);

      expect(result.canResume).toBe(false);
      expect(result.resumableProviderSessionId).toBeNull();
      expect(result.priorSummary).toBe('Plan done');
    });

    it('allows cross-backend resume when provider matches (anthropic/agent to anthropic/cli)', async () => {
      let session = createMockSessionState();
      session = await service.recordStageStart(session, 'plan', mockFingerprint, 'claude-sonnet-4-20250514');
      session = await service.recordProviderSessionId(session, 'plan', 'sid-1');
      session = await service.recordStageComplete(session, 'plan', 'Plan done');

      const cliFingerprint: StageConfigFingerprint = { provider: 'anthropic', backend: 'cli' };
      const result = service.validateForStage(session, 'implement', cliFingerprint, _s => cliFingerprint);

      expect(result.canResume).toBe(true);
      expect(result.resumableProviderSessionId).toBe('sid-1');
      expect(result.priorSummary).toBe('Plan done');
    });

    it('detects config drift when resolveStageFingerprint disagrees', async () => {
      let session = createMockSessionState();
      session = await service.recordStageStart(session, 'plan', mockFingerprint, 'claude-sonnet-4-20250514');
      session = await service.recordStageComplete(session, 'plan', 'Plan done');

      const cliFingerprint: StageConfigFingerprint = { provider: 'anthropic', backend: 'cli' };
      const result = service.validateForStage(session, 'implement', mockFingerprint, stage => {
        if (stage === 'plan') return cliFingerprint;
        return mockFingerprint;
      });

      expect(result.warnings.some(w => w.includes('drift'))).toBe(true);
    });

    it('returns priorSummary regardless of provider change', async () => {
      let session = createMockSessionState();
      session = await service.recordStageStart(session, 'plan', mockFingerprint, 'claude-sonnet-4-20250514');
      session = await service.recordStageComplete(session, 'plan', 'Plan summary content');

      const openaiFingerprint: StageConfigFingerprint = { provider: 'openai', backend: 'cli' };
      const result = service.validateForStage(session, 'implement', openaiFingerprint, _s => openaiFingerprint);

      expect(result.priorSummary).toBe('Plan summary content');
    });

    it('returns canResume false when target backend is not resumable (openai/agent)', async () => {
      let session = createMockSessionState();
      session = await service.recordStageStart(session, 'plan', mockFingerprint, 'claude-sonnet-4-20250514');
      session = await service.recordProviderSessionId(session, 'plan', 'sid-1');
      session = await service.recordStageComplete(session, 'plan', 'Plan done');

      const openaiAgentFingerprint: StageConfigFingerprint = { provider: 'openai', backend: 'agent' };
      const result = service.validateForStage(session, 'implement', openaiAgentFingerprint, _s => openaiAgentFingerprint);

      expect(result.canResume).toBe(false);
      expect(result.resumableProviderSessionId).toBeNull();
      expect(result.priorSummary).toBe('Plan done');
    });

    it('returns canResume false for interrupted stage on non-resumable backend (openai/agent)', async () => {
      const openaiAgentFingerprint: StageConfigFingerprint = { provider: 'openai', backend: 'agent' };
      let session = createMockSessionState();
      session = await service.recordStageStart(session, 'plan', openaiAgentFingerprint, 'gpt-5.4');
      session = await service.recordProviderSessionId(session, 'plan', 'thread-123');

      const result = service.validateForStage(session, 'plan', openaiAgentFingerprint, _s => openaiAgentFingerprint);

      expect(result.canResume).toBe(false);
      expect(result.warnings.some(w => w.includes('does not support session resumption'))).toBe(true);
    });

    it('returns canResume true for resumable backend (openai/cli)', async () => {
      const openaiCliFingerprint: StageConfigFingerprint = { provider: 'openai', backend: 'cli' };
      let session = createMockSessionState();
      session = await service.recordStageStart(session, 'plan', openaiCliFingerprint, 'gpt-5.4');
      session = await service.recordProviderSessionId(session, 'plan', 'codex-session-1');
      session = await service.recordStageComplete(session, 'plan', 'Plan done');

      const result = service.validateForStage(session, 'implement', openaiCliFingerprint, _s => openaiCliFingerprint);

      expect(result.canResume).toBe(true);
      expect(result.resumableProviderSessionId).toBe('codex-session-1');
    });

    it('does not resume from a non-resumable prior backend even when the target backend is resumable', async () => {
      const openaiAgentFingerprint: StageConfigFingerprint = { provider: 'openai', backend: 'agent' };
      let session = createMockSessionState();
      session = await service.recordStageStart(session, 'plan', openaiAgentFingerprint, 'gpt-5.4');
      session = await service.recordProviderSessionId(session, 'plan', 'thread-123');
      session = await service.recordStageComplete(session, 'plan', 'Plan done');

      const openaiCliFingerprint: StageConfigFingerprint = { provider: 'openai', backend: 'cli' };
      const result = service.validateForStage(session, 'implement', openaiCliFingerprint, _s => openaiCliFingerprint);

      expect(result.canResume).toBe(false);
      expect(result.resumableProviderSessionId).toBeNull();
      expect(result.priorSummary).toBe('Plan done');
      expect(result.warnings.some(w => w.includes('cannot resume from openai/agent'))).toBe(true);
    });

    it('returns canResume false for google/standard even with a manually-set providerSessionId', async () => {
      const googleFingerprint: StageConfigFingerprint = { provider: 'google', backend: 'standard' };
      let session = createMockSessionState();
      session = await service.recordStageStart(session, 'plan', googleFingerprint, 'gemini-2.5-pro');
      session = await service.recordStageComplete(session, 'plan', 'Plan done');
      const planStage = session.stages.plan;
      expect(planStage).toBeDefined();
      if (!planStage) throw new Error('Expected plan stage record to exist');
      session.stages.plan = { ...planStage, providerSessionId: 'fake-id' };

      const result = service.validateForStage(session, 'implement', googleFingerprint, _s => googleFingerprint);

      expect(result.canResume).toBe(false);
      expect(result.resumableProviderSessionId).toBeNull();
      expect(result.priorSummary).toBe('Plan done');
    });
  });
});
