/**
 * Search for available Jira tickets
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { JiraService } from '../../src/integrations/jira/jira.service';
import chalk from 'chalk';

function printTicket(index: number, ticket: any): void {
  console.log(chalk.bold(`${index + 1}. ${ticket.key}:`), chalk.white(ticket.summary));
  console.log(chalk.gray(`   Status: ${ticket.status} | Type: ${ticket.issueType}`));
  console.log(chalk.gray(`   Created: ${ticket.created.toLocaleDateString()}`));
  console.log();
}

async function searchAndPrint(jiraService: JiraService): Promise<void> {
  const tickets = await jiraService.searchTickets({
    jql: 'assignee = currentUser() OR reporter = currentUser() ORDER BY created DESC',
    maxResults: 10,
  });
  console.log(chalk.bold(`Found ${tickets.length} recent tickets:\n`));
  for (const [index, ticket] of tickets.entries()) {
    printTicket(index, ticket);
  }
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n🔍 Searching for available tickets...\n'));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const jiraService = app.get(JiraService);
    await searchAndPrint(jiraService);
  } catch (error: any) {
    console.error(chalk.red('✗ Error:'), error.message);
    if (error.details) {
      console.error(chalk.gray('Details:'), JSON.stringify(error.details, null, 2));
    }
  } finally {
    await app.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
