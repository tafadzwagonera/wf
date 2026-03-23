import { Command, CommandRunner } from 'nest-commander';
import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

@Injectable()
@Command({
  name: 'issue:cowsay',
  description: 'Smoke-test command — verifies wf is installed and invocable',
})
export class IssueCowsayCommand extends CommandRunner {
  run(): Promise<void> {
    const pkgPath = path.resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      version: string;
    };
    const message = `wf v${pkg.version} is installed and working!`;
    const line = '-'.repeat(message.length + 4);

    console.log(chalk.green(line));
    console.log(chalk.green(`| ${chalk.bold.white(message)} |`));
    console.log(chalk.green(line));
    console.log('        \\   ^__^');
    console.log('         \\  (oo)\\_______');
    console.log('            (__)\\       )\\/\\');
    console.log('                ||----w |');
    console.log('                ||     ||');
    return Promise.resolve();
  }
}
