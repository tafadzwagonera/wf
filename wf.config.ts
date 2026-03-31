import { defineConfig } from './src/config/public-config';

export default defineConfig({
  platforms: {
    primary: 'jira',
  },
  output: {
    defaultFormat: 'md',
  },
  ai: [
    {
      name: 'openai',
      apiKey:
        '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',
      model: 'gpt-5.4',
      maxTokens: 4096,
      default: true,
    },
  ],
  atlassian: {
    baseUrl: 'https://touraxis.atlassian.net',
    email: 'tafadzwa.gonera@touraxis.com',
    jira: {
      apiToken:
        'ATATT3xFfGF06hgpabFLq27hEfYcEL6UFK6yJX3KCuwnyIqxmu9_3E7jo4A8ArBrQajsUkjnq_Fz8wwYiOLGgsk6VLubQxMk14yBgsWIUaJD37Y6APTYvjoQ_cKAEe8y8UhiBdszmvjW34ULjh_fCLehEYrPc3J95bX5iksfUOeb_r8LrGlzzQM=B61EE227',
    },
    bitbucket: {
      apiToken:
        'ATATT3xFfGF0fXaWI58PPHHB5mog3k6cGc0QXnKG6JdRVGWRHEtaarseHOdyKC9pAPKlG-P-HS8tKcIf7puKB3kGgH_ZtG1rpQ371KdPzhYWwqwynxEOaTFlZP6arVuXhn2hyHHwR8EWbCYZF-XUcCfGj40T2I1bCeHxsN6_yiyUlIPTEFtKVwA=951A71EE',
      workspace: 'touraxis',
    },
  },
  git: {
    commitFormat: 'auto',
    defaultBranch: 'develop',
  },
  branching: {
    atlassianPattern:
      '^(bugfix|build|chore|ci|docs|feat|feature|fix|perf|performance|refactor|revert|style|test)\\/[A-Z]+-[0-9]+__|__.+$',
  },
  workflows: {
    directory: '.windsurf/workflows',
  },
  state: {
    directory: '.wf/state',
  },
  log: {
    directory: '.wf/logs',
    level: 'info',
  },
  app: {
    nodeEnv: 'development',
  },
  slack: {
    botToken: 'xoxb-15574270614-10792681918437-WhcSfJTiwyWvQPbp6TIglvln',
  },
  stages: {
    plan: 'gpt-5.4',
    implement: 'gpt-5.4',
    review: 'gpt-5.4',
    generate: 'gpt-5.4',
  },
});
