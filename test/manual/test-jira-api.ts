/**
 * Test Jira API directly
 */

import axios from 'axios';

async function testJiraApi() {
  const JIRA_BASE_URL = 'https://touraxis.atlassian.net';
  const JIRA_EMAIL = 'tafadzwa.gonera@touraxis.com';
  const JIRA_API_TOKEN =
    'ATATT3xFfGF0gZVbk6VPcjIrmOYx-KrEO9s5-9E9nMQuNafBRH8mA0n66yjAxLAvRlkXkVyDKnAFCouHjiu5wDut_IaEPa3APWPH5ft5m93_wDzyzCRcAq11ZsBiiiVvSyy6mYBFubuaQMfc-KMDap1y0Xke46sYr7Yr4iIBeXIqO9sddUKJfs4=EC6CC8E3';
  const TICKET_KEY = process.argv[2] || 'WBP-2878';

  const url = `${JIRA_BASE_URL}/rest/api/3/issue/${TICKET_KEY}`;

  console.log('Testing Jira API...');
  console.log('URL:', url);
  console.log('Email:', JIRA_EMAIL);
  console.log();

  try {
    const response = await axios.get(url, {
      auth: {
        username: JIRA_EMAIL,
        password: JIRA_API_TOKEN,
      },
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });

    console.log('✓ Success!');
    console.log('Status:', response.status);
    console.log('Response Data:', JSON.stringify(response.data, null, 2).substring(0, 1000));
    console.log();
  } catch (error: any) {
    console.error('✗ Error:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', JSON.stringify(error.response.data, null, 2).substring(0, 500));
    }
  }
}

testJiraApi();
