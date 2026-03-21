// src/agents/fetcher.agent.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { PlatformService } from '../integrations/platforms/platform.service';
import { UniversalTicket } from '../common/dto/universal-ticket.dto';
import { TicketArtifact, FetcherOptions } from './interfaces';

@Injectable()
export class FetcherAgent {
  constructor(
    private platformService: PlatformService,
    private configService: ConfigService,
  ) {}

  /**
   * Fetch a ticket from the platform and save it as a markdown artifact.
   *
   * @param ticketKey - The ticket identifier (e.g. WBP-1234)
   * @param options - Fetch options including platformName, optional repo override, and skipExisting flag
   * @returns The TicketArtifact with key, markdown content, and file path
   */
  async execute(
    ticketKey: string,
    options: FetcherOptions,
  ): Promise<TicketArtifact> {
    const platformDir = path.join(process.cwd(), options.platformName);
    const ticketPath = path.join(platformDir, `${ticketKey}.md`);

    if (options.skipExisting && fs.existsSync(ticketPath)) {
      console.log(
        chalk.gray(`📋 Skipping FETCH - artifact exists: ${ticketPath}`),
      );
      return {
        ticketKey,
        content: fs.readFileSync(ticketPath, 'utf-8'),
        path: ticketPath,
      };
    }

    console.log(chalk.bold.yellow('📋 STAGE 1: Fetch Ticket'));
    console.log(chalk.gray('─'.repeat(70)));

    const ticketReference =
      options.platformName === 'bitbucket' && options.repo
        ? this.formatBitbucketReference(ticketKey, options.repo)
        : ticketKey;

    const adapter = this.platformService.getAdapter(options.platformName);
    const ticket = await adapter.getTicket(ticketReference);

    console.log(chalk.green('✓ Ticket fetched'));
    console.log(chalk.bold('  Title:'), chalk.white(ticket.title));
    console.log(chalk.bold('  Type:'), chalk.white(ticket.type || 'N/A'));
    console.log(chalk.bold('  Status:'), chalk.white(ticket.status || 'N/A'));

    fs.mkdirSync(platformDir, { recursive: true });

    const content = this.formatTicketMarkdown(ticket, ticketKey);
    fs.writeFileSync(ticketPath, content);
    console.log(chalk.gray(`  Saved to: ${ticketPath}`));

    return { ticketKey, content, path: ticketPath };
  }

  /**
   * Load an existing ticket artifact from disk.
   *
   * @param ticketKey - The ticket identifier (e.g. WBP-1234)
   * @param platformName - The platform directory name (e.g. 'jira', 'bitbucket')
   * @returns The TicketArtifact with key, markdown content, and file path
   * @throws Error if the ticket file does not exist on disk
   */
  loadFromDisk(ticketKey: string, platformName: string): TicketArtifact {
    const ticketPath = path.join(
      process.cwd(),
      platformName,
      `${ticketKey}.md`,
    );
    if (!fs.existsSync(ticketPath)) {
      throw new Error(
        `Ticket file not found: ${ticketPath}. Run with --from fetch first.`,
      );
    }
    console.log(chalk.gray(`📋 Using existing ticket: ${ticketPath}`));
    return {
      ticketKey,
      content: fs.readFileSync(ticketPath, 'utf-8'),
      path: ticketPath,
    };
  }

  private formatTicketMarkdown(
    ticket: UniversalTicket,
    ticketKey: string,
  ): string {
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

  private formatBitbucketReference(issueId: string, repo: string): string {
    if (repo.includes('/')) return `${repo}#${issueId}`;
    const workspace = this.configService.get<string>(
      'atlassian.bitbucket.workspace',
    );
    if (!workspace) {
      throw new Error(
        'Workspace required. Provide as workspace/repo or set ATLASSIAN_BITBUCKET_WORKSPACE',
      );
    }
    return `${workspace}/${repo}#${issueId}`;
  }
}
