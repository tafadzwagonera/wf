import { AppError, AIError, ERROR_CODE, type AIErrorCategory } from '../errors/app.error';
import { appendToLogFile } from '../logger/log-file-writer';
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

  // eslint-disable-next-line max-lines-per-function -- name, message, details, suggestion, and recoverable-flag display
  private static handleAppError(error: AppError): void {
    const logParts = [`${error.name}: ${error.message}`];
    if (error.details) {
      const detailsOutput = isZodErrorLike(error.details)
        ? formatZodError(error.details)
        : JSON.stringify(this.sanitizeDetailsForDisplay(error.details), null, 2);
      logParts.push(`Details:\n${detailsOutput}`);
    }

    const logSuggestion = this.getSuggestion(error);
    if (logSuggestion) {
      logParts.push(`Suggestion: ${logSuggestion}`);
    }

    if (error.recoverable) {
      logParts.push('Recoverable: true');
    }

    appendToLogFile('ERROR', logParts.join('\n'), 'ErrorHandler');
    console.error(chalk.red.bold(`\n✖ ${error.name}`));
    console.error(chalk.red(error.message));

    if (error.details) {
      const detailsOutput = isZodErrorLike(error.details)
        ? `\n${formatZodError(error.details)}`
        : `\nDetails:\n${JSON.stringify(this.sanitizeDetailsForDisplay(error.details), null, 2)}`;

      console.error(chalk.gray(detailsOutput));
    }

    const suggestion = this.getSuggestion(error);
    if (suggestion) {
      console.error(chalk.yellow(`\n💡 Suggestion: ${suggestion}`));
    }

    if (error.recoverable) {
      console.error(chalk.blue('\nℹ️  This error is recoverable. You can retry the operation.'));
    }
  }

  private static handleUnknownError(error: Error): void {
    appendToLogFile('ERROR', `${error.message}${error.stack ? `\n${error.stack}` : ''}`, 'ErrorHandler');
    console.error(chalk.red.bold('\n✖ Unexpected Error'));
    console.error(chalk.red(error.message));
    if (error.stack) {
      console.error(chalk.gray('\nStack trace:'));
      console.error(chalk.gray(error.stack));
    }
  }

  // eslint-disable-next-line max-lines-per-function -- category check + full suggestions map are both required here
  private static getSuggestion(error: AppError): string | null {
    if (error instanceof AIError && error.category) {
      const categorySuggestions: Partial<Record<AIErrorCategory, string>> = {
        timeout: 'The AI provider request timed out. Check your network connection and retry — the provider may be temporarily overloaded.',
        auth: 'Authentication failed. Verify the API key for the selected provider in your wf.config.* file.',
        api: 'The AI provider returned a service error (e.g. rate limit or overload). Wait briefly and retry.',
        parse: 'The AI response could not be parsed. This is usually transient — retry the command.',
        truncation: 'The AI response was cut short. Reduce prompt/context size or increase the token budget where supported.',
        stall: 'The AI agent stalled without producing output. Retry or check agent configuration.',
      };
      const categorySuggestion = categorySuggestions[error.category];
      if (categorySuggestion) return categorySuggestion;
    }

    const suggestions: Record<string, string | null> = {
      [ERROR_CODE.WORKFLOW_PARSE_ERROR]:
        'Check your workflow file syntax. Ensure YAML frontmatter is valid and markdown is properly formatted.',
      [ERROR_CODE.VALIDATION_ERROR]: 'Review the validation errors above and correct the invalid values.',
      [ERROR_CODE.EXECUTION_ERROR]: 'Check the execution logs for more details. Ensure all prerequisites are met.',
      [ERROR_CODE.JIRA_API_ERROR]:
        'Verify your Jira credentials in wf.config.* under atlassian.baseUrl, atlassian.email, and atlassian.jira.apiToken.',
      [ERROR_CODE.GIT_ERROR]: 'Ensure you are in a git repository and have necessary permissions. Check git status.',
      [ERROR_CODE.AI_PROVIDER_ERROR]:
        'Check your wf.config.* AI provider entries and API keys. Verify the selected provider has a valid apiKey, model, quota, and network access.',
      [ERROR_CODE.STATE_ERROR]: 'State file may be corrupted. Check .wf/state/ directory permissions.',
      [ERROR_CODE.USER_CANCELLED]: null,
      [ERROR_CODE.APPROVAL_ERROR]: 'There was an issue with the approval process. Try again.',
      [ERROR_CODE.CONFIGURATION_ERROR]:
        'Check your wf.config.* file and ensure the required configuration values are present and valid.',
      [ERROR_CODE.FILE_SYSTEM_ERROR]: 'Check file permissions and ensure the path exists.',
    };

    return suggestions[error.code] || null;
  }

  /**
   * Returns a sanitized shallow copy of error details safe for display.
   * Truncates long response strings and flattens nested Error objects.
   * Never mutates the original details object.
   *
   * @param details - Raw error details from an AppError
   * @returns Sanitized copy, undefined for falsy input, primitive unchanged
   */
  private static sanitizeDetailsForDisplay(details: unknown): unknown {
    if (!details) return undefined;
    if (typeof details !== 'object') return details;
    const sanitized = { ...(details as Record<string, unknown>) };
    if (typeof sanitized['response'] === 'string' && sanitized['response'].length > 200) {
      const totalLength = sanitized['response'].length;
      sanitized['response'] = sanitized['response'].slice(0, 200) + `... [truncated, ${totalLength} chars total]`;
    }
    if (sanitized['error'] !== null && typeof sanitized['error'] === 'object' && 'message' in sanitized['error']) {
      sanitized['error'] = (sanitized['error'] as { message: string }).message;
    }
    return sanitized;
  }
}
