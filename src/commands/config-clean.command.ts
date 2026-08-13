import { SubCommand, CommandRunner, Option } from 'nest-commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { SessionService } from '../shared/session/session.service';
import type { SessionState } from '../shared/types/session.types';
import { ValidationError } from '../shared/utils/errors';
import { executeAsyncWithCatch } from '../shared/utils/execute-with-catch';

type SessionPredicate = (s: SessionState) => boolean;

const createdBefore = (date: string): SessionPredicate => {
  const threshold = new Date(date);
  return s => new Date(s.createdAt) < threshold;
};

const createdAfter = (date: string): SessionPredicate => {
  const threshold = new Date(date);
  return s => new Date(s.createdAt) > threshold;
};

const matchesPattern = (pattern: string): SessionPredicate => {
  const regex = new RegExp(pattern);
  return s => regex.test(s.ticketKey);
};

interface ConfigCleanOptions {
  after?: string;
  before?: string;
  dryRun?: boolean;
  expired?: boolean;
  force?: boolean;
  pattern?: string;
  sessionId?: string;
  ticket?: string;
}

@SubCommand({
  name: 'clean',
  description: 'Delete session state files by ID, ticket key, date range, or pattern',
})
export class ConfigCleanCommand extends CommandRunner {
  constructor(private readonly sessionService: SessionService) {
    super();
  }

  @Option({
    flags: '--session-id <id>',
    description: 'Delete a specific wf session by its UUID',
  })
  parseSessionId(val: string): string {
    return val;
  }

  @Option({
    flags: '--ticket <key>',
    description: 'Delete all sessions for a ticket key (exact match)',
  })
  parseTicket(val: string): string {
    return val;
  }

  @Option({
    flags: '--before <date>',
    description: 'Delete sessions created before this ISO date',
  })
  parseBefore(val: string): string {
    return val;
  }

  @Option({
    flags: '--after <date>',
    description: 'Delete sessions created after this ISO date',
  })
  parseAfter(val: string): string {
    return val;
  }

  @Option({
    flags: '--pattern <regex>',
    description: 'Delete sessions whose ticket key matches this regex',
  })
  parsePattern(val: string): string {
    return val;
  }

  @Option({
    flags: '--expired',
    description: 'Delete all expired sessions (> configured TTL)',
  })
  parseExpired(): boolean {
    return true;
  }

  @Option({
    flags: '--dry-run',
    description: 'List matching sessions without deleting',
  })
  parseDryRun(): boolean {
    return true;
  }

  @Option({
    flags: '--force',
    description: 'Skip confirmation prompt (for non-interactive use)',
  })
  parseForce(): boolean {
    return true;
  }

  async run(_passedParams: string[], options?: ConfigCleanOptions): Promise<void> {
    await executeAsyncWithCatch({
      fn: async () => {
        this.validateHasFilter(options);
        const sessions = await this.filterSessions(options);

        if (!sessions.length) {
          console.log(chalk.yellow('No matching sessions found.'));
          return;
        }

        this.displayMatchedSessions(sessions);

        if (options?.dryRun) {
          console.log(chalk.yellow('Dry run — no sessions deleted.'));
          return;
        }

        await this.confirmOrThrow(sessions.length, options?.force);
        const deletedCount = await this.deleteSessions(sessions);
        console.log(chalk.green(`Deleted ${deletedCount} session(s).`));
      },
    });
  }

  private validateHasFilter(options?: ConfigCleanOptions): void {
    const hasFilter
      = options?.sessionId
        || options?.ticket
        || options?.before
        || options?.after
        || options?.pattern
        || options?.expired;

    if (!hasFilter) {
      throw new ValidationError(
        'At least one filter is required (--session-id, --ticket, --before, --after, --pattern, or --expired)',
      );
    }
  }

  private async filterSessions(options?: ConfigCleanOptions): Promise<SessionState[]> {
    const sessions = await this.sessionService.listSessions();
    const predicates = this.buildFilterPredicates(options);
    return sessions.filter(s => predicates.every(p => p(s)));
  }

  private buildFilterPredicates(options?: ConfigCleanOptions): SessionPredicate[] {
    const { sessionId, ticket, before, after, pattern, expired } = options ?? {};
    const predicates: SessionPredicate[] = [];

    if (sessionId) predicates.push(s => s.sessionId === sessionId);
    if (ticket) predicates.push(s => s.ticketKey === ticket);
    if (before) predicates.push(createdBefore(before));
    if (after) predicates.push(createdAfter(after));
    if (pattern) predicates.push(matchesPattern(pattern));
    if (expired) predicates.push(s => this.sessionService.isExpired(s));

    return predicates;
  }

  private displayMatchedSessions(sessions: SessionState[]): void {
    console.log(chalk.bold.cyan(`\nMatched ${sessions.length} session(s):\n`));
    for (const session of sessions) {
      const stageCount = Object.keys(session.stages).length;
      const status = this.sessionStatus(session);
      console.log(
        chalk.gray(
          `  ${session.ticketKey}  ${session.sessionId}  created: ${session.createdAt}  stages: ${stageCount}  status: ${status}`,
        ),
      );
    }
    console.log();
  }

  private sessionStatus(session: SessionState): string {
    if (session.completedAt) return 'completed';
    if (this.sessionService.isExpired(session)) return 'expired';
    return 'active';
  }

  private async confirmOrThrow(count: number, force?: boolean): Promise<void> {
    if (force) return;
    if (!(process.stdout.isTTY && process.stdin.isTTY)) {
      throw new ValidationError('Non-interactive mode requires --force to delete sessions.');
    }
    const { confirm } = await inquirer.prompt([
      { type: 'confirm', name: 'confirm', message: `Delete ${count} session(s)?`, prefix: ' ', default: false },
    ]);
    if (confirm) return;
    console.log(chalk.yellow('Aborted.'));
    throw new ValidationError('User cancelled deletion.');
  }

  private async deleteSessions(sessions: SessionState[]): Promise<number> {
    let deletedCount = 0;
    for (const session of sessions) {
      const deleted = await this.sessionService.deleteBySessionId(session.sessionId);
      if (deleted) deletedCount++;
    }
    return deletedCount;
  }
}
