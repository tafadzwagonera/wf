import { Injectable } from '@nestjs/common';
import inquirer from 'inquirer';
import chalk from 'chalk';
import boxen from 'boxen';
import {
  ApprovalRequest,
  ApprovalResponse,
  ApprovalDecision,
  ApprovalModifications,
  StageResult,
  Artifact,
} from '../../common/interfaces';
import { UserCancelledError } from '../../shared/utils/errors';
import { LoggerService } from '../../shared/logger/logger.service';

@Injectable()
export class ApprovalSystemService {
  constructor(private logger: LoggerService) {}

  async requestApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
    // Display stage output
    this.displayStageOutput(request);

    // Prompt user for decision
    const decision = await this.promptDecision(request.retryable);

    switch (decision) {
      case ApprovalDecision.PROCEED:
        return { decision };

      case ApprovalDecision.RETRY:
        const modifications = await this.collectModifications();
        return { decision, modifications };

      case ApprovalDecision.CANCEL:
        throw new UserCancelledError('Workflow cancelled by user');

      case ApprovalDecision.SKIP:
        return { decision };

      default:
        return { decision: ApprovalDecision.PROCEED };
    }
  }

  private displayStageOutput(request: ApprovalRequest): void {
    console.log('\n');

    const header = chalk.bold.cyan('APPROVAL REQUIRED: Review Stage Output');
    const border = '━'.repeat(60);

    console.log(chalk.cyan(border));
    console.log(header);
    console.log(chalk.cyan(border));
    console.log();

    // Display step information
    console.log(
      chalk.bold('Step:'),
      chalk.white(`${request.stepTitle} (${request.stepId})`),
    );
    console.log(
      chalk.bold('Progress:'),
      chalk.white(
        `${request.context.currentStep} of ${request.context.totalSteps}`,
      ),
    );
    console.log();

    // Display stage result
    this.displayResult(request.result);

    // Display artifacts
    if (request.result.artifacts && request.result.artifacts.length > 0) {
      console.log();
      console.log(chalk.bold.yellow('Artifacts:'));
      request.result.artifacts.forEach((artifact) =>
        this.displayArtifact(artifact),
      );
    }

    console.log();
    console.log(chalk.cyan(border));
    console.log();
  }

  private displayResult(result: StageResult): void {
    // Display status
    const statusColor =
      result.status === 'success'
        ? chalk.green
        : result.status === 'failure'
          ? chalk.red
          : chalk.yellow;

    console.log(chalk.bold('Status:'), statusColor(result.status));

    if (result.duration) {
      console.log(chalk.bold('Duration:'), chalk.white(`${result.duration}ms`));
    }

    // Display outputs
    if (Object.keys(result.outputs).length > 0) {
      console.log();
      console.log(chalk.bold.cyan('Outputs:'));

      for (const [key, value] of Object.entries(result.outputs)) {
        console.log(chalk.bold(`  ${key}:`));

        if (typeof value === 'string') {
          this.displayFormattedOutput(value);
        } else {
          console.log(chalk.gray(JSON.stringify(value, null, 2)));
        }
      }
    }

    // Display error if present
    if (result.error) {
      console.log();
      console.log(chalk.bold.red('Error:'));
      console.log(chalk.red(`  Code: ${result.error.code}`));
      console.log(chalk.red(`  Message: ${result.error.message}`));

      if (result.error.details) {
        console.log(
          chalk.gray(`  Details: ${JSON.stringify(result.error.details)}`),
        );
      }
    }
  }

  private displayFormattedOutput(output: string): void {
    // If output is short, display inline
    if (output.length < 100) {
      console.log(chalk.white(`  ${output}`));
      return;
    }

    // For longer output, display in a box
    const boxedOutput = boxen(output, {
      padding: 1,
      margin: 1,
      borderStyle: 'round',
      borderColor: 'gray',
    });

    console.log(boxedOutput);
  }

  private displayArtifact(artifact: Artifact): void {
    console.log(
      chalk.bold(`  ${artifact.name}`) + chalk.gray(` (${artifact.type})`),
    );

    if (artifact.path) {
      console.log(chalk.gray(`    Path: ${artifact.path}`));
    }

    if (artifact.content && artifact.content.length < 200) {
      console.log(chalk.white(`    ${artifact.content}`));
    } else if (artifact.content) {
      console.log(
        chalk.gray(`    Content: ${artifact.content.substring(0, 200)}...`),
      );
    }
  }

  private async promptDecision(retryable: boolean): Promise<ApprovalDecision> {
    const choices = [
      { name: 'Proceed to next stage', value: ApprovalDecision.PROCEED },
    ];

    if (retryable) {
      choices.push({ name: 'Retry this stage', value: ApprovalDecision.RETRY });
      choices.push({
        name: 'Skip this stage',
        value: ApprovalDecision.SKIP,
      });
    }

    choices.push({ name: 'Cancel workflow', value: ApprovalDecision.CANCEL });

    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'decision',
        message: 'What would you like to do?',
        choices,
      },
    ]);

    return answers.decision;
  }

  private async collectModifications(): Promise<ApprovalModifications> {
    const modifications: ApprovalModifications = {};

    const modifyAnswers = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'modifyParameters',
        message: 'Do you want to modify parameters?',
        default: false,
      },
      {
        type: 'confirm',
        name: 'addInstructions',
        message: 'Do you want to add additional instructions?',
        default: false,
      },
    ]);

    if (modifyAnswers.modifyParameters) {
      const paramAnswers = await inquirer.prompt([
        {
          type: 'editor',
          name: 'parameters',
          message: 'Enter parameters as JSON:',
          default: '{}',
        },
      ]);

      try {
        modifications.parameters = JSON.parse(paramAnswers.parameters);
      } catch (error) {
        this.logger.warn('Invalid JSON for parameters, ignoring...');
      }
    }

    if (modifyAnswers.addInstructions) {
      const instructionAnswers = await inquirer.prompt([
        {
          type: 'input',
          name: 'instructions',
          message: 'Enter additional instructions:',
        },
      ]);

      modifications.additionalInstructions = instructionAnswers.instructions;
    }

    return modifications;
  }

  displayProgress(
    currentStep: number,
    totalSteps: number,
    stepTitle: string,
  ): void {
    const percentage = Math.round((currentStep / totalSteps) * 100);
    const progressBar = this.createProgressBar(percentage);

    console.log();
    console.log(
      chalk.bold.blue(`Step ${currentStep}/${totalSteps}:`),
      chalk.white(stepTitle),
    );
    console.log(progressBar);
  }

  private createProgressBar(percentage: number): string {
    const width = 40;
    const filled = Math.round((width * percentage) / 100);
    const empty = width - filled;

    const filledBar = chalk.green('█'.repeat(filled));
    const emptyBar = chalk.gray('░'.repeat(empty));

    return `${filledBar}${emptyBar} ${percentage}%`;
  }
}
