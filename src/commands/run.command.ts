import { Injectable } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { WorkflowParserService } from '../core/workflow-parser/workflow-parser.service';
import { StageEngineService } from '../core/stage-engine/stage-engine.service';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { ErrorHandler } from '../shared/utils/error-handler';
import { ExecutionStep } from '../common/interfaces/workflow.interface';
import chalk from 'chalk';

interface RunCommandOptions {
  params?: string;
  autoExecute?: boolean;
  dryRun?: boolean;
}

@Injectable()
@Command({
  name: 'run',
  description: 'Execute a workflow',
  arguments: '<workflow-name>',
  options: { isDefault: false },
})
export class RunCommand extends CommandRunner {
  constructor(
    private workflowParser: WorkflowParserService,
    private stageEngine: StageEngineService,
    private logger: LoggerService,
    private dryRunPreview: DryRunPreviewService,
  ) {
    super();
  }

  async run(
    passedParams: string[],
    options?: RunCommandOptions,
  ): Promise<void> {
    const workflowName = passedParams[0];

    if (!workflowName) {
      console.error(chalk.red('Error: Workflow name is required'));
      console.log(chalk.gray('\nUsage: wf run <workflow-name> [options]'));
      console.log(
        chalk.gray('Example: wf run issue fix ./jira/bug.md service-tourv3'),
      );
      process.exit(1);
    }

    try {
      this.logger.info(`Loading workflow: ${workflowName}`);

      // Parse workflow
      const workflow = await this.workflowParser.findWorkflow(workflowName);

      // Parse parameters from command line or --params option
      const parameters = this.parseParameters(
        passedParams.slice(1),
        options?.params,
      );

      // Dry run mode
      if (options?.dryRun) {
        this.dryRunPreview.showHeader('run', workflowName);

        const stepLines: string[] = [];
        workflow.steps.forEach((step: ExecutionStep, index: number) => {
          stepLines.push(
            `${index + 1}. ${step.title}` +
              (step.requiresApproval ? '  [Approval Required]' : '') +
              (step.retryable ? '  [Retryable]' : ''),
          );
          step.instructions.forEach((instruction) => {
            stepLines.push(`   - ${instruction}`);
          });
        });

        this.dryRunPreview.showSummary({
          apiCallCount: 0,
          fileCreatedCount: 0,
          fileModifiedCount: 0,
          gitOperationCount: 0,
          terminalOutputLines: [
            `Workflow: ${workflow.metadata.name}`,
            `Description: ${workflow.metadata.description}`,
            `Steps: ${workflow.steps.length}`,
            `Auto Execution: ${workflow.metadata.autoExecutionMode ? 'Yes' : 'No'}`,
            '',
            ...stepLines,
          ],
        });

        this.dryRunPreview.showValidationResult();
        return;
      }

      console.log(chalk.bold.cyan('\n📋 Workflow Details'));
      console.log(chalk.gray('━'.repeat(60)));
      console.log(chalk.bold('Name:'), chalk.white(workflow.metadata.name));
      console.log(
        chalk.bold('Description:'),
        chalk.white(workflow.metadata.description),
      );
      console.log(chalk.bold('Steps:'), chalk.white(workflow.steps.length));
      console.log(
        chalk.bold('Auto Execution:'),
        workflow.metadata.autoExecutionMode
          ? chalk.green('Yes')
          : chalk.yellow('No'),
      );
      console.log(chalk.gray('━'.repeat(60)) + '\n');

      // Show parameters
      if (Object.keys(parameters).length > 0) {
        console.log(chalk.bold('Parameters:'));
        for (const [key, value] of Object.entries(parameters)) {
          console.log(chalk.gray(`  ${key}:`), chalk.white(value));
        }
        console.log();
      }

      // Execute workflow
      console.log(chalk.bold.green('🚀 Starting workflow execution...\n'));

      const state = await this.stageEngine.executeWorkflow(
        workflow,
        parameters,
      );

      // Display results
      console.log(chalk.bold.green('\n✅ Workflow completed successfully!'));
      console.log(chalk.gray('━'.repeat(60)));
      console.log(chalk.bold('Execution ID:'), chalk.white(state.executionId));
      console.log(chalk.bold('Status:'), this.formatStatus(state.status));
      console.log(
        chalk.bold('Steps Completed:'),
        chalk.white(`${state.results.length}/${workflow.steps.length}`),
      );
      console.log(
        chalk.bold('Duration:'),
        chalk.white(this.formatDuration(state.createdAt, state.updatedAt)),
      );
      console.log(chalk.gray('━'.repeat(60)) + '\n');
    } catch (error) {
      ErrorHandler.handle(error as Error);
    }
  }

  private parseParameters(
    args: string[],
    paramsString?: string,
  ): Record<string, any> {
    const parameters: Record<string, any> = {};

    // Parse positional arguments
    args.forEach((arg, index) => {
      parameters[`arg${index}`] = arg;
    });

    // Parse --params JSON string
    if (paramsString) {
      try {
        const parsed = JSON.parse(paramsString);
        Object.assign(parameters, parsed);
      } catch (error) {
        this.logger.warn('Failed to parse --params JSON, ignoring');
      }
    }

    return parameters;
  }

  private formatStatus(status: string): string {
    const statusColors: Record<string, any> = {
      completed: chalk.green,
      running: chalk.blue,
      failed: chalk.red,
      cancelled: chalk.yellow,
      'pending-approval': chalk.yellow,
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

  @Option({
    flags: '-p, --params <json>',
    description: 'Parameters as JSON string',
  })
  parseParams(val: string): string {
    return val;
  }

  @Option({
    flags: '-a, --auto-execute',
    description: 'Skip approval gates (auto-execution mode)',
  })
  parseAutoExecute(): boolean {
    return true;
  }

  @Option({
    flags: '-d, --dry-run',
    description: 'Show workflow steps without executing',
  })
  parseDryRun(): boolean {
    return true;
  }
}
