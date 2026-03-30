import * as Joi from '@hapi/joi';
import { getWfLogDir, getWfStateDir } from '../shared/utils/wf-paths';

export const validationSchema = Joi.object({
  // Platform Configuration
  PRIMARY_PLATFORM: Joi.string()
    .valid('jira', 'github', 'bitbucket')
    .default('jira'),
  ENABLED_PLATFORMS: Joi.string()
    .optional()
    .pattern(/^(jira|github|bitbucket)(,(jira|github|bitbucket))*$/),

  // AI Configuration
  AI_PROVIDER: Joi.string()
    .valid('anthropic', 'gemini', 'deepseek', 'openai')
    .default('anthropic'),
  ANTHROPIC_API_KEY: Joi.string().optional(),
  OPENAI_API_KEY: Joi.string().optional(),
  GEMINI_API_KEY: Joi.string().optional(),
  DEEPSEEK_API_KEY: Joi.string().optional(),
  AI_MODEL: Joi.string().optional(),
  AI_MAX_TOKENS: Joi.number().default(4096),

  // Atlassian Configuration (Jira + Bitbucket)
  ATLASSIAN_BASE_URL: Joi.string().uri().allow('').optional(),
  ATLASSIAN_EMAIL: Joi.string().email().allow('').optional(),
  ATLASSIAN_JIRA_API_TOKEN: Joi.string().allow('').optional(),
  ATLASSIAN_BITBUCKET_API_TOKEN: Joi.string().allow('').optional(),
  ATLASSIAN_JIRA_DEFAULT_PROJECT: Joi.string().allow('').optional(),
  ATLASSIAN_BITBUCKET_WORKSPACE: Joi.string().allow('').optional(),

  // Git Configuration
  GIT_DEFAULT_BRANCH: Joi.string().default('develop'),
  GIT_COMMIT_FORMAT: Joi.string()
    .valid('conventional', 'freeform', 'auto')
    .default('auto'),

  // Branch Naming Configuration
  ATLASSIAN_BRANCH_PATTERN: Joi.string().optional(),
  GITHUB_BRANCH_PATTERN: Joi.string().optional(),
  BRANCH_PREFIX_IMPLEMENT: Joi.string().default('feature'),
  BRANCH_PREFIX_FIX: Joi.string().default('bugfix'),
  BRANCH_PREFIX_INVESTIGATE: Joi.string().default('chore'),

  // Workflow Configuration
  WORKFLOW_DIRECTORY: Joi.string().default('.windsurf/workflows'),
  WORKFLOW_AUTO_DISCOVERY: Joi.boolean().default(false),

  // State Configuration
  STATE_DIRECTORY: Joi.string().default(getWfStateDir()),

  // Logging Configuration
  LOG_DIRECTORY: Joi.string().default(getWfLogDir()),
  LOG_LEVEL: Joi.string()
    .valid('error', 'warn', 'info', 'debug')
    .default('info'),

  // Slack Configuration
  SLACK_BOT_TOKEN: Joi.string().allow('').optional(),

  // Application
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
});
