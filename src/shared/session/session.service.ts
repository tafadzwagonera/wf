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
  ProviderSessionCandidate,
  SessionValidationResult,
} from '../types/session.types';
import { getWfSessionDir } from '../utils/wf-paths';
import { buildSessionFileName, stripSessionDatePrefix } from '../utils/session-file-name';
import { appendToLogFile } from '../logger/log-file-writer';

const stageOrder = ['plan', 'implement', 'review', 'commit'];
const resumeStageOrder = ['fetch', ...stageOrder];
const DEFAULT_TTL_DAYS = 7;

const resumableCombinations = new Set([
  'anthropic/agent',
  'anthropic/cli',
  'openai/cli',
]);

/**
 * @param fingerprint - Provider and backend pair to evaluate
 * @returns True when the backend can resume from a prior session ID
 */
export const isResumableBackend = (fingerprint: StageConfigFingerprint): boolean =>
  resumableCombinations.has(`${fingerprint.provider}/${fingerprint.backend}`);

type ResumeWarningContext = {
  configChanged: boolean;
  hasNonResumableBackend: boolean;
  pushChangedWarning: () => void;
  pushNonResumableWarning: () => void;
  pushMissingSessionIdWarning: () => void;
};

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
  pushMissingSessionIdStageWarning: (stage: string, warnings: string[]) => void;
  hasNonResumableBackend: (first: StageConfigFingerprint, second: StageConfigFingerprint) => boolean;
  fingerprintsDiffer: (first: StageConfigFingerprint, second: StageConfigFingerprint) => boolean;
};

const buildInterruptedStageWarningPushers = (
  params: InterruptedStageWarningContextParams
): Pick<ResumeWarningContext, 'pushChangedWarning' | 'pushNonResumableWarning' | 'pushMissingSessionIdWarning'> => ({
  pushChangedWarning: () => params.pushStageConfigChangedWarning(
    params.nextStage, params.existingRecord.config, params.currentFingerprint, params.warnings
  ),
  pushNonResumableWarning: () => params.pushNonResumableStageWarning(
    params.nextStage, params.currentFingerprint, params.warnings
  ),
  pushMissingSessionIdWarning: () => params.pushMissingSessionIdStageWarning(params.nextStage, params.warnings),
});

const buildInterruptedStageWarningContext = (
  params: InterruptedStageWarningContextParams
): ResumeWarningContext => ({
  configChanged: params.fingerprintsDiffer(params.existingRecord.config, params.currentFingerprint),
  hasNonResumableBackend: params.hasNonResumableBackend(params.existingRecord.config, params.currentFingerprint),
  ...buildInterruptedStageWarningPushers(params),
});

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
  pushMissingSessionIdPriorStageWarning: (nextStage: string, priorStageName: string, warnings: string[]) => void;
  hasNonResumableBackend: (first: StageConfigFingerprint, second: StageConfigFingerprint) => boolean;
  fingerprintsDiffer: (first: StageConfigFingerprint, second: StageConfigFingerprint) => boolean;
};

const buildPriorStageWarningPushers = (
  params: PriorStageWarningContextParams
): Pick<ResumeWarningContext, 'pushChangedWarning' | 'pushNonResumableWarning' | 'pushMissingSessionIdWarning'> => ({
  pushChangedWarning: () => params.pushPriorStageWarning(
    params.nextStage, params.currentFingerprint.provider, params.stageName,
    params.record.config.provider, params.warnings
  ),
  pushNonResumableWarning: () => params.pushNonResumablePriorStageWarning(
    params.nextStage, params.record.config, params.warnings
  ),
  pushMissingSessionIdWarning: () => params.pushMissingSessionIdPriorStageWarning(
    params.nextStage, params.stageName, params.warnings
  ),
});

const buildPriorStageWarningContext = (
  params: PriorStageWarningContextParams
): ResumeWarningContext => ({
  configChanged: params.fingerprintsDiffer(params.record.config, params.currentFingerprint),
  hasNonResumableBackend: params.hasNonResumableBackend(params.record.config, params.currentFingerprint),
  ...buildPriorStageWarningPushers(params),
});

/**
 * Writes an INFO stage-lifecycle record.
 *
 * The log previously carried no stage transitions at all — only adapter-level DEBUG/WARN
 * lines — so a run could not be traced back to which stage was active when it died.
 *
 * @param event - Lifecycle event name
 * @param fields - Structured fields rendered as `key=value` pairs
 */
