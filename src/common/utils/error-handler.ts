import type { AiProviderErrorCategory } from '../errors/app.error';
import { AppError, AiProviderError, ERROR_CODE } from '../errors/app.error';
import { appendToLogFile } from '../logger/log-file-writer';
import { isZodErrorLike, formatZodError } from './zod-error.util';
import chalk from 'chalk';
import { stripVTControlCharacters } from 'node:util';

const terminalDetailsMaxLines = 25;

const aiProviderCategorySuggestions: Partial<Record<AiProviderErrorCategory, string>> = {
  timeout: 'The AI provider request timed out. Check your network connection and retry — the provider may be temporarily overloaded.',
  auth: 'Authentication failed. Verify the API key for the selected provider in your wf.config.* file.',
  api: 'The AI provider returned a service error (e.g. rate limit or overload). Wait briefly and retry.',
  parse: 'The AI response could not be parsed. This is usually transient — retry the command.',
  truncation: 'The AI response was cut short. Reduce prompt/context size or increase the token budget where supported.',
  stall: 'The AI agent stalled without producing output. Retry or check agent configuration.',
  'rate-limit': 'The AI provider hit a rate or usage limit. Wait for the limit to reset (the error message shows the reset time when available) and retry. No API-key fallback was attempted.',
  config: 'The AI provider rejected the request configuration (for example, an invalid response schema). Check the stage model, output schema, and maxTokens in wf.config.*; retrying will not help until the request is corrected.',
};

const errorCodeSuggestions: Record<string, string | null> = {
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
  [ERROR_CODE.REPO_LOCK_ERROR]:
    'Wait for the other wf workflow to finish, or delete the lock file shown above if you are sure no other wf process is running against this repository.',
};

export class ErrorHandler {
  static handle(error: Error | AppError): never {
    if (error instanceof AppError) {
      this.handleAppError(error);
    } else {
      this.handleUnknownError(error);
    }
    process.exit(1);
  }

  private static buildLogParts(error: AppError, suggestion: string | null): string[] {
    const parts = [`${error.name}: ${error.message}`];
    if (error.details) {
      const detailsOutput = isZodErrorLike(error.details)
        ? formatZodError(error.details)
        : JSON.stringify(this.sanitizeDetailsForDisplay(error.details), null, 2);
      parts.push(`Details:\n${detailsOutput}`);
    }
    if (suggestion) parts.push(`Suggestion: ${suggestion}`);
    if (error.recoverable) parts.push('Recoverable: true');
    return parts;
  }

  private static printAppError(error: AppError, suggestion: string | null): void {
    console.error(chalk.red.bold(`\n✖ ${error.name}`));
    console.error(chalk.red(error.message));
    if (error.details) {
      console.error(chalk.gray(this.formatDetailsForTerminal(error.details)));
    }
    if (suggestion) console.error(chalk.yellow(`\n💡 Suggestion: ${suggestion}`));
    if (error.recoverable) console.error(chalk.blue('\nℹ This error is recoverable. You can retry the operation.'));
  }

  private static formatDetailsForTerminal(details: unknown): string {
    if (isZodErrorLike(details)) return `\n${formatZodError(details)}`;
    if (typeof details === 'string') return `\nDetails:\n${this.tailLines(stripVTControlCharacters(details))}`;
    return `\nDetails:\n${JSON.stringify(this.sanitizeDetailsForDisplay(details), null, 2)}`;
  }

  private static tailLines(text: string): string {
    const lines = text.trimEnd().split('\n');
    if (lines.length <= terminalDetailsMaxLines) return lines.join('\n');
    const omitted = lines.length - terminalDetailsMaxLines;
    const notice = `[${omitted} earlier lines omitted; full output is in the agent log]`;
    return [notice, ...lines.slice(-terminalDetailsMaxLines)].join('\n');
  }

  private static handleAppError(error: AppError): void {
    const suggestion = this.getSuggestion(error);
    appendToLogFile('ERROR', this.buildLogParts(error, suggestion).join('\n'), 'ErrorHandler');
    this.printAppError(error, suggestion);
  }

  private static handleUnknownError(error: Error): void {
    const stackSuffix = error.stack ? `\n${error.stack}` : '';
    appendToLogFile('ERROR', `${error.message}${stackSuffix}`, 'ErrorHandler');
    console.error(chalk.red.bold('\n✖ Unexpected Error'));
    console.error(chalk.red(error.message));
    if (error.stack) {
      console.error(chalk.gray('\nStack trace:'));
      console.error(chalk.gray(error.stack));
    }
  }

  private static getSuggestion(error: AppError): string | null {
    if (error instanceof AiProviderError && error.category) {
      const categorySuggestion = aiProviderCategorySuggestions[error.category];
      if (categorySuggestion) return categorySuggestion;
    }
    return errorCodeSuggestions[error.code] ?? null;
  }

  /**
   * Truncates an over-long `response` field in place so a full agent transcript
   * never floods the terminal.
   *
   * @param sanitized - Mutable copy of error details
   */
  private static truncateResponseField(sanitized: Record<string, unknown>): void {
    const response = sanitized['response'];
    if (typeof response !== 'string' || response.length <= 200) return;
    sanitized['response'] = `${response.slice(0, 200)}... [truncated, ${response.length} chars total]`;
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
    // An Error spreads to {} because message/stack are non-enumerable, which silently
    // erased the cause of every non-API SDK failure. Lift the useful fields by name.
    if (details instanceof Error) {
      return { name: details.name, message: details.message, stack: details.stack };
    }
    const sanitized = { ...(details as Record<string, unknown>) };
    ErrorHandler.truncateResponseField(sanitized);
    if (sanitized['error'] !== null && typeof sanitized['error'] === 'object' && 'message' in sanitized['error']) {
      sanitized['error'] = (sanitized['error'] as { message: string }).message;
    }
    return sanitized;
  }
}
