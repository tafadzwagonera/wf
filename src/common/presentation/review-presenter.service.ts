import { Injectable } from '@nestjs/common';
import chalk from 'chalk';
import { buildCodeReviewPresentation } from '../../review/code-review-post-processing';
import { deriveRiskAdjustedSeverity, formatIssueSeverityLabel } from '../../review/risk-adjusted-severity';
import { formatIssueFileLocation } from '../schemas/review.schema';
import { formatReviewCallStack, formatReviewStateTransition } from '../../integrations/ai/review-trace';
import {
  REVIEW_VERDICT_APPROVED,
  REVIEW_VERDICT_CHANGES_REQUESTED,
} from '../types/review.types';
import type { CodeReview } from '../types/review.types';
import {
  BEST_EFFORT_TEXT,
  HINDRANCE_TEXT,
  PROVENANCE_COLORS,
  PROVENANCE_LABELS,
  TRACE_DETAIL_LINES,
} from './review-presenter.types';
import type { SectionLabel, TraceProvenance } from './review-presenter.types';

@Injectable()
export class ReviewPresenter {
  /**
   * Render a full review to the terminal.
   * @param review Parsed AI review result
   */
  displayReview(review: CodeReview): void {
    const presentation = buildCodeReviewPresentation(review);

    console.log(chalk.bold('Summary:'));
    console.log(chalk.bold.cyan('  ' + review.summary));
    this.displayIssueRows(presentation.issueRows);

    console.log(chalk.bold('\nCall Stack:'));
    console.log(this.formatCallStackInline(review));
    console.log(chalk.bold('\nState Transition:'));
    console.log(this.formatStateTransitionInline(review));

    this.displaySuggestions(presentation.unmatchedSuggestions);
    this.displayApprovalStatus(review.approved);
    console.log();
  }

  /**
   * Return the supporting note lines for a trace section based on provenance.
   * @param review Parsed AI review result
   * @param colorized Whether terminal colors should be applied
   * @param sectionLabel Human-friendly section label
   * @returns Supporting note lines for the trace section
   */
  formatTraceSectionNotes(review: CodeReview, colorized: boolean, sectionLabel: SectionLabel): readonly string[] {
    return this.buildTraceSectionNotes(review, colorized, sectionLabel);
  }

  private buildTraceSectionNotes(
    review: CodeReview,
    colorized: boolean,
    sectionLabel: SectionLabel
  ): readonly string[] {
    return this.composeTraceSectionNotes(review, colorized, sectionLabel);
  }

  private composeTraceSectionNotes(
    review: CodeReview,
    colorized: boolean,
    sectionLabel: SectionLabel
  ): readonly string[] {
    const provenance = this.resolveTraceProvenance(review);
    const baseNotes = this.buildTraceSectionBaseNotes(review, colorized);
    return provenance === 'best-effort'
      ? this.buildBestEffortTraceSectionNotes(baseNotes, sectionLabel, colorized)
      : this.buildStandardTraceSectionNotes(baseNotes, provenance, sectionLabel, colorized);
  }

  private buildTraceSectionBaseNotes(review: CodeReview, colorized: boolean): string[] {
    const repairNote = this.formatRepairStrategyNote(review, colorized);
    const provenanceNote = this.formatTraceProvenanceNote(review, colorized);
    return repairNote ? [repairNote, provenanceNote] : [provenanceNote];
  }

  private buildBestEffortTraceSectionNotes(
    baseNotes: string[],
    sectionLabel: SectionLabel,
    colorized: boolean
  ): readonly string[] {
    return [...baseNotes, this.formatBestEffortNote(
      BEST_EFFORT_TEXT[sectionLabel], HINDRANCE_TEXT[sectionLabel], colorized,
    )];
  }

  private buildStandardTraceSectionNotes(
    baseNotes: string[],
    provenance: TraceProvenance,
    sectionLabel: SectionLabel,
    colorized: boolean
  ): readonly string[] {
    return [...baseNotes, this.formatTraceDetailNote(provenance, sectionLabel, colorized)];
  }

  private displayIssueRows(rows: ReturnType<typeof buildCodeReviewPresentation>['issueRows']): void {
    if (rows.length === 0) {
      console.log(chalk.green('\n✔ No issues found'));
      return;
    }
    console.log(chalk.bold('\nIssues Found:'));
    for (const { issue, suggestion } of rows) {
      const color = this.resolveSeverityColor(deriveRiskAdjustedSeverity(issue));
      console.log(color('  [' + formatIssueSeverityLabel(issue) + '] ' + issue.message));
      if (issue.file) console.log(chalk.gray('    File: ' + formatIssueFileLocation(issue)));
      if (suggestion) console.log(chalk.cyan('    Suggestion: ' + suggestion));
    }
  }

  private displaySuggestions(suggestions: string[]): void {
    if (suggestions.length === 0) {
      console.log(chalk.green('\n✔ No suggestions'));
      return;
    }
    console.log(chalk.bold('\nSuggestions:'));
    for (const s of suggestions) console.log(chalk.cyan('  💡 ' + s));
  }

  private displayApprovalStatus(approved: boolean): void {
    const verdict = approved
      ? chalk.green('✔ ' + REVIEW_VERDICT_APPROVED)
      : chalk.red('✗ ' + REVIEW_VERDICT_CHANGES_REQUESTED);
    console.log(chalk.bold('\nApproval Status:'), verdict);
    if (!approved) console.log(chalk.yellow('\n⚠ Address the issues above before proceeding'));
  }

