import { Command, CommandRunner, Option } from 'nest-commander';
import { ConfigService } from '@nestjs/config';
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LoggerService } from '../shared/logger/logger.service';
import { DryRunPreviewService } from '../shared/preview/dry-run-preview.service';
import { ValidationError, FileSystemError } from '../shared/utils/errors';
import { executeAsyncWithCatch } from '../shared/utils/execute-with-catch';
import { parseReposOption } from './utils/repos-option';
import { printCommandHeader } from '../shared/utils/command-header.helper';
import { resolveArtifactDir, resolveRepoBasePath } from '../agents/utils';
import { type GeneratedTicketSourceManifest } from '../shared/utils/generated-ticket-artifact';

interface IssueGenerateLookupOptions {
  tracker?: string;
  repos?: string[];
  silent?: boolean;
}
/**
 * Command to inspect reversible source manifests for generated ticket artifacts.
 */
@Command({
  name: 'issue:generate:lookup',
  description: 'Lookup the original source list for a generated ticket artifact hash.',
  arguments: '<token>',
  options: { isDefault: false },
})
export class IssueGenerateLookupCommand extends CommandRunner {
  constructor(
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
    private readonly dryRunPreview: DryRunPreviewService
  ) {
    super();
  }

  async run(passedParams: string[], options?: IssueGenerateLookupOptions): Promise<void> {
    if (!options?.silent) printCommandHeader('issue:generate:lookup');

    await executeAsyncWithCatch({ fn: async () => {
      const { token, artifactDir } = this.resolveInputs(passedParams, options);
      const manifests = this.findMatchingManifests(artifactDir, token);

      if (manifests.length === 0) {
        throw new FileSystemError(
          `No generated ticket source manifest found for token '${token}' under ${artifactDir}.`
        );
      }

      this.renderLookupResults(token, artifactDir, manifests);
    } });
  }

  private resolveInputs(
    passedParams: string[],
    options?: IssueGenerateLookupOptions
  ): { token: string; artifactDir: string } {
    const token = passedParams[0]?.trim();
    if (!token) {
      throw new ValidationError('A token or hash is required');
    }

    const trackerName = options?.tracker || this.configService.get<string>('tracker', 'jira');
    const artifactBaseDir = resolveRepoBasePath(options?.repos?.[0]);
    const artifactDir = resolveArtifactDir(artifactBaseDir, trackerName);

    if (!fs.existsSync(artifactDir)) {
      throw new FileSystemError(`No generated artifacts found under ${artifactDir}.`);
    }

    return { token, artifactDir };
  }

  @Option({
    flags: '-r, --repos <repos...>',
    description: 'Space-separated repositories; only the first repo is used for lookup scope',
  })
  parseRepos(val: string | string[], previous: string[] = []): string[] {
    return parseReposOption(val, previous);
  }

  @Option({
    flags: '-t, --tracker <tracker>',
    description: 'Platform namespace to inspect',
  })
  parseTracker(val: string): string {
    return val;
  }

  @Option({
    flags: '-s, --silent',
    description: 'Suppress decorative output; emits no header',
  })
  parseSilent(): boolean {
    return true;
  }

  private findMatchingManifests(artifactDir: string, token: string): GeneratedTicketSourceManifest[] {
    const manifestPaths = fs
      .readdirSync(artifactDir)
      .filter(name => name.endsWith('.sources.json'))
      .map(name => path.join(artifactDir, name));

    const results: GeneratedTicketSourceManifest[] = [];
    for (const manifestPath of manifestPaths) {
      const manifest = this.safeReadManifest(manifestPath);
      if (!manifest) continue;

      const matchesByHash = typeof manifest.hash === 'string' && manifest.hash.trim().toLowerCase() === token.trim().toLowerCase();

      if (matchesByHash) {
        results.push(manifest);
      }
    }
    return results;
  }

  private safeReadManifest(manifestPath: string): GeneratedTicketSourceManifest | null {
    if (!fs.existsSync(manifestPath)) return null;

    const raw = fs.readFileSync(manifestPath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || !('hash' in parsed)) return null;
    return parsed as GeneratedTicketSourceManifest;
  }

  private renderLookupResults(token: string, artifactDir: string, manifests: GeneratedTicketSourceManifest[]): void {
    this.dryRunPreview.showHeader('issue:generate:lookup', token);
    console.log(chalk.gray(`  Scope   : ${artifactDir}`));
    console.log(chalk.gray(`  Matches : ${manifests.length}`));

    for (const [index, manifest] of manifests.entries()) {
      this.renderManifestEntry(index, manifest);
    }
    this.logger.success(`Resolved ${manifests.length} generated artifact(s)`);
  }

  private renderManifestEntry(index: number, manifest: GeneratedTicketSourceManifest): void {
    console.log(chalk.blue(`\n  [${index + 1}] ${path.basename(manifest.artifactPath)}`));
    console.log(chalk.gray(`     Hash    : ${manifest.hash}`));
    console.log(chalk.gray(`     Created : ${manifest.createdAt}`));
    console.log(chalk.gray(`     Format  : ${manifest.format}`));
    this.renderManifestSources(manifest.sources);
  }

  private renderManifestSources(sources: string[]): void {
    console.log(chalk.gray('     Sources :'));
    if (sources.length === 0) {
      console.log(chalk.cyan('       1. <none recorded>'));
      return;
    }
    for (const [i, source] of sources.entries()) {
      console.log(chalk.cyan(`       ${i + 1}. ${source}`));
    }
  }
}
