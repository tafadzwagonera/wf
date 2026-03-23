import { Command, CommandRunner, Option } from 'nest-commander';
import { StateManagerService } from '../core/state-manager/state-manager.service';
import { WorkflowStatus } from '../common/interfaces';
import { LoggerService } from '../shared/logger/logger.service';
import { ErrorHandler } from '../shared/utils/error-handler';
import chalk from 'chalk';

interface HistoryOptions {
  status?: WorkflowStatus;
  limit?: number;
  workflow?: string;
}

@Command({
  name: 'history',
  description: 'Show workflow execution history',
  options: { isDefault: false },
})
export class HistoryCommand extends CommandRunner {
  constructor(
    private stateManager: StateManagerService,
    private logger: LoggerService,
  ) {
    super();
  }

  async run(passedParams: string[], options?: HistoryOptions): Promise<void> {
    try {
      console.log(chalk.bold.cyan('\n📜 Workflow Execution History\n'));

      // Query state with filters
      const states = await this.stateManager.listStates({
        status: options?.status,
        limit: options?.limit || 20,
        workflowId: options?.workflow,
      });

      if (states.length === 0) {
        console.log(chalk.yellow('No executions found\n'));
        return;
      }

      // Display executions
      states.forEach((state, index) => {
        const number = chalk.gray(`${index + 1}.`);
        const status = this.formatStatus(state.status);
        const workflow = chalk.bold.white(state.workflowId);
        const date = chalk.gray(new Date(state.createdAt).toLocaleString());
        const id = chalk.cyan(state.executionId.substring(0, 8));

        console.log(`${number} ${status} ${workflow}`);
        console.log(chalk.gray(`   ID: ${id}  |  ${date}`));

        if (state.results.length > 0) {
          console.log(
            chalk.gray(`   Steps: ${state.results.length} completed`),
          );
        }

        if (state.completedAt) {
          const duration = this.formatDuration(
            new Date(state.createdAt),
            new Date(state.completedAt),
          );
          console.log(chalk.gray(`   Duration: ${duration}`));
        }

        console.log();
      });

      console.log(chalk.gray('━'.repeat(60)));
      console.log(chalk.gray(`Showing ${states.length} execution(s)\n`));

      // Show resume hint for incomplete executions
      const incomplete = states.filter(
        (s) =>
          s.status === WorkflowStatus.RUNNING ||
          s.status === WorkflowStatus.PENDING_APPROVAL ||
          s.status === WorkflowStatus.PAUSED,
      );

      if (incomplete.length > 0) {
        console.log(chalk.blue(`💡 Tip: Resume incomplete executions with:`));
        console.log(chalk.gray(`   wf resume <execution-id>\n`));
      }
    } catch (error) {
      ErrorHandler.handle(error as Error);
    }
  }

  private formatStatus(status: string): string {
    const statusMap: Record<string, { icon: string; color: any }> = {
      completed: { icon: '✓', color: chalk.green },
      running: { icon: '●', color: chalk.blue },
      failed: { icon: '✗', color: chalk.red },
      cancelled: { icon: '⊘', color: chalk.yellow },
      'pending-approval': { icon: '◐', color: chalk.yellow },
      paused: { icon: '‖', color: chalk.yellow },
    };

    const config = statusMap[status] || { icon: '?', color: chalk.white };
    return config.color(`${config.icon} ${status.toUpperCase()}`);
  }

  private formatDuration(start: Date, end: Date): string {
    const duration = end.getTime() - start.getTime();
    const seconds = Math.floor(duration / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  }

  @Option({
    flags: '-s, --status <status>',
    description: 'Filter by status (completed, running, failed, cancelled)',
  })
  parseStatus(val: string): WorkflowStatus {
    return val as WorkflowStatus;
  }

  @Option({
    flags: '-l, --limit <number>',
    description: 'Maximum number of results (default: 20)',
  })
  parseLimit(val: string): number {
    return parseInt(val, 10);
  }

  @Option({
    flags: '-w, --workflow <name>',
    description: 'Filter by workflow name',
  })
  parseWorkflow(val: string): string {
    return val;
  }
}
