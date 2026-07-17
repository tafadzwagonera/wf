import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { sessionStateSchema } from '../schemas/session.schema';
import type {
  SessionState,
  StageConfigFingerprint,
  StageRecord,
  SessionValidationResult,
} from '../types/session.types';
import { getWfSessionDir } from '../utils/wf-paths';

const STAGE_ORDER = ['plan', 'implement', 'review', 'commit'];
const DEFAULT_TTL_DAYS = 7;

@Injectable()
export class SessionService {
  constructor(private readonly configService: ConfigService) {}

  getSessionDir(): string {
    return getWfSessionDir();
  }

  async save(state: SessionState): Promise<void> {
    const dir = this.getSessionDir();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${state.ticketKey}-${state.sessionId}.json`);
    const tmpPath = `${filePath}.tmp.${crypto.randomUUID()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
    fs.renameSync(tmpPath, filePath);
  }

  async load(sessionId: string): Promise<SessionState | null> {
    const dir = this.getSessionDir();
    if (!fs.existsSync(dir)) return null;

    const files = fs.readdirSync(dir);
    const match = files.find(f => f.endsWith(`-${sessionId}.json`) && !f.endsWith('.items.json'));
    if (!match) return null;

    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, match), 'utf-8'));
      return sessionStateSchema.parse(raw);
    } catch {
      return null;
    }
  }

  async findByTicketKey(ticketKey: string): Promise<SessionState | null> {
    const dir = this.getSessionDir();
    if (!fs.existsSync(dir)) return null;

    const files = fs
      .readdirSync(dir)
      .filter(f => f.startsWith(`${ticketKey}-`) && f.endsWith('.json') && !f.endsWith('.items.json'))
      .sort()
      .reverse();

    for (const file of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
        const state = sessionStateSchema.parse(raw);
        if (!state.completedAt && !this.isExpired(state)) {
          return state;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  async recordStageStart(
    session: SessionState,
    stage: string,
    fingerprint: StageConfigFingerprint,
    model: string
  ): Promise<SessionState> {
    const existing = session.stages[stage];
    if (
      existing
      && existing.config.provider === fingerprint.provider
      && existing.config.backend === fingerprint.backend
      && !existing.completedAt
    ) {
      return session;
    }

    const record: StageRecord = {
      config: fingerprint,
      model,
      providerSessionId: null,
      summary: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
    };

    const updated: SessionState = {
      ...session,
      updatedAt: new Date().toISOString(),
      stages: { ...session.stages, [stage]: record },
    };
    await this.save(updated);
    return updated;
  }

  async recordProviderSessionId(
    session: SessionState,
    stage: string,
    providerSessionId: string
  ): Promise<SessionState> {
    const record = session.stages[stage];
    if (!record) return session;

    const updated: SessionState = {
      ...session,
      updatedAt: new Date().toISOString(),
      stages: {
        ...session.stages,
        [stage]: { ...record, providerSessionId },
      },
    };
    await this.save(updated);
    return updated;
  }

  async recordStageComplete(session: SessionState, stage: string, summary: string | null): Promise<SessionState> {
    const record = session.stages[stage];
    if (!record) return session;

    const updated: SessionState = {
      ...session,
      updatedAt: new Date().toISOString(),
      stages: {
        ...session.stages,
        [stage]: { ...record, summary, completedAt: new Date().toISOString() },
      },
    };
    await this.save(updated);
    return updated;
  }

  async markComplete(session: SessionState): Promise<SessionState> {
    const updated: SessionState = {
      ...session,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.save(updated);
    return updated;
  }

  validateForStage(
    session: SessionState,
    nextStage: string,
    currentFingerprint: StageConfigFingerprint,
    resolveStageFingerprint: (stage: string) => StageConfigFingerprint
  ): SessionValidationResult {
    const warnings: string[] = [];
    let canResume = false;
    let resumableProviderSessionId: string | null = null;

    // 0. Config drift detection
    for (const [stageName, record] of Object.entries(session.stages)) {
      if (!record.completedAt) continue;
      const currentConfig = resolveStageFingerprint(stageName);
      if (record.config.provider !== currentConfig.provider || record.config.backend !== currentConfig.backend) {
        warnings.push(
          `Config drift detected: stage ${stageName} ran with ${record.config.provider}/${record.config.backend} but wf.config now resolves to ${currentConfig.provider}/${currentConfig.backend}.`
        );
      }
    }

    // 1. Find prior stage
    const nextIndex = STAGE_ORDER.indexOf(nextStage);
    let priorSummary: string | null = null;
    if (nextIndex > 0) {
      for (let i = nextIndex - 1; i >= 0; i--) {
        const priorRecord = session.stages[STAGE_ORDER[i]];
        if (priorRecord?.completedAt && priorRecord.summary) {
          priorSummary = priorRecord.summary;
          break;
        }
      }
    }

    // 2. Check if nextStage already has a record
    const existingRecord = session.stages[nextStage];
    if (existingRecord) {
      if (existingRecord.completedAt) {
        // 2a. Already completed
        warnings.push(
          `Stage ${nextStage} was already completed at ${existingRecord.completedAt}. Re-running will overwrite.`
        );
        canResume = false;
      } else {
        // 2b. Interrupted
        if (
          existingRecord.config.provider === currentFingerprint.provider
          && existingRecord.config.backend === currentFingerprint.backend
          && existingRecord.providerSessionId
        ) {
          canResume = true;
          resumableProviderSessionId = existingRecord.providerSessionId;
        } else if (
          existingRecord.config.provider !== currentFingerprint.provider
          || existingRecord.config.backend !== currentFingerprint.backend
        ) {
          warnings.push(
            `Config changed from ${existingRecord.config.provider}/${existingRecord.config.backend} to ${currentFingerprint.provider}/${currentFingerprint.backend} since stage ${nextStage} was started. Previous progress cannot be resumed — session IDs are not portable across backends. Falling back to default behavior.`
          );
        }
      }
    } else {
      // 3. No existing record — try to resume from prior stage
      if (nextIndex > 0) {
        for (let i = nextIndex - 1; i >= 0; i--) {
          const priorStageName = STAGE_ORDER[i];
          const priorRecord = session.stages[priorStageName];
          if (!priorRecord?.completedAt) continue;

          if (
            priorRecord.config.provider === currentFingerprint.provider
            && priorRecord.providerSessionId
          ) {
            canResume = true;
            resumableProviderSessionId = priorRecord.providerSessionId;
          } else if (
            priorRecord.config.provider !== currentFingerprint.provider
          ) {
            warnings.push(
              `Provider for ${nextStage} (${currentFingerprint.provider}) differs from ${priorStageName} (${priorRecord.config.provider}). Prior stage summary will still be available as context.`
            );
          }
          break;
        }
      }
    }

    return { canResume, resumableProviderSessionId, priorSummary, warnings };
  }

  isExpired(state: SessionState): boolean {
    const ttlDays = this.configService.get<number>('session.ttlInDays') ?? DEFAULT_TTL_DAYS;
    const createdAt = new Date(state.createdAt);
    const now = new Date();
    const diffMs = now.getTime() - createdAt.getTime();
    return diffMs > ttlDays * 24 * 60 * 60 * 1000;
  }

  async deleteBySessionId(sessionId: string): Promise<boolean> {
    const dir = this.getSessionDir();
    if (!fs.existsSync(dir)) return false;

    const files = fs
      .readdirSync(dir)
      .filter(f => f.endsWith(`-${sessionId}.json`) || f.endsWith(`-${sessionId}.items.json`));
    for (const file of files) {
      fs.unlinkSync(path.join(dir, file));
    }
    return files.length > 0;
  }

  async deleteByDateRange(from: Date, to: Date): Promise<number> {
    const sessions = await this.listSessions();
    let count = 0;
    for (const session of sessions) {
      const createdAt = new Date(session.createdAt);
      if (createdAt >= from && createdAt <= to) {
        await this.deleteBySessionId(session.sessionId);
        count++;
      }
    }
    return count;
  }

  async deleteByPattern(pattern: string): Promise<number> {
    const sessions = await this.listSessions();
    const regex = new RegExp(pattern);
    let count = 0;
    for (const session of sessions) {
      if (regex.test(session.ticketKey)) {
        await this.deleteBySessionId(session.sessionId);
        count++;
      }
    }
    return count;
  }

  async listSessions(filter?: { ticketKey?: string; completed?: boolean }): Promise<SessionState[]> {
    const dir = this.getSessionDir();
    if (!fs.existsSync(dir)) return [];

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.items.json'));
    const sessions: SessionState[] = [];

    for (const file of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
        const state = sessionStateSchema.parse(raw);

        if (filter?.ticketKey && state.ticketKey !== filter.ticketKey) continue;
        if (filter?.completed === true && !state.completedAt) continue;
        if (filter?.completed === false && state.completedAt) continue;

        sessions.push(state);
      } catch {
        continue;
      }
    }

    return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
