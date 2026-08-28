jest.mock('chalk', () => {
  const identity = (s: any) => s;
  const makeChain = () => {
    const chain: any = identity;
    for (const name of [
      'bold',
      'dim',
      'italic',
      'underline',
      'inverse',
      'strikethrough',
      'black',
      'red',
      'green',
      'yellow',
      'blue',
      'magenta',
      'cyan',
      'white',
      'gray',
      'grey',
    ]) {
      chain[name] = identity;
    }
    return chain;
  };
  const chalk = makeChain();
  chalk.bold = makeChain();
  return { default: chalk, ...chalk };
});

jest.mock('inquirer', () => ({
  __esModule: true,
  default: {
    prompt: jest.fn(),
  },
}));

import inquirer from 'inquirer';
import { ConfigCleanCommand } from './config-clean.command';
import { ErrorHandler } from '../shared/utils/error-handler';
import type { SessionState } from '../shared/types/session.types';

const mockPrompt = inquirer.prompt as jest.MockedFunction<typeof inquirer.prompt>;

const setIsTTY = (stream: NodeJS.ReadStream | NodeJS.WriteStream, value: boolean): void => {
  Object.defineProperty(stream, 'isTTY', { value, configurable: true, writable: true });
};

function createMockSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: 'session-1',
    ticketKey: 'TICKET-1',
    toStage: null,
    action: null,
    sourceType: null,
    customPlanRef: null,
    sourceBranch: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    stages: {},
    ...overrides,
  };
}

function createMockSessionService(overrides: {
  listSessions?: jest.Mock;
  isExpired?: jest.Mock;
  deleteBySessionId?: jest.Mock;
} = {}) {
  return {
    listSessions: overrides.listSessions ?? jest.fn().mockResolvedValue([]),
    isExpired: overrides.isExpired ?? jest.fn().mockReturnValue(false),
    deleteBySessionId: overrides.deleteBySessionId ?? jest.fn().mockResolvedValue(true),
  };
}

