import { randomUUID } from 'node:crypto';
import { appendToLogFile } from '../../../shared/logger/log-file-writer';
import type { BoundedStderr } from '../../../shared/utils/bounded-stderr';

export type CliKillReason = 'inactivity' | 'wall-clock' | 'sigint' | 'cleanup';

export interface CliRunIdentity {
  runId: string;
  binary: string;
  model: string | undefined;
  cwd: string;
  args: string[];
  envKeys: string[];
  promptChars: number;
  timeoutMs: number;
  inactivityTimeoutMs: number;
}

export interface CliExitRecord {
  exited: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: Error;
}

const largeValueFlags = new Set(['--append-system-prompt', '--json-schema']);
const SENSITIVE_FLAG_PATTERN = /key|token|secret|password|auth/i;
const MAX_GENERIC_VALUE_CHARS = 200;
const DEFAULT_STDERR_TAIL_CHARS = 2000;

export const buildRunId = (): string => randomUUID().slice(0, 8);

export const extractArgValue = (args: string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  if (index === -1 || index === args.length - 1) return undefined;
  return args[index + 1];
};

const renderArgValue = (flag: string | undefined, value: string): string => {
  if (flag && largeValueFlags.has(flag)) return `<${value.length} chars>`;
  if (flag && SENSITIVE_FLAG_PATTERN.test(flag)) return '<redacted>';
  if (value.length > MAX_GENERIC_VALUE_CHARS) {
    return `${value.slice(0, MAX_GENERIC_VALUE_CHARS)}…[+${value.length - MAX_GENERIC_VALUE_CHARS}]`;
  }
  return value;
};

const isFlag = (token: string): boolean => token.startsWith('-');

export const summarizeCliArgs = (args: string[]): string => {
  const rendered: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    const next = args[i + 1];
    if (isFlag(token) && next !== undefined && !isFlag(next)) {
      rendered.push(token, renderArgValue(token, next));
      i += 1;
    } else {
      rendered.push(token);
    }
  }
  return rendered.join(' ');
};

export const formatStderrTail = (full: string, maxChars: number = DEFAULT_STDERR_TAIL_CHARS): string =>
  full.length > maxChars ? full.slice(full.length - maxChars) : full;

const buildRecord = (fields: Record<string, string | number>): string =>
  Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(' ');

export const logCliSpawn = (identity: CliRunIdentity): void => {
  const line = `cli.spawn ${buildRecord({
    run: identity.runId,
    bin: identity.binary,
    model: identity.model ?? 'unknown',
    cwd: identity.cwd,
    timeoutMs: identity.timeoutMs,
    inactivityTimeoutMs: identity.inactivityTimeoutMs,
    promptChars: identity.promptChars,
    envKeys: `[${identity.envKeys.join(',')}]`,
  })} argv=${summarizeCliArgs(identity.args)}`;
  appendToLogFile('DEBUG', line, 'claude-cli');
};

export const logCliSpawnError = (opts: { runId: string; error: Error }): void => {
  const line = `cli.spawn_error ${buildRecord({ run: opts.runId })} message=${JSON.stringify(opts.error.message)}`;
  appendToLogFile('ERROR', line, 'claude-cli');
};

const buildExitLine = (opts: { runId: string; exitRecord: CliExitRecord; elapsedMs: number }): string =>
  `cli.exit ${buildRecord({
    run: opts.runId,
    code: opts.exitRecord.code ?? 'null',
    signal: opts.exitRecord.signal ?? 'null',
    elapsedMs: opts.elapsedMs,
  })}`;

export const logCliExit = (opts: { runId: string; exitRecord: CliExitRecord; elapsedMs: number }): void => {
  const { code, signal } = opts.exitRecord;
  const level = code === 0 && signal === null ? 'DEBUG' : 'WARN';
  appendToLogFile(level, buildExitLine(opts), 'claude-cli');
};

interface CliKillOpts {
  runId: string;
  reason: CliKillReason;
  elapsedMs: number;
  inactivityTimeoutMs: number;
  timeoutMs: number;
}

const buildKillLine = (opts: CliKillOpts): string =>
  `cli.kill ${buildRecord({
    run: opts.runId,
    reason: opts.reason,
    elapsedMs: opts.elapsedMs,
    inactivityTimeoutMs: opts.inactivityTimeoutMs,
    timeoutMs: opts.timeoutMs,
  })}`;

export const logCliKill = (opts: CliKillOpts): void => {
  if (opts.reason === 'cleanup') return;
  appendToLogFile('WARN', buildKillLine(opts), 'claude-cli');
};

export const logCliSigkillEscalation = (opts: { runId: string; reason: CliKillReason }): void => {
  const line = `cli.sigkill ${buildRecord({ run: opts.runId, reason: opts.reason })}`;
  appendToLogFile('WARN', line, 'claude-cli');
};

interface CliRunSummaryOpts {
  runId: string;
  messageCount: number;
  elapsedMs: number;
  killReason: CliKillReason | undefined;
  stderr: BoundedStderr;
}

const buildRunSummaryLine = (opts: CliRunSummaryOpts, stderrTail: string): string =>
  `cli.done ${buildRecord({
    run: opts.runId,
    messages: opts.messageCount,
    elapsedMs: opts.elapsedMs,
    killReason: opts.killReason ?? 'none',
    stderrChars: opts.stderr.totalBytes(),
  })}${stderrTail ? ` stderr(tail)=${stderrTail}` : ''}`;

export const logCliRunSummary = (opts: CliRunSummaryOpts): void => {
  const stderrTail = formatStderrTail(opts.stderr.text());
  const level = (opts.killReason && opts.killReason !== 'cleanup') || Boolean(stderrTail) ? 'WARN' : 'DEBUG';
  appendToLogFile(level, buildRunSummaryLine(opts, stderrTail), 'claude-cli');
};