const logStageLifecycle = (event: string, fields: Record<string, string | number>): void => {
  const rendered = Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(' ');
  appendToLogFile('INFO', `${event} ${rendered}`, 'session');
};

@Injectable()
export class SessionService {
  constructor(private readonly configService: ConfigService) {}

  getSessionDir(): string {
    return getWfSessionDir();
  }

  async save(state: SessionState): Promise<void> {
    const dir = this.getSessionDir();
    fs.mkdirSync(dir, { recursive: true });
    const fileName = buildSessionFileName(state);
    const filePath = path.join(dir, fileName);
    const tmpPath = `${filePath}.tmp.${crypto.randomUUID()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
    fs.renameSync(tmpPath, filePath);
    this.removeSupersededSessionFiles(dir, state.sessionId, fileName);
  }

  private removeSupersededSessionFiles(dir: string, sessionId: string, keepFileName: string): void {
    const superseded = this.listSessionFiles(dir)
      .filter(file => file !== keepFileName && file.endsWith(`-${sessionId}.json`));
    for (const file of superseded) fs.unlinkSync(path.join(dir, file));
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

    const prefix = `${ticketKey}-`;
    const matches = this.listSessionFiles(dir)
      .filter(file => file.startsWith(prefix) || stripSessionDatePrefix(file).startsWith(prefix));
    return this.findActiveSession(matches);
  }

  /**
   * Finds the most recent session whose given stage was recorded with this provider
   * session ID — the anchor for `wf issue:review --session-id <providerSessionId>`,
   * where the caller supplies an AI-provider conversation ID rather than wf's own
   * state-file `sessionId`.
   *
   * @param providerSessionId - AI provider session ID recorded on the given stage
   * @param stage - Stage whose `providerSessionId` should be matched
   * @returns The most recently created matching session, or null if none match
   */
  async findByProviderSessionId(providerSessionId: string, stage: string): Promise<SessionState | null> {
    const dir = this.getSessionDir();
    if (!fs.existsSync(dir)) return null;

    const matches = this.readSessionStates(dir)
      .filter(state => state.stages[stage]?.providerSessionId === providerSessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return matches[0] ?? null;
  }

  async recordStageStart(
    session: SessionState,
    stage: string,
    fingerprint: StageConfigFingerprint,
    model: string
  ): Promise<SessionState> {
    if (this.canReuseStageRecord(session, stage, fingerprint)) return session;
    logStageLifecycle('stage.start', {
      stage, session: session.sessionId, model,
      provider: fingerprint.provider, backend: fingerprint.backend,
    });
    return this.persistSession(this.setStageRecord(session, stage, this.createStageRecord(fingerprint, model)));
  }

  /**
   * Append the models a stage actually ran with.
   *
   * Kept separate from `model` — which is resolved before the stage starts — because the
   * implement stage auto-routes per step, so the configured model and the model that ran
   * can differ. Existing entries are preserved and duplicates collapsed, since a stage may
   * report more than once across continuation and verification passes.
   *
   * @param session - Session being updated
   * @param stage - Stage name whose record should be updated
   * @param models - Models observed on this run
   * @returns The persisted session, unchanged when the stage was never started
   */
  async recordStageModels(session: SessionState, stage: string, models: string[]): Promise<SessionState> {
    if (!session.stages[stage] || models.length === 0) return session;
    return this.persistSession(
      this.updateStage(session, stage, record => ({
        ...record,
        modelsUsed: [...new Set([...record.modelsUsed, ...models])],
      }))
    );
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
    const record = session.stages[stage];
    logStageLifecycle('stage.complete', {
      stage,
      session: session.sessionId,
      elapsedMs: Date.now() - Date.parse(record.startedAt),
      modelsUsed: record.modelsUsed.join(',') || record.model,
    });
    return this.persistSession(
      this.updateStage(session, stage, record => ({ ...record, summary, completedAt: new Date().toISOString() }))
    );
  }

  /**
   * Records the branch this session's implementation forked from, so a later `issue:review`
   * run — possibly a separate process/machine — can recover it via {@link findByTicketKey}
   * instead of re-guessing from branch-name heuristics.
   *
   * @param session - Session to update
   * @param sourceBranch - The branch the session's feature branch was created from
   * @returns The persisted, updated session
   */
  async recordSourceBranch(session: SessionState, sourceBranch: string): Promise<SessionState> {
    const updated: SessionState = { ...session, sourceBranch, updatedAt: new Date().toISOString() };
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
    const warnings = this.collectConfigDriftWarnings(session, resolveStageFingerprint);
    const priorSummary = this.findPriorSummary(session, nextStage);
    const providerSessionCandidate = this.resolveCompatibleProviderSession(
      session, nextStage, currentFingerprint, warnings
    );
    return this.createSessionValidationResult(providerSessionCandidate, priorSummary, warnings);
  }

  private createSessionValidationResult(
    providerSessionCandidate: ProviderSessionCandidate | null, priorSummary: string | null, warnings: string[]
  ): SessionValidationResult {
    const resumableProviderSessionId = providerSessionCandidate?.providerSessionId ?? null;
    return {
      canResume: Boolean(resumableProviderSessionId),
      providerSessionCandidate,
      resumableProviderSessionId,
      priorSummary,
      warnings,
    };
  }

  getLatestCompatibleProviderSession(
    session: SessionState,
    nextStage: string,
    currentFingerprint: StageConfigFingerprint
  ): ProviderSessionCandidate | null {
    return this.resolveCompatibleProviderSession(session, nextStage, currentFingerprint, []);
  }

  isExpired(state: SessionState): boolean {
    const ttlDays = this.configService.get<number>('session.ttlInDays') ?? DEFAULT_TTL_DAYS;
    const createdAt = new Date(state.createdAt);
    const now = new Date();
    const diffMs = now.getTime() - createdAt.getTime();
    return diffMs > ttlDays * 24 * 60 * 60 * 1000;
  }

  inferNextStage(session: SessionState): string | null {
    const lastCompleted = resumeStageOrder.findLastIndex(stage => session.stages[stage]?.completedAt);
    if (lastCompleted < 0) return session.sourceType === 'custom' ? 'plan' : 'fetch';
    if (lastCompleted >= resumeStageOrder.length - 1) return null;
    return resumeStageOrder[lastCompleted + 1];
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
      config: { provider: fingerprint.provider, backend: fingerprint.backend },
      model,
      modelsUsed: [],
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
    const nextIndex = stageOrder.indexOf(nextStage);
    if (nextIndex <= 0) return null;

    for (let i = nextIndex - 1; i >= 0; i--) {
      const priorRecord = session.stages[stageOrder[i]];
      if (priorRecord?.completedAt && priorRecord.summary) return priorRecord.summary;
    }
    return null;
  }

  private resolveCompatibleProviderSession(
    session: SessionState,
    nextStage: string,
    currentFingerprint: StageConfigFingerprint,
    warnings: string[]
  ): ProviderSessionCandidate | null {
    return this.resolveInterruptedStageResume(
      session.stages[nextStage], currentFingerprint, nextStage, warnings
    ) ?? this.resolvePriorStageResume(session, nextStage, currentFingerprint, warnings);
  }

  private resolveInterruptedStageResume(
    existingRecord: StageRecord | undefined, currentFingerprint: StageConfigFingerprint,
    nextStage: string, warnings: string[]
  ): ProviderSessionCandidate | null {
    if (!existingRecord || existingRecord.completedAt) {
      this.pushCompletedStageWarningWhenComplete(nextStage, existingRecord, warnings);
      return null;
    }
    if (this.canResumeStageRecord(existingRecord, currentFingerprint)) {
      this.pushModelChangedWarning(existingRecord, currentFingerprint, nextStage, warnings);
      return this.createProviderSessionCandidate(nextStage, existingRecord);
    }
    this.pushInterruptedResumeWarnings(existingRecord, currentFingerprint, nextStage, warnings);
    return null;
  }

  private pushInterruptedResumeWarnings(
    record: StageRecord, fingerprint: StageConfigFingerprint, stage: string, warnings: string[]
  ): void {
    this.pushInterruptedStageWarnings(record, fingerprint, stage, warnings);
  }

  private pushCompletedStageWarningWhenComplete(
    stage: string, record: StageRecord | undefined, warnings: string[]
  ): void {
    if (record?.completedAt) this.pushCompletedStageWarning(stage, record.completedAt, warnings);
  }

  private resolvePriorStageResume(session: SessionState, nextStage: string,
    currentFingerprint: StageConfigFingerprint, warnings: string[]): ProviderSessionCandidate | null {
    const nextIndex = stageOrder.indexOf(nextStage);
    for (let i = nextIndex - 1; i >= 0; i--) {
      const stageName = stageOrder[i];
      const record = session.stages[stageName];
      if (!record?.completedAt) continue;
      if (this.canResumeStageRecord(record, currentFingerprint)) {
        this.pushPriorStageModelWarning(record, currentFingerprint, nextStage, stageName, warnings);
        return this.createProviderSessionCandidate(stageName, record);
      }
      this.pushPriorStageWarnings(record, currentFingerprint, nextStage, stageName, warnings);
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

  private createProviderSessionCandidate(stage: string, record: StageRecord): ProviderSessionCandidate {
    if (!record.providerSessionId) {
      throw new Error(`Cannot create provider session candidate without an ID for stage ${stage}`);
    }
    return {
      stage,
      provider: record.config.provider,
      backend: record.config.backend,
      providerSessionId: record.providerSessionId,
      recordedAt: record.startedAt,
    };
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

  private findDriftedModels(
    record: StageRecord, fingerprint: StageConfigFingerprint
  ): { recorded: string; current: string } | null {
    const current = fingerprint.model;
    const recordedModels = [record.model, ...record.modelsUsed].filter(Boolean);
    const recorded = recordedModels[0];
    return current && recorded && !recordedModels.includes(current) ? { recorded, current } : null;
  }

  private buildModelChangedWarning(stage: string, recordedModel: string, currentModel: string): string {
    return `Stage ${stage} session was recorded with model ${recordedModel} but wf.config now resolves to `
      + `${currentModel}. The session can still be resumed — provider sessions are portable across models — `
      + `and will continue with ${currentModel}.`;
  }

  private buildPriorStageModelWarning(
    nextStage: string, currentModel: string, priorStageName: string, recordedModel: string
  ): string {
    return `Model for ${nextStage} (${currentModel}) differs from ${priorStageName}'s recorded ${recordedModel}. `
      + 'The session can still be resumed — provider sessions are portable across models — '
      + `and will continue with ${currentModel}.`;
  }