describe('ConfigCleanCommand', () => {
  let handleErrorSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let originalStdoutIsTTY: boolean;
  let originalStdinIsTTY: boolean;

  beforeEach(() => {
    handleErrorSpy = jest.spyOn(ErrorHandler, 'handle').mockImplementation((error: Error) => {
      throw error;
    });
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    mockPrompt.mockReset();
    originalStdoutIsTTY = process.stdout.isTTY;
    originalStdinIsTTY = process.stdin.isTTY;
  });

  afterEach(() => {
    setIsTTY(process.stdout, originalStdoutIsTTY);
    setIsTTY(process.stdin, originalStdinIsTTY);
    jest.restoreAllMocks();
  });

  describe('filtering', () => {
    it('deletes only the session matching --session-id', async () => {
      const sessionA = createMockSession({ sessionId: 'a' });
      const sessionB = createMockSession({ sessionId: 'b' });
      const deleteBySessionId = jest.fn().mockResolvedValue(true);
      const sessionService = createMockSessionService({
        listSessions: jest.fn().mockResolvedValue([sessionA, sessionB]),
        deleteBySessionId,
      });
      const command = new ConfigCleanCommand(sessionService as any);

      await command.run([], { sessionId: 'a', force: true });

      expect(deleteBySessionId).toHaveBeenCalledTimes(1);
      expect(deleteBySessionId).toHaveBeenCalledWith('a');
    });

    it('deletes only sessions matching --ticket', async () => {
      const sessionA = createMockSession({ sessionId: 'a', ticketKey: 'TICKET-A' });
      const sessionB = createMockSession({ sessionId: 'b', ticketKey: 'TICKET-B' });
      const deleteBySessionId = jest.fn().mockResolvedValue(true);
      const sessionService = createMockSessionService({
        listSessions: jest.fn().mockResolvedValue([sessionA, sessionB]),
        deleteBySessionId,
      });
      const command = new ConfigCleanCommand(sessionService as any);

      await command.run([], { ticket: 'TICKET-A', force: true });

      expect(deleteBySessionId).toHaveBeenCalledTimes(1);
      expect(deleteBySessionId).toHaveBeenCalledWith('a');
    });

    it('deletes only sessions created before --before', async () => {
      const older = createMockSession({ sessionId: 'older', createdAt: '2026-01-01T00:00:00.000Z' });
      const newer = createMockSession({ sessionId: 'newer', createdAt: '2026-03-01T00:00:00.000Z' });
      const deleteBySessionId = jest.fn().mockResolvedValue(true);
      const sessionService = createMockSessionService({
        listSessions: jest.fn().mockResolvedValue([older, newer]),
        deleteBySessionId,
      });
      const command = new ConfigCleanCommand(sessionService as any);

      await command.run([], { before: '2026-02-01T00:00:00.000Z', force: true });

      expect(deleteBySessionId).toHaveBeenCalledTimes(1);
      expect(deleteBySessionId).toHaveBeenCalledWith('older');
    });

    it('deletes only sessions created after --after', async () => {
      const older = createMockSession({ sessionId: 'older', createdAt: '2026-01-01T00:00:00.000Z' });
      const newer = createMockSession({ sessionId: 'newer', createdAt: '2026-03-01T00:00:00.000Z' });
      const deleteBySessionId = jest.fn().mockResolvedValue(true);
      const sessionService = createMockSessionService({
        listSessions: jest.fn().mockResolvedValue([older, newer]),
        deleteBySessionId,
      });
      const command = new ConfigCleanCommand(sessionService as any);

      await command.run([], { after: '2026-02-01T00:00:00.000Z', force: true });

      expect(deleteBySessionId).toHaveBeenCalledTimes(1);
      expect(deleteBySessionId).toHaveBeenCalledWith('newer');
    });

    it('deletes only sessions whose ticket key matches --pattern', async () => {
      const matching = createMockSession({ sessionId: 'matching', ticketKey: 'PROJ-123' });
      const nonMatching = createMockSession({ sessionId: 'non-matching', ticketKey: 'OTHER-1' });
      const deleteBySessionId = jest.fn().mockResolvedValue(true);
      const sessionService = createMockSessionService({
        listSessions: jest.fn().mockResolvedValue([matching, nonMatching]),
        deleteBySessionId,
      });
      const command = new ConfigCleanCommand(sessionService as any);

      await command.run([], { pattern: '^PROJ-', force: true });

      expect(deleteBySessionId).toHaveBeenCalledTimes(1);
      expect(deleteBySessionId).toHaveBeenCalledWith('matching');
    });

    it('deletes only expired sessions with --expired', async () => {
      const expired = createMockSession({ sessionId: 'expired' });
      const active = createMockSession({ sessionId: 'active' });
      const isExpired = jest.fn(session => session.sessionId === 'expired');
      const deleteBySessionId = jest.fn().mockResolvedValue(true);
      const sessionService = createMockSessionService({
        listSessions: jest.fn().mockResolvedValue([expired, active]),
        isExpired,
        deleteBySessionId,
      });
      const command = new ConfigCleanCommand(sessionService as any);

      await command.run([], { expired: true, force: true });

      expect(deleteBySessionId).toHaveBeenCalledTimes(1);
      expect(deleteBySessionId).toHaveBeenCalledWith('expired');
    });

    it('ANDs combined --ticket and --before filters', async () => {
      const matchesBoth = createMockSession({
        sessionId: 'both',
        ticketKey: 'TICKET-A',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      const matchesTicketOnly = createMockSession({
        sessionId: 'ticket-only',
        ticketKey: 'TICKET-A',
        createdAt: '2026-03-01T00:00:00.000Z',
      });
      const matchesDateOnly = createMockSession({
        sessionId: 'date-only',
        ticketKey: 'TICKET-B',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      const deleteBySessionId = jest.fn().mockResolvedValue(true);
      const sessionService = createMockSessionService({
        listSessions: jest.fn().mockResolvedValue([matchesBoth, matchesTicketOnly, matchesDateOnly]),
        deleteBySessionId,
      });
      const command = new ConfigCleanCommand(sessionService as any);

      await command.run([], { ticket: 'TICKET-A', before: '2026-02-01T00:00:00.000Z', force: true });

      expect(deleteBySessionId).toHaveBeenCalledTimes(1);
      expect(deleteBySessionId).toHaveBeenCalledWith('both');
    });

    it('treats an empty-string --ticket as absent and requires a filter', async () => {
      const sessionService = createMockSessionService();
      const command = new ConfigCleanCommand(sessionService as any);

      await expect(command.run([], { ticket: '' })).rejects.toThrow(
        'At least one filter is required (--session-id, --ticket, --before, --after, --pattern, or --expired)',
      );
      expect(handleErrorSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('throws a ValidationError via ErrorHandler when no filter is provided', async () => {
    const sessionService = createMockSessionService();
    const command = new ConfigCleanCommand(sessionService as any);

    await expect(command.run([], {})).rejects.toThrow(
      'At least one filter is required (--session-id, --ticket, --before, --after, --pattern, or --expired)',
    );
    expect(handleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it('logs "No matching sessions found." and never deletes when there are no matches', async () => {
    const deleteBySessionId = jest.fn().mockResolvedValue(true);
    const sessionService = createMockSessionService({
      listSessions: jest.fn().mockResolvedValue([]),
      deleteBySessionId,
    });
    const command = new ConfigCleanCommand(sessionService as any);

    await command.run([], { sessionId: 'missing', force: true });

    expect(logSpy).toHaveBeenCalledWith('No matching sessions found.');
    expect(deleteBySessionId).not.toHaveBeenCalled();
  });

  it('lists sessions but deletes nothing with --dry-run', async () => {
    const session = createMockSession({ sessionId: 'a' });
    const deleteBySessionId = jest.fn().mockResolvedValue(true);
    const sessionService = createMockSessionService({
      listSessions: jest.fn().mockResolvedValue([session]),
      deleteBySessionId,
    });
    const command = new ConfigCleanCommand(sessionService as any);

    await command.run([], { sessionId: 'a', dryRun: true });

    expect(logSpy).toHaveBeenCalledWith('Dry run — no sessions deleted.');
    expect(deleteBySessionId).not.toHaveBeenCalled();
  });

  it('skips the confirmation prompt and deletes all matches with --force', async () => {
    const sessionA = createMockSession({ sessionId: 'a', ticketKey: 'TICKET-1' });
    const sessionB = createMockSession({ sessionId: 'b', ticketKey: 'TICKET-1' });
    const deleteBySessionId = jest.fn().mockResolvedValue(true);
    const sessionService = createMockSessionService({
      listSessions: jest.fn().mockResolvedValue([sessionA, sessionB]),
      deleteBySessionId,
    });
    const command = new ConfigCleanCommand(sessionService as any);

    await command.run([], { ticket: 'TICKET-1', force: true });

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(deleteBySessionId).toHaveBeenCalledTimes(2);
  });

  // confirmOrThrow covers four (force × isTTY) combinations:
  //   force=true,  isTTY=true  → early return (tested via --force above)
  //   force=true,  isTTY=false → early return (tested via --force above)
  //   force=false, isTTY=true  → prompts (decline → Aborted, accept → deletes)
  //   force=false, isTTY=false → throws non-interactive error
  it('logs "Aborted." then throws via ErrorHandler when the interactive confirm is declined', async () => {
    setIsTTY(process.stdout, true);
    setIsTTY(process.stdin, true);
    mockPrompt.mockResolvedValue({ confirm: false });
    const session = createMockSession({ sessionId: 'a' });
    const deleteBySessionId = jest.fn().mockResolvedValue(true);
    const sessionService = createMockSessionService({
      listSessions: jest.fn().mockResolvedValue([session]),
      deleteBySessionId,
    });
    const command = new ConfigCleanCommand(sessionService as any);

    await expect(command.run([], { sessionId: 'a' })).rejects.toThrow('User cancelled deletion.');

    expect(logSpy).toHaveBeenCalledWith('Aborted.');
    expect(handleErrorSpy).toHaveBeenCalledTimes(1);
    expect(deleteBySessionId).not.toHaveBeenCalled();
  });

  it('deletes all matches when the interactive confirm is accepted', async () => {
    setIsTTY(process.stdout, true);
    setIsTTY(process.stdin, true);
    mockPrompt.mockResolvedValue({ confirm: true });
    const session = createMockSession({ sessionId: 'a' });
    const deleteBySessionId = jest.fn().mockResolvedValue(true);
    const sessionService = createMockSessionService({
      listSessions: jest.fn().mockResolvedValue([session]),
      deleteBySessionId,
    });
    const command = new ConfigCleanCommand(sessionService as any);

    await command.run([], { sessionId: 'a' });

    expect(mockPrompt).toHaveBeenCalledWith([
      { type: 'confirm', name: 'confirm', message: 'Delete 1 session(s)?', prefix: ' ', default: false },
    ]);
    expect(deleteBySessionId).toHaveBeenCalledWith('a');
  });

  it('throws a ValidationError via ErrorHandler in non-interactive mode without --force', async () => {
    setIsTTY(process.stdout, false);
    setIsTTY(process.stdin, false);
    const session = createMockSession({ sessionId: 'a' });
    const deleteBySessionId = jest.fn().mockResolvedValue(true);
    const sessionService = createMockSessionService({
      listSessions: jest.fn().mockResolvedValue([session]),
      deleteBySessionId,
    });
    const command = new ConfigCleanCommand(sessionService as any);

    await expect(command.run([], { sessionId: 'a' })).rejects.toThrow(
      'Non-interactive mode requires --force to delete sessions.',
    );

    expect(handleErrorSpy).toHaveBeenCalledTimes(1);
    expect(mockPrompt).not.toHaveBeenCalled();
    expect(deleteBySessionId).not.toHaveBeenCalled();
  });

  it('excludes sessions whose deleteBySessionId resolves false from the printed count', async () => {
    const sessionA = createMockSession({ sessionId: 'a', ticketKey: 'TICKET-1' });
    const sessionB = createMockSession({ sessionId: 'b', ticketKey: 'TICKET-1' });
    const deleteBySessionId = jest.fn().mockImplementation((sessionId: string) =>
      Promise.resolve(sessionId === 'a'));
    const sessionService = createMockSessionService({
      listSessions: jest.fn().mockResolvedValue([sessionA, sessionB]),
      deleteBySessionId,
    });
    const command = new ConfigCleanCommand(sessionService as any);

    await command.run([], { ticket: 'TICKET-1', force: true });

    expect(logSpy).toHaveBeenCalledWith('Deleted 1 session(s).');
  });

  describe('status labels', () => {
    it('labels a session with completedAt as "completed"', async () => {
      const session = createMockSession({ sessionId: 'a', completedAt: '2026-01-02T00:00:00.000Z' });
      const isExpired = jest.fn().mockReturnValue(false);
      const sessionService = createMockSessionService({
        listSessions: jest.fn().mockResolvedValue([session]),
        isExpired,
      });
      const command = new ConfigCleanCommand(sessionService as any);

      await command.run([], { sessionId: 'a', dryRun: true });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('status: completed'));
    });

    it('labels an incomplete, expired session as "expired"', async () => {
      const session = createMockSession({ sessionId: 'a', completedAt: null });
      const isExpired = jest.fn().mockReturnValue(true);
      const sessionService = createMockSessionService({
        listSessions: jest.fn().mockResolvedValue([session]),
        isExpired,
      });
      const command = new ConfigCleanCommand(sessionService as any);

      await command.run([], { sessionId: 'a', dryRun: true });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('status: expired'));
    });

    it('labels an incomplete, non-expired session as "active"', async () => {
      const session = createMockSession({ sessionId: 'a', completedAt: null });
      const isExpired = jest.fn().mockReturnValue(false);
      const sessionService = createMockSessionService({
        listSessions: jest.fn().mockResolvedValue([session]),
        isExpired,
      });
      const command = new ConfigCleanCommand(sessionService as any);

      await command.run([], { sessionId: 'a', dryRun: true });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('status: active'));
    });
  });
});
