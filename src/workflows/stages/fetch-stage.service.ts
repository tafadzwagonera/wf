import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { UniversalTicket } from '../../common/dto/universal-ticket.dto';
import { IssueTrackerService } from '../../integrations/issue-trackers/issue-tracker.service';
import { FetcherOptions, TicketArtifact } from '../../agents/interfaces';
import { resolveArtifactDir } from '../../agents/utils';

interface FetchTicketOptions {
  trackerName: string;
  repo?: string;
}

@Injectable()
export class FetchStageService {
  constructor(
    private readonly issueTrackerService: IssueTrackerService,
    private readonly configService: ConfigService,
  ) {}

  async fetchTicket(
    ticketKey: string,
    options: FetchTicketOptions,
  ): Promise<UniversalTicket> {
    const ticketReference = this.resolveTicketReference(ticketKey, options);
    const adapter = this.issueTrackerService.getAdapter(options.trackerName);
    return adapter.getTicket(ticketReference);
  }

  async fetchArtifact(
    ticketKey: string,
    options: FetcherOptions,
  ): Promise<TicketArtifact> {
    const trackerDir = resolveArtifactDir(
      options.baseDir ?? process.cwd(),
      options.trackerName,
    );
    const ticketPath = path.join(trackerDir, `${ticketKey}.md`);

    if (options.skipExisting && fs.existsSync(ticketPath)) {
      return {
        ticketKey,
        content: fs.readFileSync(ticketPath, 'utf-8'),
        path: ticketPath,
        fromCache: true,
      };
    }

    const ticket = await this.fetchTicket(ticketKey, {
      trackerName: options.trackerName,
      repo: options.repo,
    });

    fs.mkdirSync(trackerDir, { recursive: true });
    const content = this.formatTicketMarkdown(ticket, ticketKey);
    fs.writeFileSync(ticketPath, content);

    return {
      ticketKey,
      content,
      path: ticketPath,
      fromCache: false,
    };
  }

  loadArtifact(
    ticketKey: string,
    trackerName: string,
    baseDir: string = process.cwd(),
  ): TicketArtifact {
    const ticketPath = path.join(
      resolveArtifactDir(baseDir, trackerName),
      `${ticketKey}.md`,
    );
    if (!fs.existsSync(ticketPath)) {
      throw new Error(
        `Ticket file not found: ${ticketPath}. Run with --from fetch first.`,
      );
    }

    return {
      ticketKey,
      content: fs.readFileSync(ticketPath, 'utf-8'),
      path: ticketPath,
      fromCache: true,
    };
  }

  formatTicketMarkdown(ticket: UniversalTicket, ticketKey: string): string {
    return `# ${ticket.key || ticketKey}: ${ticket.title}

**Type:** ${ticket.type || 'N/A'}
**Status:** ${ticket.status || 'N/A'}
**Priority:** ${ticket.priority || 'N/A'}
**Assignee:** ${ticket.assignee || 'Unassigned'}
**Reporter:** ${ticket.reporter || 'Unknown'}
**Created:** ${ticket.created ? ticket.created.toLocaleDateString() : 'N/A'}
**Updated:** ${ticket.updated ? ticket.updated.toLocaleDateString() : 'N/A'}

**Labels:** ${ticket.labels?.join(', ') || 'None'}

## Description

${ticket.description ?? ''}
`;
  }

  private resolveTicketReference(
    ticketKey: string,
    options: FetchTicketOptions,
  ): string {
    if (options.trackerName !== 'bitbucket' || !options.repo) {
      return ticketKey;
    }

    if (options.repo.includes('/')) {
      return `${options.repo}#${ticketKey}`;
    }

    const workspace = this.configService.get<string>(
      'atlassian.bitbucket.workspace',
    );
    if (!workspace) {
      throw new Error(
        'Workspace required. Provide as workspace/repo or set atlassian.bitbucket.workspace in wf.config.*',
      );
    }

    return `${workspace}/${options.repo}#${ticketKey}`;
  }
}