  private pushModelChangedWarning(
    record: StageRecord, fingerprint: StageConfigFingerprint, stage: string, warnings: string[]
  ): void {
    const drift = this.findDriftedModels(record, fingerprint);
    if (drift) warnings.push(this.buildModelChangedWarning(stage, drift.recorded, drift.current));
  }

  private pushPriorStageModelWarning(
    record: StageRecord, fingerprint: StageConfigFingerprint, nextStage: string, priorStage: string,
    warnings: string[]
  ): void {
    const drift = this.findDriftedModels(record, fingerprint);
    if (drift) warnings.push(this.buildPriorStageModelWarning(nextStage, drift.current, priorStage, drift.recorded));
  }

  private buildNonResumableStageWarning(stage: string, config: StageConfigFingerprint): string {
    return `Stage ${stage} ran with ${config.provider}/${config.backend}, which does not support session resumption. Starting fresh.`;
  }

  private buildNonResumablePriorStageWarning(nextStage: string, config: StageConfigFingerprint): string {
    return `Stage ${nextStage} cannot resume from ${config.provider}/${config.backend} session IDs. Prior stage summary will still be available as context.`;
  }

  private buildMissingSessionIdStageWarning(stage: string): string {
    return `Stage ${stage} was interrupted before a provider session ID was recorded, so its session cannot be resumed.`;
  }

