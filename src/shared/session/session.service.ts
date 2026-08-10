import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { sessionStateSchema } from '../schemas/session.schema';
import type {
  SessionState,
  StageConfigFingerprint,
  StageRecord,
  SessionValidationResult,
} from '../types/session.types';
import { getWfSessionDir } from '../utils/wf-paths';

const STAGE_ORDER = ['plan', 'implement', 'review', 'commit'];
const RESUME_STAGE_ORDER = ['fetch', ...STAGE_ORDER];
const DEFAULT_TTL_DAYS = 7;

const RESUMABLE_COMBINATIONS = new Set([
  'anthropic/agent',
  'anthropic/cli',
  'openai/cli',
]);

/**
 * @param fingerprint - Provider and backend pair to evaluate
 * @returns True when the backend can resume from a prior session ID
 */
const isResumableBackend = (fingerprint: StageConfigFingerprint): boolean =>
  RESUMABLE_COMBINATIONS.has(`${fingerprint.provider}/${fingerprint.backend}`);

type ResumeWarningContext = {
  configChanged: boolean;
  hasNonResumableBackend: boolean;
  pushChangedWarning: () => void;
  pushNonResumableWarning: () => void;
};

const createResumeWarningContext = (
  configChanged: boolean,
  hasNonResumableBackend: boolean,
  pushChangedWarning: () => void,
  pushNonResumableWarning: () => void
): ResumeWarningContext => ({
  configChanged,
  hasNonResumableBackend,
  pushChangedWarning,
  pushNonResumableWarning,
});

type InterruptedStageWarningContextParams = {
  existingRecord: StageRecord;
  currentFingerprint: StageConfigFingerprint;
  nextStage: string;
  warnings: string[];
  pushStageConfigChangedWarning: (
    stage: string,
    fromConfig: StageConfigFingerprint,
    toConfig: StageConfigFingerprint,
    warnings: string[]
  ) => void;
  pushNonResumableStageWarning: (stage: string, config: StageConfigFingerprint, warnings: string[]) => void;
  hasNonResumableBackend: (first: StageConfigFingerprint, second: StageConfigFingerprint) => boolean;
  fingerprintsDiffer: (first: StageConfigFingerprint, second: StageConfigFingerprint) => boolean;
};

const buildInterruptedStageWarningContext = (
  params: InterruptedStageWarningContextParams
): ResumeWarningContext =>
  createResumeWarningContext(
    params.fingerprintsDiffer(params.existingRecord.config, params.currentFingerprint),
    params.hasNonResumableBackend(params.existingRecord.config, params.currentFingerprint),
    () => params.pushStageConfigChangedWarning(
      params.nextStage,
      params.existingRecord.config,
      params.currentFingerprint,
      params.warnings
    ),
    () => params.pushNonResumableStageWarning(params.nextStage, params.currentFingerprint, params.warnings)
  );

type PriorStageWarningContextParams = {
  record: StageRecord;
  currentFingerprint: StageConfigFingerprint;
  nextStage: string;
  stageName: string;
  warnings: string[];
  pushPriorStageWarning: (
    nextStage: string,
    currentProvider: string,
    priorStageName: string,
    priorProvider: string,
    warnings: string[]
  ) => void;
  pushNonResumablePriorStageWarning: (nextStage: string, config: StageConfigFingerprint, warnings: string[]) => void;
  hasNonResumableBackend: (first: StageConfigFingerprint, second: StageConfigFingerprint) => boolean;
  fingerprintsDiffer: (first: StageConfigFingerprint, second: StageConfigFingerprint) => boolean;
};

