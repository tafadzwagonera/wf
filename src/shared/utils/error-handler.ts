import { AgentError, ErrorCode } from './errors';
import chalk from 'chalk';

export class ErrorHandler {
  static handle(error: Error | AgentError): never {
    if (error instanceof AgentError) {
      this.handleAgentError(error);
    } else {
      this.handleUnknownError(error);
    }
    process.exit(1);
  }

  private static handleAgentError(error: AgentError): void {
    console.error(chalk.red.bold(`\n❌ ${error.name}`));
    console.error(chalk.red(error.message));

    if (error.details) {
      console.error(chalk.gray('\nDetails:'));
      console.error(chalk.gray(JSON.stringify(error.details, null, 2)));
    }

    const suggestion = this.getSuggestion(error.code);
    if (suggestion) {
      console.error(chalk.yellow(`\n💡 Suggestion: ${suggestion}`));
    }

    if (error.recoverable) {
      console.error(
        chalk.blue(
          '\nℹ️  This error is recoverable. You can retry the operation.',
        ),
      );
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

  private static getSuggestion(code: ErrorCode): string | null {
    const suggestions: Record<ErrorCode, string | null> = {
      [ErrorCode.WORKFLOW_PARSE_ERROR]:
        'Check your workflow file syntax. Ensure YAML frontmatter is valid and markdown is properly formatted.',
      [ErrorCode.VALIDATION_ERROR]:
        'Review the validation errors above and correct the invalid values.',
      [ErrorCode.EXECUTION_ERROR]:
        'Check the execution logs for more details. Ensure all prerequisites are met.',
      [ErrorCode.JIRA_API_ERROR]:
        'Verify your Jira credentials (ATLASSIAN_BASE_URL, ATLASSIAN_EMAIL, ATLASSIAN_JIRA_API_TOKEN) in .env file.',
      [ErrorCode.GIT_ERROR]:
        'Ensure you are in a git repository and have necessary permissions. Check git status.',
      [ErrorCode.AI_ERROR]:
        'Check your ANTHROPIC_API_KEY is valid. Verify your API quota and network connection.',
      [ErrorCode.STATE_ERROR]:
        'State file may be corrupted. Check .wf/state/ directory permissions.',
      [ErrorCode.USER_CANCELLED]: null,
      [ErrorCode.APPROVAL_ERROR]:
        'There was an issue with the approval process. Try again.',
      [ErrorCode.CONFIGURATION_ERROR]:
        'Check your .env file and ensure all required configuration values are set.',
      [ErrorCode.FILE_SYSTEM_ERROR]:
        'Check file permissions and ensure the path exists.',
    };

    return suggestions[code] || null;
  }

  static async executeWithRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    delay: number = 1000,
  ): Promise<T> {
    let lastError: Error;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        if (error instanceof AgentError && !error.recoverable) {
          throw error;
        }

        if (attempt < maxRetries) {
          console.log(
            chalk.yellow(
              `\n⚠️  Attempt ${attempt} failed. Retrying in ${delay}ms...`,
            ),
          );
          await this.sleep(delay);
          delay *= 2; // Exponential backoff
        }
      }
    }

    throw lastError!;
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
