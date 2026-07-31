/**
 * Diagnose Jira API token permissions
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { JiraService } from '../../src/integrations/jira/jira.service';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import chalk from 'chalk';

async function diagnose() {
  console.log(chalk.bold.cyan('\n🔍 Diagnosing Jira API Permissions\n'));

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const configService = app.get(ConfigService);
  const baseUrl = configService.get('jira.baseUrl');
  const email = configService.get('jira.email');
  const apiToken = configService.get('jira.apiToken');

  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
  const headers = {
    Authorization: `Basic ${auth}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  console.log(chalk.bold('Configuration:'));
  console.log(chalk.gray('Base URL:'), chalk.white(baseUrl));
  console.log(chalk.gray('Email:'), chalk.white(email));
  console.log(chalk.gray('Token:'), chalk.white(apiToken?.substring(0, 10) + '...'));
  console.log();

  // Test 1: Get current user
  console.log(chalk.bold('Test 1: Get current user info'));
  try {
    const response = await axios.get(`${baseUrl}/rest/api/3/myself`, {
      headers,
    });
    console.log(chalk.green('✓ Success'));
    console.log(chalk.gray('  User:'), chalk.white(response.data.displayName));
    console.log(chalk.gray('  Email:'), chalk.white(response.data.emailAddress));
    console.log(chalk.gray('  Account ID:'), chalk.white(response.data.accountId));
    console.log();
  } catch (error: any) {
    console.log(chalk.red('✗ Failed:'), error.response?.status, error.message);
    console.log();
  }

  // Test 2: Get permissions
  console.log(chalk.bold('Test 2: Get user permissions'));
  try {
    const response = await axios.get(`${baseUrl}/rest/api/3/mypermissions`, {
      headers,
    });
    console.log(chalk.green('✓ Success'));
    console.log(chalk.gray('  Permissions:'), Object.keys(response.data.permissions).length);

    // Check key permissions
    const keyPerms = ['BROWSE_PROJECTS', 'CREATE_ISSUES', 'EDIT_ISSUES'];
    for (const perm of keyPerms) {
      const hasPerm = response.data.permissions[perm]?.havePermission;
      console.log(chalk.gray(`  ${perm}:`), hasPerm ? chalk.green('✓') : chalk.red('✗'));
    }
    console.log();
  } catch (error: any) {
    console.log(chalk.red('✗ Failed:'), error.response?.status, error.message);
    console.log();
  }

  // Test 3: Try to access WBP-2971 directly
  console.log(chalk.bold('Test 3: Access WBP-2971 directly'));
  try {
    const response = await axios.get(`${baseUrl}/rest/api/3/issue/WBP-2971`, {
      headers,
    });
    console.log(chalk.green('✓ Success! Ticket found'));
    console.log(chalk.gray('  Key:'), chalk.white(response.data.key));
    console.log(chalk.gray('  Summary:'), chalk.white(response.data.fields.summary));
    console.log(chalk.gray('  Status:'), chalk.white(response.data.fields.status.name));
    console.log();
  } catch (error: any) {
    console.log(chalk.red('✗ Failed:'), error.response?.status);
    if (error.response?.data) {
      console.log(chalk.red('  Error:'), error.response.data.errorMessages?.join(', '));
    }
    console.log();
  }

  // Test 4: Search with simple JQL
  console.log(chalk.bold('Test 4: Search with simple JQL (key = WBP-2971)'));
  try {
    const response = await axios.post(
      `${baseUrl}/rest/api/3/search/jql`,
      {
        jql: 'key = WBP-2971',
        maxResults: 1,
        fields: ['summary', 'status'],
      },
      { headers }
    );
    console.log(chalk.green('✓ Success'));
    console.log(chalk.gray('  Response:'), JSON.stringify(response.data, null, 2).substring(0, 500));
    console.log(chalk.gray('  Total found:'), chalk.white(response.data.total));
    if (response.data.issues && response.data.issues.length > 0) {
      const issue = response.data.issues[0];
      console.log(chalk.gray('  Key:'), chalk.white(issue.key));
      console.log(chalk.gray('  Summary:'), chalk.white(issue.fields?.summary));
    }
    console.log();
  } catch (error: any) {
    console.log(chalk.red('✗ Failed:'), error.response?.status);
    if (error.response?.data) {
      console.log(chalk.red('  Error:'), error.response.data.errorMessages?.join(', '));
    }
    console.log();
  }

  // Test 5: List accessible projects
  console.log(chalk.bold('Test 5: List accessible projects'));
  try {
    const response = await axios.get(`${baseUrl}/rest/api/3/project`, {
      headers,
    });
    console.log(chalk.green('✓ Success'));
    console.log(chalk.gray('  Projects found:'), chalk.white(response.data.length));
    for (const project of response.data.slice(0, 5)) {
      console.log(chalk.gray(`  - ${project.key}:`), chalk.white(project.name));
    }
    console.log();
  } catch (error: any) {
    console.log(chalk.red('✗ Failed:'), error.response?.status, error.message);
    console.log();
  }

  await app.close();
}

diagnose();
