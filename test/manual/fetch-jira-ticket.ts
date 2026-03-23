/**
 * Fetch Jira ticket details
 * Run: yarn ts-node -r tsconfig-paths/register test/manual/fetch-jira-ticket.ts WBP-2971
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { JiraService } from '../../src/integrations/jira/jira.service';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';

async function fetchTicket() {
  const ticketKey = process.argv[2] || 'WBP-2971';

  console.log(chalk.bold.cyan(`\n🎫 Fetching Jira Ticket: ${ticketKey}\n`));

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const jiraService = app.get(JiraService);

    // Fetch ticket
    const ticket = await jiraService.getTicket(ticketKey);

    // Display ticket info
    console.log(chalk.bold('Key:'), chalk.white(ticket.key));
    console.log(chalk.bold('Summary:'), chalk.white(ticket.summary));
    console.log(chalk.bold('Type:'), chalk.white(ticket.issueType));
    console.log(chalk.bold('Status:'), chalk.yellow(ticket.status));
    console.log(chalk.bold('Priority:'), chalk.white(ticket.priority));
    console.log(
      chalk.bold('Assignee:'),
      chalk.white(ticket.assignee || 'Unassigned'),
    );
    console.log(chalk.bold('Reporter:'), chalk.white(ticket.reporter));
    console.log(
      chalk.bold('Created:'),
      chalk.gray(ticket.created.toLocaleString()),
    );
    console.log(
      chalk.bold('Updated:'),
      chalk.gray(ticket.updated.toLocaleString()),
    );

    if (ticket.labels.length > 0) {
      console.log(chalk.bold('Labels:'), chalk.blue(ticket.labels.join(', ')));
    }

    if (ticket.components.length > 0) {
      console.log(
        chalk.bold('Components:'),
        chalk.white(ticket.components.join(', ')),
      );
    }

    console.log(chalk.bold('\nDescription:'));
    console.log(chalk.gray('─'.repeat(60)));
    console.log(chalk.white(ticket.description));
    console.log(chalk.gray('─'.repeat(60)));

    // Save to file
    const jiraDir = path.join(process.cwd(), 'jira');
    if (!fs.existsSync(jiraDir)) {
      fs.mkdirSync(jiraDir, { recursive: true });
    }

    const markdown = `# ${ticket.key}: ${ticket.summary}

**Type:** ${ticket.issueType}
**Status:** ${ticket.status}
**Priority:** ${ticket.priority}
**Assignee:** ${ticket.assignee || 'Unassigned'}
**Reporter:** ${ticket.reporter}
**Created:** ${ticket.created.toLocaleDateString()}
**Updated:** ${ticket.updated.toLocaleDateString()}

${ticket.labels.length > 0 ? `**Labels:** ${ticket.labels.join(', ')}\n` : ''}
${ticket.components.length > 0 ? `**Components:** ${ticket.components.join(', ')}\n` : ''}

## Description

${ticket.description}
`;

    const filePath = path.join(jiraDir, `${ticket.key}.md`);
    fs.writeFileSync(filePath, markdown, 'utf-8');

    console.log(chalk.green(`\n✅ Ticket saved to: ${filePath}\n`));
  } catch (error: any) {
    console.error(chalk.red('\n❌ Error:'), error.message);
    if (error.details) {
      console.error(chalk.gray('Details:'), error.details);
    }
  } finally {
    await app.close();
  }
}

fetchTicket();