const buildPriorStageWarningContext = (
  params: PriorStageWarningContextParams
): ResumeWarningContext =>
  createResumeWarningContext(
    params.fingerprintsDiffer(params.record.config, params.currentFingerprint),
    params.hasNonResumableBackend(params.record.config, params.currentFingerprint),
    () => params.pushPriorStageWarning(
      params.nextStage,
      params.currentFingerprint.provider,
      params.stageName,
      params.record.config.provider,
      params.warnings
    ),
    () => params.pushNonResumablePriorStageWarning(params.nextStage, params.record.config, params.warnings)
  );

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

    const match = this.listSessionFiles(dir).find(file => file.endsWith(`-${sessionId}.json`));
    if (!match) return null;

    return this.readSessionState(path.join(dir, match));
  }

  async findByTicketKey(ticketKey: string): Promise<SessionState | null> {
    const dir = this.getSessionDir();
    if (!fs.existsSync(dir)) return null;

    return this.findActiveSession(this.listSessionFiles(dir).filter(file => file.startsWith(`${ticketKey}-`)));
  }

  async recordStageStart(
    session: SessionState,
    stage: string,
    fingerprint: StageConfigFingerprint,
    model: string
  ): Promise<SessionState> {
    if (this.canReuseStageRecord(session, stage, fingerprint)) return session;
    return this.persistSession(this.setStageRecord(session, stage, this.createStageRecord(fingerprint, model)));
  }

  async recordProviderSessionId(
    session: SessionState,
    stage: string,
    providerSessionId: string
  ): Promise<SessionState> {
    if (!session.stages[stage]) return session;
    return this.persistSession(
      this.updateStage(session, stage, record => ({ ...record, providerSessionId }))
    );
  }

  async recordStageComplete(session: SessionState, stage: string, summary: string | null): Promise<SessionState> {
    if (!session.stages[stage]) return session;
    return this.persistSession(
      this.updateStage(session, stage, record => ({ ...record, summary, completedAt: new Date().toISOString() }))
    );
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
    const warnings = this.collectConfigDriftWarnings(session, resolveStageFingerprint);
    const priorSummary = this.findPriorSummary(session, nextStage);
    const resumableProviderSessionId = this.resolveResumableProviderSessionId(
      session, nextStage, currentFingerprint, warnings
    );
    return { canResume: Boolean(resumableProviderSessionId), resumableProviderSessionId, priorSummary, warnings };
  }

  isExpired(state: SessionState): boolean {
    const ttlDays = this.configService.get<number>('session.ttlInDays') ?? DEFAULT_TTL_DAYS;
    const createdAt = new Date(state.createdAt);
    const now = new Date();
    const diffMs = now.getTime() - createdAt.getTime();
    return diffMs > ttlDays * 24 * 60 * 60 * 1000;
  }

  inferNextStage(session: SessionState): string | null {
    const lastCompleted = RESUME_STAGE_ORDER.findLastIndex(stage => session.stages[stage]?.completedAt);
    if (lastCompleted < 0) return session.sourceType === 'custom' ? 'plan' : 'fetch';
    if (lastCompleted >= RESUME_STAGE_ORDER.length - 1) return null;
    return RESUME_STAGE_ORDER[lastCompleted + 1];
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

  async listSessions(filter?: { ticketKey?: string; completed?: boolean }): Promise<SessionState[]> {
    const dir = this.getSessionDir();
    if (!fs.existsSync(dir)) return [];

    return this.readSessionStates(dir)
      .filter(state => this.matchesSessionFilter(state, filter))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private listSessionFiles(dir: string): string[] {
    return fs
      .readdirSync(dir)
      .filter(f => f.endsWith('.json') && !f.endsWith('.items.json'))
      .sort((first, second) => first.localeCompare(second));
  }

  private readSessionState(filePath: string): SessionState | null {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return sessionStateSchema.parse(raw);
    } catch {
      return null;
    }
  }

  private readSessionStates(dir: string): SessionState[] {
    return this.listSessionFiles(dir)
      .map(file => this.readSessionState(path.join(dir, file)))
      .filter((state): state is SessionState => state !== null);
  }

  private findActiveSession(files: string[]): SessionState | null {
    const dir = this.getSessionDir();
    for (const file of files) {
      const state = this.readSessionState(path.join(dir, file));
      if (state && !state.completedAt && !this.isExpired(state)) return state;
    }
    return null;
  }

  private matchesSessionFilter(
    state: SessionState,
    filter?: { ticketKey?: string; completed?: boolean }
  ): boolean {
    if (filter?.ticketKey && state.ticketKey !== filter.ticketKey) return false;
    if (filter?.completed === true && !state.completedAt) return false;
    return !(filter?.completed === false && state.completedAt);
  }

  private canReuseStageRecord(
    session: SessionState,
    stage: string,
    fingerprint: StageConfigFingerprint
  ): boolean {
    const existing = session.stages[stage];
    return Boolean(
      existing
      && existing.config.provider === fingerprint.provider
      && existing.config.backend === fingerprint.backend
      && !existing.completedAt
      && isResumableBackend(existing.config)
      && isResumableBackend(fingerprint)
    );
  }

  private createStageRecord(fingerprint: StageConfigFingerprint, model: string): StageRecord {
    return {
      config: fingerprint,
      model,
      providerSessionId: null,
      summary: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
  }

  private updateStage(
    session: SessionState,
    stage: string,
    updateRecord: (record: StageRecord) => StageRecord
  ): SessionState {
    const record = session.stages[stage];
    if (!record) return session;

    return {
      ...session,
      updatedAt: new Date().toISOString(),
      stages: { ...session.stages, [stage]: updateRecord(record) },
    };
  }

  private setStageRecord(session: SessionState, stage: string, record: StageRecord): SessionState {
    return {
      ...session,
      updatedAt: new Date().toISOString(),
      stages: { ...session.stages, [stage]: record },
    };
  }

  private async persistSession(session: SessionState): Promise<SessionState> {
    await this.save(session);
    return session;
  }

  private collectConfigDriftWarnings(
    session: SessionState,
    resolveStageFingerprint: (stage: string) => StageConfigFingerprint
  ): string[] {
    const warnings: string[] = [];
    for (const [stageName, record] of Object.entries(session.stages)) {
      if (!record.completedAt) continue;
      const currentConfig = resolveStageFingerprint(stageName);
      if (this.fingerprintsDiffer(record.config, currentConfig)) {
        warnings.push(this.buildConfigDriftWarning(stageName, record.config, currentConfig));
      }
    }
    return warnings;
  }

  private findPriorSummary(session: SessionState, nextStage: string): string | null {
    const nextIndex = STAGE_ORDER.indexOf(nextStage);
    if (nextIndex <= 0) return null;

    for (let i = nextIndex - 1; i >= 0; i--) {
      const priorRecord = session.stages[STAGE_ORDER[i]];
      if (priorRecord?.completedAt && priorRecord.summary) return priorRecord.summary;
    }
    return null;
  }

  private resolveResumableProviderSessionId(
    session: SessionState,
    nextStage: string,
    currentFingerprint: StageConfigFingerprint,
    warnings: string[]
  ): string | null {
    return this.resolveInterruptedStageResume(
      session.stages[nextStage], currentFingerprint, nextStage, warnings
    ) ?? this.resolvePriorStageResume(session, nextStage, currentFingerprint, warnings);
  }

  private resolveInterruptedStageResume(
    existingRecord: StageRecord | undefined,
    currentFingerprint: StageConfigFingerprint,
    nextStage: string,
    warnings: string[]
  ): string | null {
    if (!existingRecord || existingRecord.completedAt) {
      if (existingRecord?.completedAt) this.pushCompletedStageWarning(nextStage, existingRecord.completedAt, warnings);
      return null;
    }
    if (this.canResumeStageRecord(existingRecord, currentFingerprint)) return existingRecord.providerSessionId;
    this.pushInterruptedStageWarnings(existingRecord, currentFingerprint, nextStage, warnings);
    return null;
  }

  private resolvePriorStageResume(
    session: SessionState,
    nextStage: string,
    currentFingerprint: StageConfigFingerprint,
    warnings: string[]
  ): string | null {
    const priorStage = this.findMostRecentCompletedPriorStage(session, nextStage);
    if (!priorStage) return null;
    const { stageName, record } = priorStage;
    if (this.canResumeStageRecord(record, currentFingerprint)) return record.providerSessionId;
    this.pushPriorStageWarnings(record, currentFingerprint, nextStage, stageName, warnings);
    return null;
  }

  private findMostRecentCompletedPriorStage(
    session: SessionState,
    nextStage: string
  ): { stageName: string; record: StageRecord } | null {
    const nextIndex = STAGE_ORDER.indexOf(nextStage);
    if (nextIndex <= 0) return null;

    for (let i = nextIndex - 1; i >= 0; i--) {
      const stageName = STAGE_ORDER[i];
      const record = session.stages[stageName];
      if (record?.completedAt) return { stageName, record };
    }
    return null;
  }

  private canResumeStageRecord(record: StageRecord, fingerprint: StageConfigFingerprint): boolean {
    return Boolean(
      record.config.provider === fingerprint.provider
      && record.providerSessionId
      && isResumableBackend(record.config)
      && isResumableBackend(fingerprint)
    );
  }

  private fingerprintsDiffer(
    first: StageConfigFingerprint,
    second: StageConfigFingerprint
  ): boolean {
    return first.provider !== second.provider || first.backend !== second.backend;
  }

  private buildCompletedStageWarning(stage: string, completedAt: string): string {
    return `Stage ${stage} was already completed at ${completedAt}. Re-running will overwrite.`;
  }

  private pushCompletedStageWarning(stage: string, completedAt: string, warnings: string[]): void {
    warnings.push(this.buildCompletedStageWarning(stage, completedAt));
  }

  private buildStageConfigChangedWarning(
    stage: string,
    fromConfig: StageConfigFingerprint,
    toConfig: StageConfigFingerprint
  ): string {
    return `Config changed from ${fromConfig.provider}/${fromConfig.backend} to `
      + `${toConfig.provider}/${toConfig.backend} since stage ${stage} was started. `
      + 'Previous progress cannot be resumed — session IDs are not portable across backends. '
      + 'Falling back to default behavior.';
  }

  private buildConfigDriftWarning(
    stage: string,
    fromConfig: StageConfigFingerprint,
    toConfig: StageConfigFingerprint
  ): string {
    return `Config drift detected: stage ${stage} ran with ${fromConfig.provider}/${fromConfig.backend} but wf.config now resolves to ${toConfig.provider}/${toConfig.backend}.`;
  }

  private buildPriorStageWarning(
    nextStage: string,
    currentProvider: string,
    priorStageName: string,
    priorProvider: string
  ): string {
    return `Provider for ${nextStage} (${currentProvider}) differs from ${priorStageName} (${priorProvider}). `
      + 'Prior stage summary will still be available as context.';
  }

  private buildNonResumableStageWarning(stage: string, config: StageConfigFingerprint): string {
    return `Stage ${stage} ran with ${config.provider}/${config.backend}, which does not support session resumption. Starting fresh.`;
  }

  private buildNonResumablePriorStageWarning(nextStage: string, config: StageConfigFingerprint): string {
    return `Stage ${nextStage} cannot resume from ${config.provider}/${config.backend} session IDs. Prior stage summary will still be available as context.`;
  }

  private pushStageConfigChangedWarning(
    stage: string,
    fromConfig: StageConfigFingerprint,
    toConfig: StageConfigFingerprint,
    warnings: string[]
  ): void {
    if (this.fingerprintsDiffer(fromConfig, toConfig)) {
      warnings.push(this.buildStageConfigChangedWarning(stage, fromConfig, toConfig));
    }
  }

  // eslint-disable-next-line max-lines-per-function
  private readonly pushInterruptedStageWarnings = (
    existingRecord: StageRecord,
    currentFingerprint: StageConfigFingerprint,
    nextStage: string,
    warnings: string[]
  ): void =>
    this.pushResumeWarnings(
      buildInterruptedStageWarningContext({
        existingRecord,
        currentFingerprint,
        nextStage,
        warnings,
        pushStageConfigChangedWarning: this.pushStageConfigChangedWarning.bind(this),
        pushNonResumableStageWarning: this.pushNonResumableStageWarning.bind(this),
        hasNonResumableBackend: this.hasNonResumableBackend.bind(this),
        fingerprintsDiffer: this.fingerprintsDiffer.bind(this),
      })
    );

  // eslint-disable-next-line max-lines-per-function
  private readonly pushPriorStageWarnings = (
    record: StageRecord,
    currentFingerprint: StageConfigFingerprint,
    nextStage: string,
    stageName: string,
    warnings: string[]
  ): void =>
    this.pushResumeWarnings(
      buildPriorStageWarningContext({
        record,
        currentFingerprint,
        nextStage,
        stageName,
        warnings,
        pushPriorStageWarning: this.pushPriorStageWarning.bind(this),
        pushNonResumablePriorStageWarning: this.pushNonResumablePriorStageWarning.bind(this),
        hasNonResumableBackend: this.hasNonResumableBackend.bind(this),
        fingerprintsDiffer: this.fingerprintsDiffer.bind(this),
      })
    );

  private pushResumeWarnings(params: {
    configChanged: boolean;
    hasNonResumableBackend: boolean;
    pushChangedWarning: () => void;
    pushNonResumableWarning: () => void;
  }): void {
    if (params.configChanged) params.pushChangedWarning();
    if (!params.configChanged) params.pushNonResumableWarning();
    if (params.configChanged && params.hasNonResumableBackend) params.pushNonResumableWarning();
  }

  private hasNonResumableBackend(
    first: StageConfigFingerprint,
    second: StageConfigFingerprint
  ): boolean {
    return !isResumableBackend(first) || !isResumableBackend(second);
  }

  private pushPriorStageWarning(
    nextStage: string,
    currentProvider: string,
    priorStageName: string,
    priorProvider: string,
    warnings: string[]
  ): void {
    if (priorProvider !== currentProvider) {
      warnings.push(this.buildPriorStageWarning(nextStage, currentProvider, priorStageName, priorProvider));
    }
  }

  private pushNonResumableStageWarning(
    stage: string,
    config: StageConfigFingerprint,
    warnings: string[]
  ): void {
    warnings.push(this.buildNonResumableStageWarning(stage, config));
  }

  private pushNonResumablePriorStageWarning(
    nextStage: string,
    config: StageConfigFingerprint,
    warnings: string[]
  ): void {
    warnings.push(this.buildNonResumablePriorStageWarning(nextStage, config));
  }
}
