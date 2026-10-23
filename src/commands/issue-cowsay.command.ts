import { Command, CommandRunner } from 'nest-commander';
import { Injectable } from '@nestjs/common';
import * as path from 'path';
import chalk from 'chalk';
import { readRuntimeAsset } from '../common/utils/runtime-assets';

@Injectable()
@Command({
  name: 'issue:cowsay',
  description: 'Smoke-test command — verifies wf is installed and invocable',
})
export class IssueCowsayCommand extends CommandRunner {
  run(): Promise<void> {
    const message = this.buildMessage();
    this.printBanner(message);
    this.printCow();
    return Promise.resolve();
  }

  private buildMessage(): string {
    const pkgPath = path.resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(readRuntimeAsset('package.json', pkgPath)) as { version: string };
    return `wf v${pkg.version} is installed and working!`;
  }

  private printBanner(message: string): void {
    const line = '-'.repeat(message.length + 4);
    console.log(chalk.green(line));
    console.log(chalk.green(`| ${chalk.bold.white(message)} |`));
    console.log(chalk.green(line));
  }

  private printCow(): void {
    console.log(String.raw`        \   ^__^`);
    console.log(String.raw`         \  (oo)\_______`);
    console.log('            (__)\\       )\\/\\');
    console.log('                ||----w |');
    console.log('                ||     ||');
  }
}