  private buildMissingSessionIdPriorStageWarning(nextStage: string, priorStageName: string): string {
    return `Stage ${priorStageName} completed without a recorded provider session ID, so ${nextStage} cannot resume from it. `
      + 'Prior stage summary will still be available as context.';
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
        pushMissingSessionIdStageWarning: this.pushMissingSessionIdStageWarning.bind(this),
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
        pushMissingSessionIdPriorStageWarning: this.pushMissingSessionIdPriorStageWarning.bind(this),
        hasNonResumableBackend: this.hasNonResumableBackend.bind(this),
        fingerprintsDiffer: this.fingerprintsDiffer.bind(this),
      })
    );

  private pushResumeWarnings(params: ResumeWarningContext): void {
    if (params.configChanged) {
      params.pushChangedWarning();
      if (params.hasNonResumableBackend) params.pushNonResumableWarning();
      return;
    }
    if (params.hasNonResumableBackend) params.pushNonResumableWarning();
    else params.pushMissingSessionIdWarning();
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

  private pushMissingSessionIdStageWarning(stage: string, warnings: string[]): void {
    warnings.push(this.buildMissingSessionIdStageWarning(stage));
  }

  private pushMissingSessionIdPriorStageWarning(
    nextStage: string,
    priorStageName: string,
    warnings: string[]
  ): void {
    warnings.push(this.buildMissingSessionIdPriorStageWarning(nextStage, priorStageName));
  }
}
