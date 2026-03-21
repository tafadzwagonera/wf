import { Command, CommandRunner, SubCommand } from 'nest-commander';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from '../shared/logger/logger.service';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';

@Command({
  name: 'config',
  description: 'Configure agent settings',
  options: { isDefault: false },
})
export class ConfigCommand extends CommandRunner {
  constructor(
    private configService: ConfigService,
    private logger: LoggerService,
  ) {
    super();
  }

  async run(passedParams: string[]): Promise<void> {
    console.log(chalk.yellow('\nUsage: wf config <subcommand> [args]'));
    console.log(chalk.gray('\nSubcommands:'));
    console.log(chalk.gray('  get <key>        Get configuration value'));
    console.log(chalk.gray('  set <key> <val>  Set configuration value'));
    console.log(chalk.gray('  list             List all configuration'));
    console.log(chalk.gray('\nExamples:'));
    console.log(chalk.gray('  wf config get atlassian.baseUrl'));
    console.log(chalk.gray('  wf config set atlassian.email user@example.com'));
    console.log(chalk.gray('  wf config list\n'));
  }
}

@SubCommand({
  name: 'get',
  description: 'Get a configuration value',
  arguments: '<key>',
})
export class ConfigGetCommand extends CommandRunner {
  constructor(private configService: ConfigService) {
    super();
  }

  async run(passedParams: string[]): Promise<void> {
    const key = passedParams[0];

    if (!key) {
      console.error(chalk.red('Error: Configuration key is required'));
      process.exit(1);
    }

    const value = this.configService.get(key);

    if (value === undefined) {
      console.log(chalk.yellow(`Configuration key "${key}" not found`));
    } else {
      console.log(chalk.bold(key + ':'), chalk.white(value));
    }
  }
}

@SubCommand({
  name: 'set',
  description: 'Set a configuration value',
  arguments: '<key> <value>',
})
export class ConfigSetCommand extends CommandRunner {
  async run(passedParams: string[]): Promise<void> {
    const [key, value] = passedParams;

    if (!key || !value) {
      console.error(chalk.red('Error: Both key and value are required'));
      process.exit(1);
    }

    console.log(
      chalk.yellow('\n⚠️  Configuration changes require updating .env file\n'),
    );
    console.log(chalk.gray('Add or update the following in your .env file:'));

    // Convert nested key to env variable name
    const envKey = this.keyToEnvVar(key);
    console.log(chalk.cyan(`${envKey}=${value}`));
    console.log();

    // Optionally write to .env file
    const envPath = path.join(process.cwd(), '.env');

    if (fs.existsSync(envPath)) {
      console.log(chalk.gray(`💡 Tip: File found at ${envPath}`));
      console.log(chalk.gray('You can edit it manually or run:'));
      console.log(chalk.cyan(`echo "${envKey}=${value}" >> .env\n`));
    } else {
      console.log(
        chalk.yellow('No .env file found. Create one from .env.example:'),
      );
      console.log(chalk.cyan('cp .env.example .env\n'));
    }
  }

  private keyToEnvVar(key: string): string {
    // Convert jira.baseUrl -> JIRA_BASE_URL
    return key
      .split('.')
      .map((part) => part.replace(/([A-Z])/g, '_$1').toUpperCase())
      .join('_');
  }
}

@SubCommand({
  name: 'list',
  description: 'List all configuration values',
})
export class ConfigListCommand extends CommandRunner {
  constructor(private configService: ConfigService) {
    super();
  }

  async run(): Promise<void> {
    console.log(chalk.bold.cyan('\n⚙️  Configuration\n'));

    const config = {
      'AI Settings': {
        'ai.provider': this.configService.get('ai.provider'),
        'ai.model': this.configService.get('ai.model'),
        'ai.apiKey': this.maskSecret(this.configService.get('ai.apiKey')),
      },
      'Atlassian Settings': {
        'atlassian.baseUrl': this.configService.get('atlassian.baseUrl'),
        'atlassian.email': this.configService.get('atlassian.email'),
        'atlassian.apiToken': this.maskSecret(
          this.configService.get('atlassian.apiToken'),
        ),
        'atlassian.jira.defaultProject': this.configService.get(
          'atlassian.jira.defaultProject',
        ),
        'atlassian.bitbucket.workspace': this.configService.get(
          'atlassian.bitbucket.workspace',
        ),
      },
      'Git Settings': {
        'git.defaultBranch': this.configService.get('git.defaultBranch'),
        'git.commitFormat': this.configService.get('git.commitFormat'),
      },
      'Workflow Settings': {
        'workflows.directory': this.configService.get('workflows.directory'),
      },
      'System Settings': {
        'state.directory': this.configService.get('state.directory'),
        'logging.directory': this.configService.get('logging.directory'),
        'logging.level': this.configService.get('logging.level'),
      },
    };

    for (const [section, values] of Object.entries(config)) {
      console.log(chalk.bold(section));
      for (const [key, value] of Object.entries(values)) {
        const displayValue = value || chalk.gray('(not set)');
        console.log(chalk.gray(`  ${key}:`), chalk.white(displayValue));
      }
      console.log();
    }
  }

  private maskSecret(value?: string): string {
    if (!value) return '';
    if (value.length <= 8) return '****';
    return value.substring(0, 4) + '****' + value.substring(value.length - 4);
  }
}
