import { Command, CommandRunner } from 'nest-commander';
import { StageEngineService } from '../core/stage-engine/stage-engine.service';
import { StateManagerService } from '../core/state-manager/state-manager.service';
import { WorkflowParserService } from '../core/workflow-parser/workflow-parser.service';
import { LoggerService } from '../shared/logger/logger.service';
import { ErrorHandler } from '../shared/utils/error-handler';
import chalk from 'chalk';

@Command({
  name: 'resume',
  description: 'Resume a paused or failed workflow execution',
  arguments: '<execution-id>',
  options: { isDefault: false },
})
export class ResumeCommand extends CommandRunner {
  constructor(
    private stageEngine: StageEngineService,
    private stateManager: StateManagerService,
    private workflowParser: WorkflowParserService,
    private logger: LoggerService,
  ) {
    super();
  }

  async run(passedParams: string[]): Promise<void> {
    const executionId = passedParams[0];

    if (!executionId) {
      console.error(chalk.red('Error: Execution ID is required'));
      console.log(chalk.gray('\nUsage: wf resume <execution-id>'));
      console.log(chalk.gray('Use "wf history" to see recent executions\n'));
      process.exit(1);
    }

    try {
      console.log(
        chalk.bold.cyan(`\n🔄 Resuming workflow execution: ${executionId}\n`),
      );

      // Load state
      const state = await this.stateManager.loadState(executionId);

      // Display state info
      console.log(chalk.bold('Workflow:'), chalk.white(state.workflowId));
      console.log(chalk.bold('Status:'), this.formatStatus(state.status));
      console.log(
        chalk.bold('Progress:'),
        chalk.white(`${state.results.length} steps completed`),
      );
      console.log(
        chalk.bold('Created:'),
        chalk.white(new Date(state.createdAt).toLocaleString()),
      );
      console.log();

      if (state.status === 'completed') {
        console.log(chalk.yellow('⚠️  This workflow has already completed'));
        console.log(chalk.gray('Nothing to resume\n'));
        return;
      }

      // Find and parse the workflow
      this.logger.info(`Finding workflow: ${state.workflowId}`);
      const workflow = await this.workflowParser.findWorkflowByName(
        state.workflowId,
      );

      console.log(chalk.bold.green('🚀 Resuming workflow execution...\n'));

      // Resume execution
      const result = await this.stageEngine.resumeWorkflow(
        executionId,
        workflow,
      );

      // Display results
      console.log(chalk.bold.green('\n✅ Workflow resumed and completed!'));
      console.log(chalk.gray('━'.repeat(60)));
      console.log(chalk.bold('Execution ID:'), chalk.white(result.executionId));
      console.log(
        chalk.bold('Final Status:'),
        this.formatStatus(result.status),
      );
      console.log(
        chalk.bold('Steps Completed:'),
        chalk.white(`${result.results.length}/${workflow.steps.length}`),
      );
      console.log(
        chalk.bold('Duration:'),
        chalk.white(this.formatDuration(result.createdAt, result.updatedAt)),
      );
      console.log(chalk.gray('━'.repeat(60)));
      console.log();
    } catch (error) {
      ErrorHandler.handle(error as Error);
    }
  }

  private formatStatus(status: string): string {
    const statusColors: Record<string, any> = {
      completed: chalk.green,
      running: chalk.blue,
      failed: chalk.red,
      cancelled: chalk.yellow,
      'pending-approval': chalk.yellow,
      paused: chalk.yellow,
    };

    const colorFn = statusColors[status] || chalk.white;
    return colorFn(status.toUpperCase());
  }

  private formatDuration(start: Date, end: Date): string {
    const duration = new Date(end).getTime() - new Date(start).getTime();
    const seconds = Math.floor(duration / 1000);
    const minutes = Math.floor(seconds / 60);

    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  }
}
