import { Injectable } from '@nestjs/common';
import chalk from 'chalk';
import {
  ApiCallPreview,
  DryRunSummary,
  FileReadPreview,
  FileWritePreview,
  GitOperationPreview,
} from './preview.interfaces';

/**
 * Service for displaying dry-run previews with consistent formatting across
 * all issue:* commands.
 */
@Injectable()
export class DryRunPreviewService {
  /**
   * Display the dry-run mode header
   * @param commandName Name of the command being previewed
   * @param label Optional description suffix (e.g., the ticket key)
   */
  showHeader(commandName: string, label?: string): void {
    const suffix = label ? ` ${label}` : '';
    console.log(chalk.bold.blue(`\n🔍 Dry Run  ${commandName}${suffix}`));
    console.log(chalk.black('   no changes will be made\n'));
  }

  /**
   * Display a preview of an outbound HTTP / platform API call
   * @param preview API call details
   */
  previewApiCall(preview: ApiCallPreview): void {
    console.log(
      `  📡 ${chalk.black(preview.method)} ${preview.endpoint}` +
        chalk.black(`  [${preview.platform}]`),
    );
    console.log(chalk.black(`     ↳ ${preview.description}`));
    if (preview.estimatedResponse) {
      const lines = preview.estimatedResponse.split('\n');
      lines.forEach((line, i) =>
        console.log(
          chalk.black(`     ${i === 0 ? '↳ Response: ' : ''}${line}`),
        ),
      );
    }
    if (preview.payload && Object.keys(preview.payload).length > 0) {
      const payloadJson = JSON.stringify(preview.payload, null, 0);
      const payloadDisplay =
        payloadJson.length > 120
          ? `${payloadJson.substring(0, 120)}...`
          : payloadJson;
      console.log(chalk.black(`     ↳ Payload: ${payloadDisplay}`));
    }
  }

  /**
   * Display a preview of a file that would be written
   * @param preview File write details
   */
  previewFileWrite(preview: FileWritePreview): void {
    const opLabel =
      preview.operation === 'overwrite'
        ? chalk.magenta('overwrite')
        : chalk.green('create');
    console.log(`  📝 ${opLabel} ${preview.filePath}`);
    if (preview.contentPreview) {
      const allLines = preview.contentPreview.split('\n');
      allLines
        .slice(0, 10)
        .forEach((line) => console.log(chalk.black(`       ${line}`)));
      if (allLines.length > 10) {
        console.log(chalk.black('       ...'));
      }
    }
  }

  /**
   * Display a preview of a file that would be read
   * @param preview File read details
   */
  previewFileRead(preview: FileReadPreview): void {
    const status = preview.exists
      ? chalk.green('exists')
      : chalk.red('not found — will be fetched');
    console.log(`  📖 ${preview.filePath}` + chalk.black(`  [${status}]`));
  }

  /**
   * Display a preview of a git operation
   * @param preview Git operation details
   */
  previewGitOperation(preview: GitOperationPreview): void {
    const icons: Record<GitOperationPreview['operation'], string> = {
      commit: '🔧',
      branch: '🌿',
      checkout: '🔀',
      push: '🚀',
    };
    console.log(
      `  ${icons[preview.operation]} git ${preview.operation}` +
        chalk.black(`  ${preview.description}`),
    );
  }

  /**
   * Display the summary section with statistics
   * @param summary Aggregated counts for the operation
   */
  showSummary(summary: DryRunSummary): void {
    const parts: string[] = [];
    if (summary.apiCallCount > 0) {
      parts.push(
        `${summary.apiCallCount} API call${summary.apiCallCount !== 1 ? 's' : ''}`,
      );
    }
    if (summary.fileCreatedCount > 0) {
      parts.push(
        `${summary.fileCreatedCount} file${summary.fileCreatedCount !== 1 ? 's' : ''} created`,
      );
    }
    if (summary.fileModifiedCount > 0) {
      parts.push(
        `${summary.fileModifiedCount} file${summary.fileModifiedCount !== 1 ? 's' : ''} modified`,
      );
    }
    if (summary.gitOperationCount > 0) {
      parts.push(
        `${summary.gitOperationCount} git op${summary.gitOperationCount !== 1 ? 's' : ''}`,
      );
    }
    if (parts.length > 0) {
      console.log(chalk.black(`\n  ${parts.join(' · ')}`));
    }
    if (summary.terminalOutputLines && summary.terminalOutputLines.length > 0) {
      this.showTerminalOutput(summary.terminalOutputLines);
    }
  }

  /**
   * Display a final validation success message
   * @param hint Optional action hint (e.g., "remove --dry-run to execute")
   */
  showValidationResult(hint = 'Remove --dry-run to execute'): void {
    console.log(chalk.green(`✓ ${hint}\n`));
  }

  /**
   * Display a stage separator for multi-stage previews (issue)
   * @param stageName Display name for the stage
   */
  showStageHeader(stageName: string): void {
    console.log(chalk.bold.blue(`\n  [${stageName.toUpperCase()}]`));
  }

  /**
   * Display a note that a stage is skipped
   * @param reason Why the stage is skipped
   */
  showSkipped(reason: string): void {
    console.log(chalk.black(`     ↷ Skipped — ${reason}`));
  }

  /**
   * Display a note that a stage has no side effects
   */
  showNoSideEffects(): void {
    console.log(chalk.black('     Display-only stage — no side effects'));
  }

  /**
   * Display a dim indented preview of what the live command would print on success
   * @param lines Lines the live command would emit
   */
  showTerminalOutput(lines: string[]): void {
    if (lines.length === 0) return;
    console.log(chalk.black('\n  Terminal output preview:'));
    lines.forEach((line) => console.log(chalk.black(`  │ ${line}`)));
  }
}
