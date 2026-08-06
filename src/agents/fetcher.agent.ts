import { Injectable } from '@nestjs/common';
import { TicketArtifact, FetcherOptions } from './interfaces';
import { CliPresenter } from '../shared/presentation/cli-presenter.service';
import { FetchStageService } from '../workflows/stages/fetch-stage.service';

@Injectable()
export class FetcherAgent {
  constructor(
    private readonly fetchStageService: FetchStageService,
    private readonly presenter: CliPresenter
  ) {}

  /**
   * Fetch a ticket from the platform and save it as a markdown artifact.
   *
   * @param ticketKey - The ticket identifier (e.g. WBP-1234)
   * @param options - Fetch options including trackerName, optional repo override, and skipExisting flag
   * @returns The TicketArtifact with key, markdown content, and file path
   */
  async execute(ticketKey: string, options: FetcherOptions): Promise<TicketArtifact> {
    if (!options.silent) {
      this.presenter.stageHeader(1, 'Fetch Ticket');
      this.presenter.separator();
    }

    const artifact = await this.fetchStageService.fetchArtifact(ticketKey, options);

    if (!options.silent) {
      this.logFetchOutcome(artifact, options);
      const titleMatch = /^#\s+[^:]+:\s+(.+)$/m.exec(artifact.content);
      this.presenter.summaryBlock([
        { label: 'Title', value: titleMatch?.[1] ?? ticketKey },
        { label: 'Saved to', value: artifact.path },
      ]);
    }

    return artifact;
  }

  private logFetchOutcome(artifact: TicketArtifact & { fromCache?: boolean }, options: FetcherOptions): void {
    if (artifact.fromCache) {
      this.presenter.outcome('warning', `Using existing FETCH artifact: ${artifact.path}`);
      return;
    }
    if (options.skipExisting === false) {
      this.presenter.outcome('warning', '--force enabled; overwrote ticket artifact');
      this.presenter.outcome('success', 'Ticket refetched');
      return;
    }
    this.presenter.outcome('success', 'Ticket fetched');
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
      this.presenter.progress(`Using existing ticket: ${artifact.path}`);
    }
    return artifact;
  }
}