  private resolveSeverityColor(severity: string): chalk.Chalk {
    switch (severity) {
      case 'error':
        return chalk.red;
      case 'warning':
        return chalk.yellow;
      default:
        return chalk.blue;
    }
  }

  private colorizeBranch(branch: string): string {
    return chalk.blueBright(branch);
  }

  private colorizeMutedLine(line: string): string {
    return chalk.gray(line);
  }

  private colorizeTraceLine(line: string): string {
    if (!line.trim()) return line;
    if (this.isBranchLine(line)) return this.colorizeBranchLine(line);
    if (this.isLabelLine(line)) return this.colorizeLabelLine(line);
    if (this.isKeyValueLine(line)) return this.colorizeKeyValueLine(line);
    return chalk.gray(line);
  }

  private isBranchLine(line: string): boolean {
    return /^(\s*)(├─|└─)\s*(.*)$/.test(line);
  }

  private isLabelLine(line: string): boolean {
    return /^(\s*)(from|to|captured|changes):\s*(.*)$/.test(line);
  }

  private isKeyValueLine(line: string): boolean {
    return /^(\s*)(.+?)\s*=\s*(.*)$/.test(line);
  }

  private colorizeBranchLine(line: string): string {
    const match = /^(\s*)(├─|└─)\s*(.*)$/.exec(line);
    if (!match) return chalk.gray(line);
    const [, indent, branch, rest] = match;
    return indent + this.colorizeBranch(branch) + ' ' + chalk.gray(rest);
  }

  private colorizeLabelLine(line: string): string {
    const match = /^(\s*)(from|to|captured|changes):\s*(.*)$/.exec(line);
    if (!match) return chalk.gray(line);
    const [, indent, label, rest] = match;
    return (indent + chalk.cyan(label + ':') + ' ' + (rest ? chalk.gray(rest) : '')).trimEnd();
  }

  private colorizeKeyValueLine(line: string): string {
    const match = /^(\s*)(.+?)\s*=\s*(.*)$/.exec(line);
    if (!match) return chalk.gray(line);
    const [, indent, key, rest] = match;
    return indent + chalk.cyan(key) + ' = ' + chalk.gray(rest);
  }

  private formatCallStackInline(review: CodeReview): string {
    const lines = [...this.formatTraceSectionNotes(review, true, 'call stack')];
    const callStack = formatReviewCallStack(review.callStack);

    if (!callStack.length) {
      lines.push(this.colorizeMutedLine('  (no structured call stack was returned)'));
      return lines.join('\n');
    }

    lines.push(...callStack.map(line => `  ${this.colorizeTraceLine(line)}`));

    return lines.join('\n');
  }

  private formatStateTransitionInline(review: CodeReview): string {
    const lines = [...this.formatTraceSectionNotes(review, true, 'state transition')];
    const stateTransition = formatReviewStateTransition(review.stateTransition);

    if (!stateTransition.length) {
      lines.push(this.colorizeMutedLine('  (no structured state transition was returned)'));
      return lines.join('\n');
    }

    lines.push(...stateTransition.map(line => `  ${this.colorizeTraceLine(line)}`));
    return lines.join('\n');
  }

  private resolveTraceProvenance(review: CodeReview): TraceProvenance {
    const hasStructuredTrace
      = Boolean(review.callStack?.length) || Object.keys(review.stateTransition ?? {}).length > 0;
    if (!hasStructuredTrace || review.traceProvenance === 'unavailable') {
      return 'unavailable';
    }

    if (review.executionMode === 'agent') {
      return 'evidence-based';
    }
    if (review.traceProvenance) {
      return review.traceProvenance;
    }
    return 'best-effort';
  }

  private formatTraceProvenanceNote(review: CodeReview, colorized: boolean): string {
    const provenance = this.resolveTraceProvenance(review);
    const modeLine = '  Execution mode: ' + (review.executionMode ?? 'standard');
    const line = '  ' + PROVENANCE_LABELS[provenance];
    const rendered = [modeLine, line];
    if (!colorized) return rendered.join('\n');

    const colorFn = PROVENANCE_COLORS[provenance] ?? chalk.gray;
    return rendered.map(l => colorFn(l)).join('\n');
  }

  private formatTraceDetailNote(
    provenance: TraceProvenance, sectionLabel: SectionLabel, colorized: boolean
  ): string {
    const detail = TRACE_DETAIL_LINES[provenance](sectionLabel);
    const colorFn = PROVENANCE_COLORS[provenance] ?? chalk.gray;
    return colorized ? colorFn('  ' + detail) : '  ' + detail;
  }

  private formatRepairStrategyNote(review: CodeReview, colorized: boolean): string | undefined {
    if (!review.repairStrategy) return undefined;
    const line = '  Repair strategy: ' + review.repairStrategy;
    return colorized ? chalk.yellow(line) : line;
  }

  private formatBestEffortNote(bestEffortText: string, hindranceText: string, colorized: boolean): string {
    if (!colorized) {
      return `  ${bestEffortText}\n  ${hindranceText}`;
    }

    return [chalk.yellow(`  ${bestEffortText}`), chalk.gray(`  ${hindranceText}`)].join('\n');
  }
}
