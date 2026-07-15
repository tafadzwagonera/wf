import { Injectable } from '@nestjs/common';
import chalk from 'chalk';
import { TicketArtifact, FetcherOptions } from './interfaces';
import { FetchStageService } from '../workflows/stages/fetch-stage.service';

@Injectable()
export class FetcherAgent {
  constructor(private readonly fetchStageService: FetchStageService) {}

  /**
   * Fetch a ticket from the platform and save it as a markdown artifact.
   *
   * @param ticketKey - The ticket identifier (e.g. WBP-1234)
   * @param options - Fetch options including trackerName, optional repo override, and skipExisting flag
   * @returns The TicketArtifact with key, markdown content, and file path
   */
  async execute(ticketKey: string, options: FetcherOptions): Promise<TicketArtifact> {
    if (!options.silent) {
      console.log(chalk.bold.yellow('📋 STAGE 1: Fetch Ticket'));
      console.log(chalk.gray('─'.repeat(70)));
    }

    const artifact = await this.fetchStageService.fetchArtifact(ticketKey, options);

    if (!options.silent) {
      this.logFetchOutcome(artifact, options);
      const titleMatch = /^#\s+[^:]+:\s+(.+)$/m.exec(artifact.content);
      console.log(chalk.bold('  Title:'), chalk.bold.cyan(titleMatch?.[1] ?? ticketKey));
      console.log(chalk.gray(`  Saved to: ${artifact.path}`));
    }

    return artifact;
  }

  private logFetchOutcome(artifact: TicketArtifact & { fromCache?: boolean }, options: FetcherOptions): void {
    if (artifact.fromCache) {
      console.log(chalk.yellow(`⚠️  Using existing FETCH artifact: ${artifact.path}`));
      return;
    }
    if (options.skipExisting === false) {
      console.log(chalk.yellow(`⚠️  --force enabled; overwrote ticket artifact`));
      console.log(chalk.green('✓ Ticket refetched'));
      return;
    }
    console.log(chalk.green('✓ Ticket fetched'));
  }

  /**
   * Load an existing ticket artifact from disk.
   *
   * @param ticketKey - The ticket identifier (e.g. WBP-1234)
   * @param trackerName - The platform directory name (e.g. 'jira', 'bitbucket')
   * @param baseDir - Base directory for artifact storage (defaults to process.cwd())
   * @param silent
   * @returns The TicketArtifact with key, markdown content, and file path
   * @throws Error if the ticket file does not exist on disk
   */
  loadFromDisk(
    ticketKey: string,
    trackerName: string,
    baseDir: string = process.cwd(),
    silent?: boolean
  ): TicketArtifact {
    const artifact = this.fetchStageService.loadArtifact(ticketKey, trackerName, baseDir);
    if (!silent) {
      console.log(chalk.gray(`📋 Using existing ticket: ${artifact.path}`));
    }
    return artifact;
  }
}
