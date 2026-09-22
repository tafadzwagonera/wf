/**
 * Fetch Jira ticket details
 * Run: yarn ts-node -r tsconfig-paths/register test/manual/fetch-jira-ticket.ts WBP-2971
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { JiraService } from '../../src/integrations/jira/jira.service';
import { resolveArtifactDir } from '../../src/agents/utils';
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';

type JiraTicket = Awaited<ReturnType<JiraService['getTicket']>>;

async function createApp() {
  return NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
}

function displayTicketMeta(ticket: JiraTicket): void {
  console.log(chalk.bold('Key:'), chalk.white(ticket.key));
  console.log(chalk.bold('Summary:'), chalk.white(ticket.summary));
  console.log(chalk.bold('Type:'), chalk.white(ticket.issueType));
  console.log(chalk.bold('Status:'), chalk.yellow(ticket.status));
  console.log(chalk.bold('Priority:'), chalk.white(ticket.priority));
  console.log(chalk.bold('Assignee:'), chalk.white(ticket.assignee || 'Unassigned'));
  console.log(chalk.bold('Reporter:'), chalk.white(ticket.reporter));
  console.log(chalk.bold('Created:'), chalk.gray(ticket.created.toLocaleString()));
  console.log(chalk.bold('Updated:'), chalk.gray(ticket.updated.toLocaleString()));
}

function displayTicketDescription(ticket: JiraTicket): void {
  if (ticket.labels.length > 0) {
    console.log(chalk.bold('Labels:'), chalk.blue(ticket.labels.join(', ')));
  }
  if (ticket.components.length > 0) {
    console.log(chalk.bold('Components:'), chalk.white(ticket.components.join(', ')));
  }
  console.log(chalk.bold('\nDescription:'));
  console.log(chalk.gray('─'.repeat(60)));
  console.log(chalk.white(ticket.description));
  console.log(chalk.gray('─'.repeat(60)));
}

function buildMarkdown(ticket: JiraTicket): string {
  const labels = ticket.labels.length > 0 ? `**Labels:** ${ticket.labels.join(', ')}\n` : '';
  const components = ticket.components.length > 0 ? `**Components:** ${ticket.components.join(', ')}\n` : '';
  return (
    `# ${ticket.key}: ${ticket.summary}\n\n`
    + `**Type:** ${ticket.issueType}\n`
    + `**Status:** ${ticket.status}\n`
    + `**Priority:** ${ticket.priority}\n`
    + `**Assignee:** ${ticket.assignee || 'Unassigned'}\n`
    + `**Reporter:** ${ticket.reporter}\n`
    + `**Created:** ${ticket.created.toLocaleDateString()}\n`
    + `**Updated:** ${ticket.updated.toLocaleDateString()}\n\n`
    + `${labels}${components}\n## Description\n\n${ticket.description}\n`
  );
}

async function saveTicket(ticket: JiraTicket): Promise<string> {
  const jiraDir = resolveArtifactDir(process.cwd(), 'jira');
  if (!fs.existsSync(jiraDir)) {
    fs.mkdirSync(jiraDir, { recursive: true });
  }
  const markdown = buildMarkdown(ticket);
  const filePath = path.join(jiraDir, `${ticket.key}.md`);
  fs.writeFileSync(filePath, markdown, 'utf-8');
  return filePath;
}

async function fetchAndDisplay(jiraService: JiraService, ticketKey: string): Promise<void> {
  const ticket = await jiraService.getTicket(ticketKey);
  displayTicketMeta(ticket);
  displayTicketDescription(ticket);
  const filePath = await saveTicket(ticket);
  console.log(chalk.green(`\n✓ Ticket saved to: ${filePath}\n`));
}

function handleFetchError(error: any): void {
  console.error(chalk.red('\n✗ Error:'), error.message);
  if (error.details) {
    console.error(chalk.gray('Details:'), error.details);
  }
}

async function main(): Promise<void> {
  const ticketKey = process.argv[2] || 'WBP-2971';
  console.log(chalk.bold.cyan(`\n🎫 Fetching Jira Ticket: ${ticketKey}\n`));
  const app = await createApp();
  try {
    const jiraService = app.get(JiraService);
    await fetchAndDisplay(jiraService, ticketKey);
  } catch (error: any) {
    handleFetchError(error);
  } finally {
    await app.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
