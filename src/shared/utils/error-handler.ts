import { AppError, ERROR_CODE } from '../errors/app.error';
import { isZodErrorLike, formatZodError } from './zod-error.util';
import chalk from 'chalk';

export class ErrorHandler {
  static handle(error: Error | AppError): never {
    if (error instanceof AppError) {
      this.handleAppError(error);
    } else {
      this.handleUnknownError(error);
    }
    process.exit(1);
  }

  private static handleAppError(error: AppError): void {
    console.error(chalk.red.bold(`\n❌ ${error.name}`));
    console.error(chalk.red(error.message));

    if (error.details) {
      const detailsOutput = isZodErrorLike(error.details)
        ? `\n${formatZodError(error.details)}`
        : `\nDetails:\n${JSON.stringify(error.details, null, 2)}`;

      console.error(chalk.gray(detailsOutput));
    }

    const suggestion = this.getSuggestion(error.code);
    if (suggestion) {
      console.error(chalk.yellow(`\n💡 Suggestion: ${suggestion}`));
    }

    if (error.recoverable) {
      console.error(chalk.blue('\nℹ️  This error is recoverable. You can retry the operation.'));
    }
  }

  private static handleUnknownError(error: Error): void {
    console.error(chalk.red.bold('\n❌ Unexpected Error'));
    console.error(chalk.red(error.message));
    if (error.stack) {
      console.error(chalk.gray('\nStack trace:'));
      console.error(chalk.gray(error.stack));
    }
  }

  private static getSuggestion(code: string): string | null {
    const suggestions: Record<string, string | null> = {
      [ERROR_CODE.WORKFLOW_PARSE_ERROR]:
        'Check your workflow file syntax. Ensure YAML frontmatter is valid and markdown is properly formatted.',
      [ERROR_CODE.VALIDATION_ERROR]: 'Review the validation errors above and correct the invalid values.',
      [ERROR_CODE.EXECUTION_ERROR]: 'Check the execution logs for more details. Ensure all prerequisites are met.',
      [ERROR_CODE.JIRA_API_ERROR]:
        'Verify your Jira credentials in wf.config.* under atlassian.baseUrl, atlassian.email, and atlassian.jira.apiToken.',
      [ERROR_CODE.GIT_ERROR]: 'Ensure you are in a git repository and have necessary permissions. Check git status.',
      [ERROR_CODE.AI_ERROR]:
        'Check your wf.config.* AI provider entries and API keys. Verify the selected provider has a valid apiKey, model, quota, and network access.',
      [ERROR_CODE.STATE_ERROR]: 'State file may be corrupted. Check .wf/state/ directory permissions.',
      [ERROR_CODE.USER_CANCELLED]: null,
      [ERROR_CODE.APPROVAL_ERROR]: 'There was an issue with the approval process. Try again.',
      [ERROR_CODE.CONFIGURATION_ERROR]:
        'Check your wf.config.* file and ensure the required configuration values are present and valid.',
      [ERROR_CODE.FILE_SYSTEM_ERROR]: 'Check file permissions and ensure the path exists.',
    };

    return suggestions[code] || null;
  }

  static async executeWithRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    delay: number = 1000
  ): Promise<T> {
    let lastError: Error;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        if (error instanceof AppError && !error.recoverable) {
          throw error;
        }

        if (attempt < maxRetries) {
          console.log(chalk.yellow(`\n⚠️  Attempt ${attempt} failed. Retrying in ${delay}ms...`));
          await this.sleep(delay);
          delay *= 2; // Exponential backoff
        }
      }
    }

    throw lastError!;
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
