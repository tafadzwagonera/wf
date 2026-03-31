import { Command, CommandRunner } from 'nest-commander';
import { WorkflowParserService } from '../core/workflow-parser/workflow-parser.service';
import { LoggerService } from '../shared/logger/logger.service';
import { ErrorHandler } from '../shared/utils/error-handler';
import chalk from 'chalk';

@Command({
  name: 'list',
  description: 'List available workflows',
  options: { isDefault: false },
})
export class ListCommand extends CommandRunner {
  constructor(
    private workflowParser: WorkflowParserService,
    private logger: LoggerService,
  ) {
    super();
  }

  async run(): Promise<void> {
    try {
      const workflows = await this.workflowParser.listWorkflows();

      if (workflows.length === 0) {
        console.log(chalk.yellow('\n⚠️  No workflows found'));
        console.log(
          chalk.gray('Create workflow files in .windsurf/workflows/\n'),
        );
        return;
      }

      console.log(chalk.bold.cyan('\n📚 Available Workflows'));
      console.log(chalk.gray('━'.repeat(60)) + '\n');

      for (const workflowName of workflows) {
        try {
          const workflow = await this.workflowParser.findWorkflow(workflowName);

          console.log(chalk.bold.white(`• ${workflow.metadata.name}`));
          if (workflow.metadata.description) {
            console.log(chalk.gray(`  ${workflow.metadata.description}`));
          }
          console.log(chalk.gray(`  Steps: ${workflow.steps.length}`));
          console.log(chalk.gray(`  Command: wf run ${workflowName}`));

          if (workflow.metadata.tags && workflow.metadata.tags.length > 0) {
            const tags = workflow.metadata.tags
              .map((tag: string) => chalk.blue(`#${tag}`))
              .join(' ');
            console.log(chalk.gray(`  Tags: ${tags}`));
          }

          console.log();
        } catch {
          console.log(chalk.bold.red(`• ${workflowName}`));
          console.log(chalk.red(`  Error: Failed to parse workflow`));
          console.log();
        }
      }

      console.log(chalk.gray('━'.repeat(60)));
      console.log(chalk.gray(`\nTotal: ${workflows.length} workflow(s)\n`));
    } catch (error) {
      ErrorHandler.handle(error as Error);
    }
  }
}
