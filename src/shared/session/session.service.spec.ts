import { Test } from '@nestjs/testing';
import * as logFileWriter from '../logger/log-file-writer';
import { ConfigService } from '@nestjs/config';
import { SessionService } from './session.service';
import { SessionModule } from './session.module';
import type { SessionState, StageConfigFingerprint } from '../types/session.types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createTempDir as createManagedTempDir } from '../testing/temp-dir';
import { buildSessionFileName } from '../utils/session-file-name';

const createMockSessionState = (overrides?: Partial<SessionState>): SessionState => ({
  sessionId: 'test-session-id',
  ticketKey: 'PROJ-123',
  toStage: 'commit',
  action: null,
  sourceType: 'ticket',
  customPlanRef: null,
  sourceBranch: null,
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
    tmpDir = createManagedTempDir('session-test');

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
    jest.restoreAllMocks();
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

  describe('session file naming', () => {
    const createdAt = '2026-10-06T10:00:00.000Z';

    it('writes a ticket session under a date-prefixed file name', async () => {
      await service.save(createMockSessionState({ ticketKey: 'WBP-417', sessionId: 'sid-1', createdAt }));

      expect(fs.readdirSync(tmpDir)).toEqual(['2026-10-06-WBP-417-sid-1.json']);
    });

    it('does not double-prefix an already-dated custom stem', async () => {
      await service.save(createMockSessionState({ ticketKey: '2026-10-05-my-plan', sessionId: 'sid-2', createdAt }));

      expect(fs.readdirSync(tmpDir)).toEqual(['2026-10-05-my-plan-sid-2.json']);
    });

    it('removes a legacy-named file for the same sessionId on save', async () => {
      fs.writeFileSync(path.join(tmpDir, 'WBP-417-sid-3.json'), '{}');

      await service.save(createMockSessionState({ ticketKey: 'WBP-417', sessionId: 'sid-3', createdAt }));

      expect(fs.readdirSync(tmpDir)).toEqual(['2026-10-06-WBP-417-sid-3.json']);
    });

    it('keeps files that belong to other sessions when saving', async () => {
      fs.writeFileSync(path.join(tmpDir, '2026-10-06-WBP-417-other.json'), '{}');

      await service.save(createMockSessionState({ ticketKey: 'WBP-417', sessionId: 'sid-3', createdAt }));

      expect(fs.readdirSync(tmpDir).sort()).toEqual([
        '2026-10-06-WBP-417-other.json',
        '2026-10-06-WBP-417-sid-3.json',
      ]);
    });

    it('findByTicketKey matches date-prefixed files without matching a longer ticket key', async () => {
      const recentCreatedAt = new Date().toISOString();
      await service.save(createMockSessionState({ ticketKey: 'WBP-4176', sessionId: 'sid-4', createdAt: recentCreatedAt }));
      await service.save(createMockSessionState({ ticketKey: 'WBP-417', sessionId: 'sid-5', createdAt: recentCreatedAt }));

      const found = await service.findByTicketKey('WBP-417');

      expect(found?.sessionId).toBe('sid-5');
    });
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

  it('findByProviderSessionId returns the most recent session matching the stage providerSessionId', async () => {
    const older = createMockSessionState({
      sessionId: 'older-session',
      createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      stages: {
        plan: {
          config: mockFingerprint, model: 'claude', modelsUsed: [], providerSessionId: 'provider-abc',
          summary: null, startedAt: new Date().toISOString(), completedAt: null,
        },
      },
    });
    const newer = createMockSessionState({
      sessionId: 'newer-session',
      createdAt: new Date('2026-02-01T00:00:00.000Z').toISOString(),
      stages: {
        plan: {
          config: mockFingerprint, model: 'claude', modelsUsed: [], providerSessionId: 'provider-abc',
          summary: null, startedAt: new Date().toISOString(), completedAt: null,
        },
      },
    });
    await service.save(older);
    await service.save(newer);

    const found = await service.findByProviderSessionId('provider-abc', 'plan');

    expect(found?.sessionId).toBe('newer-session');
  });

  it('findByProviderSessionId returns null when no session matches', async () => {
    const session = createMockSessionState({
      stages: {
        plan: {
          config: mockFingerprint, model: 'claude', modelsUsed: [], providerSessionId: 'provider-abc',
          summary: null, startedAt: new Date().toISOString(), completedAt: null,
        },
      },
    });
    await service.save(session);

    const found = await service.findByProviderSessionId('provider-xyz', 'plan');

    expect(found).toBeNull();
  });

  it('findByProviderSessionId ignores sessions where the stage was never recorded', async () => {
    const session = createMockSessionState({ stages: {} });
    await service.save(session);

    const found = await service.findByProviderSessionId('provider-abc', 'plan');

    expect(found).toBeNull();
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

  it('recordStageModels records the models the stage actually ran with', async () => {
    const session = createMockSessionState();
    const started = await service.recordStageStart(session, 'implement', mockFingerprint, 'claude-sonnet-4-6');

    const updated = await service.recordStageModels(started, 'implement', ['claude-haiku-4-5-20251001']);

    expect(updated.stages['implement'].modelsUsed).toEqual(['claude-haiku-4-5-20251001']);
    expect(updated.stages['implement'].model).toBe('claude-sonnet-4-6');
  });

  it('recordStageModels accumulates distinct models across auto-routed steps', async () => {
    const session = createMockSessionState();
    const started = await service.recordStageStart(session, 'implement', mockFingerprint, 'claude-sonnet-4-6');

    const first = await service.recordStageModels(started, 'implement', ['claude-haiku-4-5-20251001']);
    const second = await service.recordStageModels(first, 'implement', ['claude-haiku-4-5-20251001', 'claude-opus-5']);

    expect(second.stages['implement'].modelsUsed).toEqual(['claude-haiku-4-5-20251001', 'claude-opus-5']);
  });

  it('recordStageModels ignores a stage that was never started', async () => {
    const session = createMockSessionState();

    const updated = await service.recordStageModels(session, 'implement', ['claude-opus-5']);

    expect(updated.stages['implement']).toBeUndefined();
  });

  it('logs an INFO stage.start record so a run can be traced from the log', async () => {
    const appendSpy = jest.spyOn(logFileWriter, 'appendToLogFile').mockImplementation(() => undefined);
    const session = createMockSessionState();

    await service.recordStageStart(session, 'implement', mockFingerprint, 'claude-sonnet-4-6');

    expect(appendSpy).toHaveBeenCalledWith('INFO', expect.stringContaining('stage.start'), 'session');
    expect(appendSpy).toHaveBeenCalledWith('INFO', expect.stringContaining('stage=implement'), 'session');
  });

  it('logs an INFO stage.complete record when a stage finishes', async () => {
    const appendSpy = jest.spyOn(logFileWriter, 'appendToLogFile').mockImplementation(() => undefined);
    const session = createMockSessionState();
    const started = await service.recordStageStart(session, 'plan', mockFingerprint, 'claude-opus-5');

    await service.recordStageComplete(started, 'plan', 'done');

    expect(appendSpy).toHaveBeenCalledWith('INFO', expect.stringContaining('stage.complete'), 'session');
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

  it('recordSourceBranch persists sourceBranch and saves the session', async () => {
    const session = createMockSessionState();
    await service.save(session);

    const updated = await service.recordSourceBranch(session, 'develop');

    expect(updated.sourceBranch).toBe('develop');
    const reloaded = await service.load(session.sessionId);
    expect(reloaded?.sourceBranch).toBe('develop');
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

  describe('inferNextStage', () => {
    it('returns plan when no stages are completed for a custom session', () => {
      const session = createMockSessionState({ sourceType: 'custom' });

      expect(service.inferNextStage(session)).toBe('plan');
    });

    it('returns fetch when no stages are completed for a ticket session', () => {
      const session = createMockSessionState({ sourceType: 'ticket' });

      expect(service.inferNextStage(session)).toBe('fetch');
    });

    it('advances from fetch to plan when fetch already completed', () => {
      const completedAt = new Date().toISOString();
      const session = createMockSessionState({
        stages: {
          fetch: {
            config: mockFingerprint,
            model: 'claude-sonnet-4-20250514',
            modelsUsed: [],
            providerSessionId: null,
            summary: null,
            startedAt: completedAt,
            completedAt,
          },
        },
      });

      expect(service.inferNextStage(session)).toBe('plan');
    });

    it('returns the next workflow stage after the last completed stage', () => {
      const session = createMockSessionState({
        stages: {
          plan: {
            config: mockFingerprint,
            model: 'claude-sonnet-4-20250514',
            modelsUsed: [],
            providerSessionId: null,
            summary: 'done',
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          },
        },
      });

      expect(service.inferNextStage(session)).toBe('implement');
    });

    it('returns null after all resumable stages are completed', () => {
      const completedAt = new Date().toISOString();
      const buildStage = () => ({
        config: mockFingerprint,
        model: 'claude-sonnet-4-20250514',
        modelsUsed: [],
        providerSessionId: null,
        summary: 'done',
        startedAt: completedAt,
        completedAt,
      });
      const session = createMockSessionState({
        stages: {
          plan: buildStage(),
          implement: buildStage(),
          review: buildStage(),
          commit: buildStage(),
        },
      });

      expect(service.inferNextStage(session)).toBeNull();
    });
  });

  it('load fills missing workflow metadata with null defaults for older session files', async () => {
    const legacySession = {
      sessionId: 'legacy-session-id',
      ticketKey: 'PROJ-123',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      stages: {
        plan: {
          config: mockFingerprint,
          model: 'claude-sonnet-4-20250514',
          modelsUsed: [],
          providerSessionId: null,
          summary: null,
          startedAt: new Date().toISOString(),
        },
      },
    };
    fs.writeFileSync(
      path.join(tmpDir, buildSessionFileName(legacySession)),
      JSON.stringify(legacySession, null, 2)
    );

    const loaded = await service.load(legacySession.sessionId);

    expect(loaded).not.toBeNull();
    expect(loaded?.toStage).toBeNull();
    expect(loaded?.action).toBeNull();
    expect(loaded?.sourceType).toBeNull();
    expect(loaded?.customPlanRef).toBeNull();
    expect(loaded?.stages.plan.providerSessionId).toBeNull();
    expect(loaded?.stages.plan.summary).toBeNull();
    expect(loaded?.stages.plan.completedAt).toBeNull();
  });

  describe('validateForStage', () => {
    const defaultResolveFingerprint = (_stage: string): StageConfigFingerprint => mockFingerprint;

    describe('getLatestCompatibleProviderSession', () => {
      it('prefers an interrupted compatible stage record over completed prior stages', async () => {
        let session = createMockSessionState();
        session = await service.recordStageStart(session, 'plan', mockFingerprint, 'claude');
        session = await service.recordProviderSessionId(session, 'plan', 'plan-session');
        session = await service.recordStageComplete(session, 'plan', 'Plan complete');
        session = await service.recordStageStart(session, 'implement', mockFingerprint, 'claude');
        session = await service.recordProviderSessionId(session, 'implement', 'implement-session');

        const candidate = service.getLatestCompatibleProviderSession(session, 'implement', mockFingerprint);

        expect(candidate).toEqual({
          stage: 'implement', provider: 'anthropic', backend: 'agent',
          providerSessionId: 'implement-session', recordedAt: session.stages.implement.startedAt,
        });
      });

      it('falls back to the most recent completed compatible prior stage', async () => {
        let session = createMockSessionState();
        session = await service.recordStageStart(session, 'plan', mockFingerprint, 'claude');
        session = await service.recordProviderSessionId(session, 'plan', 'plan-session');
        session = await service.recordStageComplete(session, 'plan', 'Plan complete');
        session = await service.recordStageStart(session, 'implement', mockFingerprint, 'claude');
        session = await service.recordProviderSessionId(session, 'implement', 'implement-session');
        session = await service.recordStageComplete(session, 'implement', null);

        const candidate = service.getLatestCompatibleProviderSession(session, 'review', mockFingerprint);

        expect(candidate).toEqual(expect.objectContaining({
          stage: 'implement', providerSessionId: 'implement-session',
        }));
      });

      it('skips a newer incompatible completed stage to find an older compatible session', async () => {
        const openaiAgentFingerprint: StageConfigFingerprint = { provider: 'openai', backend: 'agent' };
        let session = createMockSessionState();
        session = await service.recordStageStart(session, 'plan', mockFingerprint, 'claude');
        session = await service.recordProviderSessionId(session, 'plan', 'plan-session');
        session = await service.recordStageComplete(session, 'plan', 'Plan complete');
        session = await service.recordStageStart(session, 'implement', openaiAgentFingerprint, 'gpt');
        session = await service.recordProviderSessionId(session, 'implement', 'implement-session');
        session = await service.recordStageComplete(session, 'implement', 'Implement complete');

        expect(service.getLatestCompatibleProviderSession(session, 'review', mockFingerprint)).toEqual(
          expect.objectContaining({ stage: 'plan', providerSessionId: 'plan-session' })
        );
      });

      it('returns null for incompatible records, missing IDs, and an empty session', async () => {
        const openaiAgentFingerprint: StageConfigFingerprint = { provider: 'openai', backend: 'agent' };
        let incompatible = createMockSessionState();
        incompatible = await service.recordStageStart(incompatible, 'plan', openaiAgentFingerprint, 'gpt');
        incompatible = await service.recordProviderSessionId(incompatible, 'plan', 'thread-1');
        incompatible = await service.recordStageComplete(incompatible, 'plan', 'Plan complete');

        expect(service.getLatestCompatibleProviderSession(incompatible, 'implement', mockFingerprint)).toBeNull();
        expect(service.getLatestCompatibleProviderSession(createMockSessionState(), 'implement', mockFingerprint)).toBeNull();
      });
    });

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
      if (planStage) session.stages.plan = { ...planStage, providerSessionId: 'fake-id' };
      else throw new Error('Expected plan stage record to exist');

      const result = service.validateForStage(session, 'implement', googleFingerprint, _s => googleFingerprint);

      expect(result.canResume).toBe(false);
      expect(result.resumableProviderSessionId).toBeNull();
      expect(result.priorSummary).toBe('Plan done');
    });
  });
});

describe('SessionModule composition', () => {
  it('exports exactly SessionService', () => {
    const metadata: unknown[] = Reflect.getMetadata('exports', SessionModule);
    expect(metadata).toEqual([SessionService]);
  });
});
