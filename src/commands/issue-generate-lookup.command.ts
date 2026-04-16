import { Command, CommandRunner, Option } from 'nest-commander';
import { ConfigService } from '@nestjs/config';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { parseReposOption } from './utils/repos-option';
import { printExamples, CliExample } from '../shared/utils/cli-examples.helper';
import { resolveArtifactDir, resolveRepoBasePath } from '../agents/utils';
import {
  matchesGeneratedTicketToken,
  type GeneratedTicketSourceManifest,
} from '../shared/utils/generated-ticket-artifact';

interface IssueGenerateLookupOptions {
  platform?: string;
  repos?: string[];
}

const ISSUE_GENERATE_LOOKUP_EXAMPLES: CliExample[] = [
  {
    comment: 'Look up the sources for a generated artifact hash',
    command: 'wf issue:generate:lookup 1a2b3c4d',
  },
];

/**
 * Command to inspect reversible source manifests for generated ticket artifacts.
 */
@Command({
  name: 'issue:generate:lookup',
  description:
    'Lookup the original source list for a generated ticket artifact hash',
  arguments: '<token>',
  options: { isDefault: false },
})
export class IssueGenerateLookupCommand extends CommandRunner {
  constructor(
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
    private readonly dryRunPreview: DryRunPreviewService,
  ) {
    super();
  }

  async run(
    passedParams: string[],
    options?: IssueGenerateLookupOptions,
  ): Promise<void> {
    printExamples(ISSUE_GENERATE_LOOKUP_EXAMPLES);

    const token = passedParams[0]?.trim();
    if (!token) {
      console.error(chalk.red('Error: A token or hash is required'));
      console.log(
        chalk.gray('Usage: wf issue:generate:lookup <token> [--repos <repo>]'),
      );
      process.exit(1);
    }

    const platformName =
      options?.platform ||
      this.configService.get<string>('platforms.primary', 'jira');
    const artifactBaseDir = resolveRepoBasePath(options?.repos?.[0]);
    const artifactDir = resolveArtifactDir(artifactBaseDir, platformName);

    if (!fs.existsSync(artifactDir)) {
      console.error(
        chalk.red(`Error: No generated artifacts found under ${artifactDir}.`),
      );
      process.exit(1);
    }

    const manifests = this.findMatchingManifests(artifactDir, token);

    if (manifests.length === 0) {
      console.error(
        chalk.red(
          `Error: No generated ticket source manifest found for token '${token}' under ${artifactDir}.`,
        ),
      );
      process.exit(1);
    }

    this.renderLookupResults(token, artifactDir, manifests);
  }

  @Option({
    flags: '-p, --platform <platform>',
    description: 'Platform namespace to inspect',
  })
  parsePlatform(val: string): string {
    return val;
  }

  @Option({
    flags: '-r, --repos <repos...>',
    description:
      'Space-separated repositories; only the first repo is used for lookup scope',
  })
  parseRepos(val: string | string[], previous: string[] = []): string[] {
    return parseReposOption(val, previous);
  }

  private findMatchingManifests(
    artifactDir: string,
    token: string,
  ): GeneratedTicketSourceManifest[] {
    return fs
      .readdirSync(artifactDir)
      .filter((name) => name.endsWith('.sources.json'))
      .map((name) => path.join(artifactDir, name))
      .flatMap((manifestPath) => {
        try {
          const manifest = JSON.parse(
            fs.readFileSync(manifestPath, 'utf-8'),
          ) as GeneratedTicketSourceManifest;
          if (matchesGeneratedTicketToken(token, manifest.hash)) {
            return [manifest];
          }

          const artifactStem = path.basename(
            manifest.artifactPath,
            path.extname(manifest.artifactPath),
          );
          if (artifactStem.includes(token.trim().toLowerCase())) {
            return [manifest];
          }

          return [];
        } catch {
          return [];
        }
      });
  }

  private renderLookupResults(
    token: string,
    artifactDir: string,
    manifests: GeneratedTicketSourceManifest[],
  ): void {
    this.dryRunPreview.showHeader('issue:generate:lookup', token);
    console.log(chalk.gray(`  Scope   : ${artifactDir}`));
    console.log(chalk.gray(`  Matches : ${manifests.length}`));

    manifests.forEach((manifest, index) => {
      const artifactName = path.basename(manifest.artifactPath);
      console.log(chalk.blue(`\n  [${index + 1}] ${artifactName}`));
      console.log(chalk.gray(`     Hash    : ${manifest.hash}`));
      console.log(chalk.gray(`     Created : ${manifest.createdAt}`));
      console.log(chalk.gray(`     Format  : ${manifest.format}`));
      console.log(chalk.gray('     Sources :'));

      if (manifest.sources.length === 0) {
        console.log(chalk.cyan('       1. <none recorded>'));
        return;
      }

      manifest.sources.forEach((source, sourceIndex) => {
        console.log(chalk.cyan(`       ${sourceIndex + 1}. ${source}`));
      });
    });

    this.logger.success(`Resolved ${manifests.length} generated artifact(s)`);
  }
}
