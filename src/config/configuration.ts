import { resolveWfPath } from '../shared/utils/wf-paths';

export default () => ({
  platforms: {
    primary: process.env.PRIMARY_PLATFORM || 'jira',
    enabled: process.env.ENABLED_PLATFORMS
      ? process.env.ENABLED_PLATFORMS.split(',').map((p) =>
          p.trim().toLowerCase(),
        )
      : undefined, // undefined means auto-detect
  },
  output: {
    defaultFormat: process.env.DEFAULT_OUTPUT_FORMAT || 'md',
  },
  ai: {
    provider: process.env.AI_PROVIDER || 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    geminiApiKey: process.env.GEMINI_API_KEY,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY,
    model: process.env.AI_MODEL,
    maxTokens: parseInt(process.env.AI_MAX_TOKENS || '4096', 10),
  },
  // Atlassian Configuration (Jira + Bitbucket)
  atlassian: {
    baseUrl: process.env.ATLASSIAN_BASE_URL,
    email: process.env.ATLASSIAN_EMAIL,
    apiToken: process.env.ATLASSIAN_JIRA_API_TOKEN,
    jira: {
      defaultProject: process.env.ATLASSIAN_JIRA_DEFAULT_PROJECT,
    },
    bitbucket: {
      workspace: process.env.ATLASSIAN_BITBUCKET_WORKSPACE,
      apiToken: process.env.ATLASSIAN_BITBUCKET_API_TOKEN,
    },
  },
  github: {
    token: process.env.GITHUB_TOKEN,
    defaultRepo: process.env.GITHUB_DEFAULT_REPO,
  },
  git: {
    defaultBranch: process.env.GIT_DEFAULT_BRANCH || 'develop',
    commitFormat: process.env.GIT_COMMIT_FORMAT || 'auto',
  },
  branching: {
    // Pattern for branch names (platform-specific)
    atlassianPattern:
      process.env.ATLASSIAN_BRANCH_PATTERN ||
      '^(bugfix|build|chore|ci|docs|feat|feature|fix|perf|performance|refactor|revert|style|test)\\/[A-Z]+-[0-9]+__|__.+$',
    githubPattern:
      process.env.GITHUB_BRANCH_PATTERN ||
      '^(bugfix|build|chore|ci|docs|feat|feature|fix|perf|performance|refactor|revert|style|test)\\/[A-Za-z0-9_-]+$',
    // Action to prefix mapping
    prefixMapping: {
      implement: process.env.BRANCH_PREFIX_IMPLEMENT || 'feature',
      fix: process.env.BRANCH_PREFIX_FIX || 'bugfix',
      investigate: process.env.BRANCH_PREFIX_INVESTIGATE || 'chore',
    },
  },
  workflows: {
    directory: process.env.WORKFLOW_DIRECTORY || '.windsurf/workflows',
    autoDiscovery: process.env.WORKFLOW_AUTO_DISCOVERY === 'true',
  },
  state: {
    directory: resolveWfPath(process.env.STATE_DIRECTORY, 'state'),
  },
  logging: {
    directory: resolveWfPath(process.env.LOG_DIRECTORY, 'logs'),
    level: process.env.LOG_LEVEL || 'info',
  },
  app: {
    nodeEnv: process.env.NODE_ENV || 'development',
  },
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN,
  },
});
