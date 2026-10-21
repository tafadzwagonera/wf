import { Command, CommandRunner, SubCommand } from 'nest-commander';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from '../common/logger/logger.service';
import { getWfLogDir, getWfStateDir } from '../common/utils/wf-paths';
import { ConfigCleanCommand } from './config-clean.command';
import { createRequire } from 'node:module';
import { ValidationError } from '../common/utils/errors';
import { executeAsyncWithCatch } from '../common/utils/execute-with-catch';
import chalk from 'chalk';

const moduleRequire = createRequire(__filename);

/**
 * Resolve the user config path on demand so help bootstrap does not load the
 * config loader module.
 *
 * @param cwd - Current working directory to search from
 * @returns The discovered config path, if present
 */
const discoverConfigPath = (cwd: string): string | null => {
  const { discoverWfConfigPath } = moduleRequire('../config/wf-config-loader');
  return discoverWfConfigPath(cwd);
};

@SubCommand({
  name: 'get',
  description: 'Get a configuration value',
  arguments: '<key>',
})
export class ConfigGetCommand extends CommandRunner {
  constructor(private readonly configService: ConfigService) {
    super();
  }

  async run(passedParams: string[]): Promise<void> {
    await executeAsyncWithCatch({
      fn: async () => {
        const key = passedParams[0];

        if (!key) {
          throw new ValidationError('Configuration key is required');
        }

        const value = this.configService.get(key);

        if (value === undefined) {
          console.log(chalk.yellow(`Configuration key "${key}" not found`));
        } else {
          console.log(chalk.bold(key + ':'), chalk.cyan(value));
        }
      },
    });
  }
}

@SubCommand({
  name: 'set',
  description: 'Set a configuration value',
  arguments: '<key> <value>',
})
export class ConfigSetCommand extends CommandRunner {
  async run(passedParams: string[]): Promise<void> {
    await executeAsyncWithCatch({
      fn: async () => {
        const [key, value] = passedParams;

        if (!key || !value) {
          throw new ValidationError('Both key and value are required');
        }

        const configPath = discoverConfigPath(process.cwd());

        console.log(chalk.yellow('\n⚠  wf config set is advisory. Update your wf.config.* file manually.\n'));
        console.log(
          chalk.gray(
            `Resolved config file: ${configPath ?? 'none found. Create wf.config.js, wf.config.mjs, wf.config.ts, wf.config.mts, wf.config.yaml, or wf.config.yml.'}`,
          ),
        );
        console.log(chalk.gray('Suggested update:'));
        console.log(chalk.cyan(`${key}: ${value}\n`));
      },
    });
  }
}

@SubCommand({
  name: 'list',
  description: 'List all configuration values',
})
export class ConfigListCommand extends CommandRunner {
  constructor(private readonly configService: ConfigService) {
    super();
  }

  async run(): Promise<void> {
    console.log(chalk.bold.cyan('\n⚙️  Configuration\n'));
    const config = this.buildConfigSections();
    this.printConfigSections(config);
  }

  private buildConfigSections(): Record<string, Record<string, any>> {
    return {
      'AI Settings': this.buildAiSection(),
      'Atlassian Settings': this.buildAtlassianSection(),
      'Git Settings': this.buildGitSection(),
      'System Settings': this.buildSystemSection(),
    };
  }

  private buildAiSection(): Record<string, any> {
    return {
      'ai.provider': this.configService.get('ai.provider'),
      'ai.model': this.configService.get('ai.model'),
      'ai.apiKey': this.maskSecret(this.configService.get('ai.apiKey')),
    };
  }

  private buildAtlassianSection(): Record<string, any> {
    return {
      'atlassian.baseUrl': this.configService.get('atlassian.baseUrl'),
      'atlassian.email': this.configService.get('atlassian.email'),
      'atlassian.apiToken': this.maskSecret(this.configService.get('atlassian.apiToken')),
      'atlassian.jira.defaultProject': this.configService.get('atlassian.jira.defaultProject'),
      'atlassian.bitbucket.workspace': this.configService.get('atlassian.bitbucket.workspace'),
    };
  }

  private buildGitSection(): Record<string, any> {
    return {
      'git.commitFormat': this.configService.get('git.commitFormat'),
      'git.branchNamePattern': this.configService.get('git.branchNamePattern'),
      'git.branchPrefixMapping': JSON.stringify(this.configService.get('git.branchPrefixMapping')),
    };
  }

  private buildSystemSection(): Record<string, any> {
    return {
      'state.directory': getWfStateDir(),
      'logging.directory': getWfLogDir(),
      'logging.level': this.configService.get('logging.level'),
    };
  }

  private printConfigSections(config: Record<string, Record<string, any>>): void {
    for (const [section, values] of Object.entries(config)) {
      console.log(chalk.bold(section));
      for (const [key, value] of Object.entries(values)) {
        console.log(chalk.gray(`  ${key}:`), chalk.cyan(value || chalk.gray('(not set)')));
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

@Command({
  name: 'config',
  description: 'Configure agent settings',
  options: { isDefault: false },
  subCommands: [ConfigGetCommand, ConfigSetCommand, ConfigListCommand, ConfigCleanCommand],
})
export class ConfigCommand extends CommandRunner {
  constructor(
    private readonly _configService: ConfigService,
    private readonly _logger: LoggerService,
  ) {
    super();
  }

  async run(): Promise<void> {
    console.log(chalk.yellow('\nUsage: wf config <subcommand> [args]'));
    console.log(chalk.gray('\nSubcommands:'));
    console.log(chalk.gray('  get <key>        Get configuration value'));
    console.log(chalk.gray('  set <key> <val>  Set configuration value'));
    console.log(chalk.gray('  list             List all configuration'));
    console.log(chalk.gray('  clean            Delete session state files'));
    console.log(chalk.gray('\nExamples:'));
    console.log(chalk.gray('  wf config get atlassian.baseUrl'));
    console.log(chalk.gray('  wf config set atlassian.email user@example.com'));
    console.log(chalk.gray('  wf config list\n'));
  }
}
