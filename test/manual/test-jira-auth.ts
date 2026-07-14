/**
 * Test Jira API authentication
 */

import axios from 'axios';

async function testAuth() {
  const JIRA_BASE_URL = 'https://touraxis.atlassian.net';
  const JIRA_EMAIL = 'tafadzwa.gonera@touraxis.com';
  const JIRA_API_TOKEN
    = 'ATATT3xFfGF0gZVbk6VPcjIrmOYx-KrEO9s5-9E9nMQuNafBRH8mA0n66yjAxLAvRlkXkVyDKnAFCouHjiu5wDut_IaEPa3APWPH5ft5m93_wDzyzCRcAq11ZsBiiiVvSyy6mYBFubuaQMfc-KMDap1y0Xke46sYr7Yr4iIBeXIqO9sddUKJfs4=EC6CC8E3';

  console.log('Testing Jira API Authentication...\n');

  try {
    // Test 1: Get current user
    console.log('Test 1: Get current user');
    const userResponse = await axios.get(`${JIRA_BASE_URL}/rest/api/3/myself`, {
      auth: {
        username: JIRA_EMAIL,
        password: JIRA_API_TOKEN,
      },
      headers: {
        Accept: 'application/json',
      },
    });

    console.log('✓ Authentication successful!');
    console.log('User:', userResponse.data.displayName);
    console.log('Email:', userResponse.data.emailAddress);
    console.log();

    // Test 2: Search for recent issues
    console.log('Test 2: Search for recent WBP issues');
    const searchResponse = await axios.post(
      `${JIRA_BASE_URL}/rest/api/3/search`,
      {
        jql: 'project = WBP ORDER BY created DESC',
        maxResults: 5,
        fields: ['summary', 'status', 'created'],
      },
      {
        auth: {
          username: JIRA_EMAIL,
          password: JIRA_API_TOKEN,
        },
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      }
    );

    console.log(`✓ Found ${searchResponse.data.total} issues`);
    console.log('\nRecent issues:');
    searchResponse.data.issues.forEach((issue: any) => {
      console.log(`  - ${issue.key}: ${issue.fields.summary}`);
    });
    console.log();
  } catch (error: any) {
    console.error('✗ Error:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

testAuth();
