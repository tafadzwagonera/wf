/**
 * Manual Test Script for Jira Integration
 *
 * Setup:
 * 1. Copy .env.example to .env
 * 2. Fill in JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN
 * 3. Run: ts-node -r tsconfig-paths/register test/manual/test-jira.ts
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { JiraService } from '../../src/integrations/jira/jira.service';

async function testJiraIntegration() {
  console.log('🧪 Testing Jira Integration\n');

  const app = await NestFactory.createApplicationContext(AppModule);
  const jiraService = app.get(JiraService);

  try {
    // Test 1: Markdown to ADF conversion
    console.log('Test 1: Markdown to ADF Conversion');
    const markdown = `# Test Issue

This is a **bold** statement with *italic* text and \`inline code\`.

## Details

- Item 1
- Item 2
- Item 3

\`\`\`javascript
const x = 1;
console.log(x);
\`\`\`
`;

    const adf = jiraService.markdownToADF(markdown);
    console.log('✓ Converted markdown to ADF');
    console.log(JSON.stringify(adf, null, 2).substring(0, 500) + '...\n');

    // Test 2: ADF to Markdown conversion
    console.log('Test 2: ADF to Markdown Conversion');
    const convertedMarkdown = jiraService.adfToMarkdown(adf);
    console.log('✓ Converted ADF back to markdown');
    console.log(convertedMarkdown.substring(0, 300) + '...\n');

    // Test 3: Create a test ticket (commented out by default)
    // Uncomment and modify to test actual Jira API calls
    /*
    console.log('Test 3: Create Jira Ticket');
    const ticketKey = await jiraService.createTicket({
      project: 'TEST',
      summary: 'Test ticket from windsurf-agent',
      description: markdown,
      issueType: 'Task',
      labels: ['automated-test'],
    });
    console.log(`✓ Created ticket: ${ticketKey}\n`);

    // Test 4: Fetch the ticket
    console.log('Test 4: Fetch Jira Ticket');
    const ticket = await jiraService.getTicket(ticketKey);
    console.log('✓ Fetched ticket:', ticket.key);
    console.log('  Summary:', ticket.summary);
    console.log('  Status:', ticket.status);
    console.log('  Description length:', ticket.description.length, 'chars\n');
    */

    console.log('✅ All manual tests completed successfully!\n');
    console.log('To test actual Jira API calls:');
    console.log('1. Configure .env with your Jira credentials');
    console.log('2. Uncomment the API tests in this file');
    console.log('3. Run again\n');
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.details) {
      console.error('Details:', error.details);
    }
  } finally {
    await app.close();
  }
}

testJiraIntegration();
