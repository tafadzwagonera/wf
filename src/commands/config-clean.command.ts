import { SubCommand, CommandRunner, Option } from 'nest-commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { SessionService } from '../shared/session/session.service';
import { ErrorHandler } from '../shared/utils/error-handler';
import { ValidationError } from '../shared/utils/errors';

interface ConfigCleanOptions {
  sessionId?: string;
  ticket?: string;
  before?: string;
  after?: string;
  pattern?: string;
  expired?: boolean;
  dryRun?: boolean;
  force?: boolean;
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
    try {
      const hasFilter =
        options?.sessionId ||
        options?.ticket ||
        options?.before ||
        options?.after ||
        options?.pattern ||
        options?.expired;

      if (!hasFilter) {
        throw new ValidationError(
          'At least one filter is required (--session-id, --ticket, --before, --after, --pattern, or --expired)'
        );
      }

      let sessions = await this.sessionService.listSessions();

      if (options?.sessionId) {
        sessions = sessions.filter(s => s.sessionId === options.sessionId);
      }

      if (options?.ticket) {
        sessions = sessions.filter(s => s.ticketKey === options.ticket);
      }

      if (options?.before) {
        const beforeDate = new Date(options.before);
        sessions = sessions.filter(s => new Date(s.createdAt) < beforeDate);
      }

      if (options?.after) {
        const afterDate = new Date(options.after);
        sessions = sessions.filter(s => new Date(s.createdAt) > afterDate);
      }

      if (options?.pattern) {
        const regex = new RegExp(options.pattern);
        sessions = sessions.filter(s => regex.test(s.ticketKey));
      }

      if (options?.expired) {
        sessions = sessions.filter(s => this.sessionService.isExpired(s));
      }

      if (sessions.length === 0) {
        console.log(chalk.yellow('No matching sessions found.'));
        return;
      }

      console.log(chalk.bold.cyan(`\nMatched ${sessions.length} session(s):\n`));
      for (const session of sessions) {
        const stageCount = Object.keys(session.stages).length;
        const status = session.completedAt
          ? 'completed'
          : this.sessionService.isExpired(session)
            ? 'expired'
            : 'active';
        console.log(
          chalk.gray(
            `  ${session.ticketKey}  ${session.sessionId}  created: ${session.createdAt}  stages: ${stageCount}  status: ${status}`
          )
        );
      }
      console.log();

      if (options?.dryRun) {
        console.log(chalk.yellow('Dry run — no sessions deleted.'));
        return;
      }

      const isInteractive = process.stdout.isTTY && process.stdin.isTTY;
      if (!options?.force && isInteractive) {
        const { confirm } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirm',
            message: `Delete ${sessions.length} session(s)?`,
            prefix: ' ',
            default: false,
          },
        ]);
        if (!confirm) {
          console.log(chalk.yellow('Aborted.'));
          return;
        }
      }

      if (!options?.force && !isInteractive) {
        throw new ValidationError('Non-interactive mode requires --force to delete sessions.');
      }

      let deletedCount = 0;
      for (const session of sessions) {
        const deleted = await this.sessionService.deleteBySessionId(session.sessionId);
        if (deleted) deletedCount++;
      }

      console.log(chalk.green(`Deleted ${deletedCount} session(s).`));
    } catch (error) {
      ErrorHandler.handle(error as Error);
    }
  }
}
