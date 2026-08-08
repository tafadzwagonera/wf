import { Injectable } from '@nestjs/common';
import chalk from 'chalk';

type OutcomeType = 'success' | 'warning' | 'skip' | 'error';

interface SummaryEntry {
  label: string;
  value: string;
}

const OUTCOME_STYLES: Record<OutcomeType, { icon: string; color: (message: string) => string }> = {
  success: { icon: '✔', color: chalk.green },
  warning: { icon: '⚠', color: chalk.yellow },
  skip: { icon: '↷', color: chalk.yellow },
  error: { icon: '✖', color: chalk.red },
};

const STAGE_ICONS: Record<number, string> = {
  1: '📋',
  2: '🤖',
  3: '🔧',
  4: '🔍',
  5: '💾',
};

@Injectable()
export class CliPresenter {
  stageHeader(stage: number, title: string): void {
    const icon = STAGE_ICONS[stage];
    console.log(chalk.bold.yellow(`\n${icon ? `${icon} ` : ''}STAGE ${stage}: ${title}`));
  }

  separator(): void {
    console.log(chalk.gray('─'.repeat(70)));
  }

  progress(line: string): void {
    console.log(chalk.gray(line));
  }

  outcome(type: OutcomeType, message: string): void {
    const style = OUTCOME_STYLES[type];
    console.log(style.color(`${style.icon} ${message}`));
  }

  detail(label: string, value: string): void {
    console.log(chalk.bold(`  ${label}:`), chalk.cyan(value));
  }

  summaryBlock(entries: SummaryEntry[]): void {
    for (const entry of entries) {
      this.detail(entry.label, entry.value);
    }
  }
}
