import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import Joi from '@hapi/joi';
import YAML from 'yaml';
import { resolveWfPath } from '../shared/utils/wf-paths';
import { ValidationError } from '../shared/utils/errors';
import type {
  WfAiProviderConfig,
  WfAiProviderName,
  WfConfig,
} from './public-config';

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_OPENAI_MODEL = 'gpt-4.1';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-pro';
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-reasoner';

const CONFIG_FILE_NAMES = [
  'wf.config.js',
  'wf.config.mjs',
  'wf.config.ts',
  'wf.config.mts',
  'wf.config.yaml',
  'wf.config.yml',
] as const;

const SUPPORTED_STAGE_NAMES = [
  'plan',
  'implement',
  'review',
  'generate',
] as const;
type SupportedStageName = (typeof SUPPORTED_STAGE_NAMES)[number];

export interface NormalizedWfConfig {
  platforms: {
    primary: 'jira' | 'github' | 'bitbucket';
    enabled?: Array<'jira' | 'github' | 'bitbucket'>;
  };
  output: {
    defaultFormat: string;
  };
  ai: {
    provider: WfAiProviderName;
    providers: Array<
      WfAiProviderConfig & {
        default: boolean;
        model: string;
        maxTokens: number;
      }
    >;
    apiKey?: string;
    anthropicApiKey?: string;
    openaiApiKey?: string;
    geminiApiKey?: string;
    deepseekApiKey?: string;
    model: string;
    maxTokens: number;
    stages: Partial<Record<SupportedStageName, string>>;
  };
  atlassian: {
    baseUrl?: string;
    email?: string;
    apiToken?: string;
    jira: {
      apiToken?: string;
      defaultProject?: string;
    };
    bitbucket: {
      workspace?: string;
      apiToken?: string;
    };
  };
  github: {
    token?: string;
    defaultRepo?: string;
  };
  git: {
    defaultBranch: string;
    commitFormat: 'conventional' | 'freeform' | 'auto';
  };
  branching: {
    atlassianPattern: string;
    githubPattern: string;
    prefixMapping: {
      implement: string;
      fix: string;
      investigate: string;
    };
  };
  workflows: {
    directory: string;
    autoDiscovery: boolean;
  };
  state: {
    directory: string;
  };
  logging: {
    directory: string;
    level: 'error' | 'warn' | 'info' | 'debug';
  };
  log: {
    directory: string;
    level: 'error' | 'warn' | 'info' | 'debug';
  };
  app: {
    nodeEnv: 'development' | 'production' | 'test';
  };
  slack: {
    botToken?: string;
  };
}

interface TypeScriptConfigLoadOptions {
  cwd?: string;
  runtime?: 'node' | 'bun' | 'deno';
  nodeVersion?: string;
  execArgv?: string[];
  loadJiti?: (filePath: string) => unknown;
}

interface WfConfigLoadOptions extends TypeScriptConfigLoadOptions {
  cwd?: string;
}

let loadedConfig: NormalizedWfConfig | null = null;

const providerSchema = Joi.object<WfAiProviderConfig>({
  name: Joi.string()
    .valid('anthropic', 'openai', 'gemini', 'deepseek')
    .required(),
  apiKey: Joi.string().allow('').optional(),
  model: Joi.string().allow('').optional(),
  maxTokens: Joi.number().integer().min(1).optional(),
  default: Joi.boolean().optional(),
});

const configSchema = Joi.object<WfConfig>({
  platforms: Joi.object({
    primary: Joi.string().valid('jira', 'github', 'bitbucket').optional(),
    enabled: Joi.array()
      .items(Joi.string().valid('jira', 'github', 'bitbucket'))
      .optional(),
  }).optional(),
  output: Joi.object({
    defaultFormat: Joi.string().optional(),
  }).optional(),
  ai: Joi.array().items(providerSchema).optional(),
  atlassian: Joi.object({
    baseUrl: Joi.string().uri().optional(),
    email: Joi.string().email().optional(),
    apiToken: Joi.string().allow('').optional(),
    jira: Joi.object({
      apiToken: Joi.string().allow('').optional(),
      defaultProject: Joi.string().allow('').optional(),
    }).optional(),
    bitbucket: Joi.object({
      workspace: Joi.string().allow('').optional(),
      apiToken: Joi.string().allow('').optional(),
    }).optional(),
  }).optional(),
  github: Joi.object({
    token: Joi.string().allow('').optional(),
    defaultRepo: Joi.string().allow('').optional(),
  }).optional(),
  git: Joi.object({
    defaultBranch: Joi.string().optional(),
    commitFormat: Joi.string()
      .valid('conventional', 'freeform', 'auto')
      .optional(),
  }).optional(),
  branching: Joi.object({
    atlassianPattern: Joi.string().optional(),
    githubPattern: Joi.string().optional(),
    prefixMapping: Joi.object({
      implement: Joi.string().optional(),
      fix: Joi.string().optional(),
      investigate: Joi.string().optional(),
    }).optional(),
  }).optional(),
  workflows: Joi.object({
    directory: Joi.string().optional(),
    autoDiscovery: Joi.boolean().optional(),
  }).optional(),
  state: Joi.object({
    directory: Joi.string().optional(),
  }).optional(),
  log: Joi.object({
    directory: Joi.string().optional(),
    level: Joi.string().valid('error', 'warn', 'info', 'debug').optional(),
  }).optional(),
  logging: Joi.object({
    directory: Joi.string().optional(),
    level: Joi.string().valid('error', 'warn', 'info', 'debug').optional(),
  }).optional(),
  app: Joi.object({
    nodeEnv: Joi.string().valid('development', 'production', 'test').optional(),
  }).optional(),
  slack: Joi.object({
    botToken: Joi.string().allow('').optional(),
  }).optional(),
  stages: Joi.object({
    plan: Joi.string().optional(),
    implement: Joi.string().optional(),
    review: Joi.string().optional(),
    generate: Joi.string().optional(),
    fetch: Joi.string().optional(),
    commit: Joi.string().optional(),
  }).optional(),
});

const getDefaultModelForProvider = (provider: WfAiProviderName): string => {
  if (provider === 'openai') return DEFAULT_OPENAI_MODEL;
  if (provider === 'gemini') return DEFAULT_GEMINI_MODEL;
  if (provider === 'deepseek') return DEFAULT_DEEPSEEK_MODEL;
  return DEFAULT_ANTHROPIC_MODEL;
};

const parseNodeVersion = (nodeVersion: string): [number, number, number] =>
  nodeVersion
    .split('.')
    .slice(0, 3)
    .map((segment) => Number.parseInt(segment, 10) || 0) as [
    number,
    number,
    number,
  ];

const isVersionGte = (
  version: string,
  major: number,
  minor: number,
  patch: number,
): boolean => {
  const [versionMajor, versionMinor, versionPatch] = parseNodeVersion(version);
  if (versionMajor !== major) return versionMajor > major;
  if (versionMinor !== minor) return versionMinor > minor;
  return versionPatch >= patch;
};

const hasNativeNodeTypeStripping = (
  nodeVersion: string,
  execArgv: string[],
): boolean =>
  isVersionGte(nodeVersion, 22, 13, 0) &&
  execArgv.some((arg) => arg.includes('--experimental-strip-types'));

const unwrapModuleExport = (loaded: unknown): WfConfig => {
  const candidate =
    loaded && typeof loaded === 'object' && 'default' in loaded
      ? (loaded as { default: unknown }).default
      : loaded;

  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new ValidationError(
      'wf config files must export an object as the default export.',
    );
  }

  return candidate as WfConfig;
};

const readConfigModule = async (filePath: string): Promise<WfConfig> => {
  const loaded = await import(pathToFileURL(filePath).href);
  return unwrapModuleExport(loaded);
};

const readJavaScriptConfigModule = async (
  filePath: string,
): Promise<WfConfig> => {
  try {
    const requireFromConfig = createRequire(filePath);
    const loaded = requireFromConfig(filePath);
    return unwrapModuleExport(loaded);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('import')) {
      throw error;
    }

    return readConfigModule(filePath);
  }
};

const readTypeScriptConfigFromRegisteredExtension = (
  filePath: string,
  cwd: string,
): WfConfig | null => {
  try {
    const requireFromProject = createRequire(path.join(cwd, 'package.json'));
    const extensions = requireFromProject.extensions as
      | Record<string, unknown>
      | undefined;

    if (!extensions?.['.ts']) {
      return null;
    }

    return unwrapModuleExport(requireFromProject(filePath));
  } catch {
    return null;
  }
};

const loadJitiFromProject = (
  cwd: string,
): ((filePath: string) => unknown) | null => {
  try {
    const requireFromProject = createRequire(path.join(cwd, 'package.json'));
    const packageJsonPath = requireFromProject.resolve('jiti/package.json');
    const packageJson = requireFromProject(packageJsonPath) as {
      version?: string;
    };
    const version = packageJson.version ?? '0.0.0';

    if (!isVersionGte(version, 2, 2, 0)) {
      throw new ValidationError(
        `Installed jiti version ${version} is unsupported. Install jiti@2.2.0 or newer to load wf.config.ts files in Node.js.`,
      );
    }

    const createJiti = requireFromProject('jiti') as (
      filename: string,
    ) => (targetPath: string) => unknown;
    const jiti = createJiti(cwd);

    return (filePath: string) => jiti(filePath);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    return null;
  }
};

/**
 * Resolve the highest-priority config file in a project root.
 *
 * @param cwd - Consumer project root
 * @returns Absolute config path or null when no config exists
 */
export const discoverWfConfigPath = (cwd: string): string | null => {
  for (const fileName of CONFIG_FILE_NAMES) {
    const filePath = path.join(cwd, fileName);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }

  return null;
};

/**
 * Load a TypeScript `wf.config.ts` or `wf.config.mts` file.
 *
 * @param filePath - Absolute path to the config file
 * @param options - Runtime and loader overrides used for Node/Bun/Deno support
 * @returns Parsed config object
 */
export const loadTypeScriptConfig = async (
  filePath: string,
  options: TypeScriptConfigLoadOptions = {},
): Promise<WfConfig> => {
  const cwd = options.cwd ?? process.cwd();
  const runtime =
    options.runtime ??
    ((globalThis as typeof globalThis & { Bun?: unknown }).Bun
      ? 'bun'
      : 'node');
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const execArgv = options.execArgv ?? process.execArgv;

  if (runtime === 'bun' || runtime === 'deno') {
    return readConfigModule(filePath);
  }

  if (hasNativeNodeTypeStripping(nodeVersion, execArgv)) {
    return readConfigModule(filePath);
  }

  const registeredExtensionConfig = readTypeScriptConfigFromRegisteredExtension(
    filePath,
    cwd,
  );
  if (registeredExtensionConfig) {
    return registeredExtensionConfig;
  }

  const jitiLoader = options.loadJiti ?? loadJitiFromProject(cwd) ?? undefined;

  if (!jitiLoader) {
    throw new ValidationError(
      'Node.js cannot load wf TypeScript config files in this process. Install jiti@2.2.0 or newer as a dev dependency, or run Node.js >= 22.13.0 with --experimental-strip-types.',
    );
  }

  try {
    return unwrapModuleExport(jitiLoader(filePath));
  } catch {
    throw new ValidationError(
      'Node.js cannot load wf TypeScript config files in this process. Install jiti@2.2.0 or newer as a dev dependency, or run Node.js >= 22.13.0 with --experimental-strip-types.',
    );
  }
};

const loadConfigFile = async (
  filePath: string,
  options: TypeScriptConfigLoadOptions = {},
): Promise<WfConfig> => {
  const extension = path.extname(filePath);

  if (extension === '.yaml' || extension === '.yml') {
    return unwrapModuleExport({
      default: YAML.parse(fs.readFileSync(filePath, 'utf-8')) ?? {},
    });
  }

  if (extension === '.ts' || extension === '.mts') {
    return loadTypeScriptConfig(filePath, options);
  }

  if (extension === '.js') {
    return readJavaScriptConfigModule(filePath);
  }

  return readConfigModule(filePath);
};

const normalizeProvider = (
  provider: WfAiProviderConfig,
): WfAiProviderConfig & {
  default: boolean;
  model: string;
  maxTokens: number;
} => ({
  ...provider,
  default: provider.default ?? false,
  model: provider.model || getDefaultModelForProvider(provider.name),
  maxTokens: provider.maxTokens ?? 4096,
});

/**
 * Normalize user config into the runtime shape consumed by Nest ConfigService.
 *
 * @param rawConfig - Consumer-authored config object
 * @returns Normalized config with defaults applied
 */
export const normalizeWfConfig = (
  rawConfig: WfConfig = {},
): NormalizedWfConfig => {
  const { error, value } = configSchema.validate(rawConfig, {
    abortEarly: false,
  });

  if (error) {
    throw new ValidationError(
      `Invalid wf config: ${error.details.map((detail) => detail.message).join('; ')}`,
    );
  }

  const validatedConfig = value as WfConfig;
  const inputProviders = validatedConfig.ai?.length
    ? validatedConfig.ai
    : [
        {
          name: 'anthropic' as const,
          model: DEFAULT_ANTHROPIC_MODEL,
          default: true,
        },
      ];
  const providers = inputProviders.map(normalizeProvider);
  const defaultProviders = providers.filter((provider) => provider.default);

  if (defaultProviders.length > 1) {
    throw new ValidationError(
      'Invalid wf config: at most one AI provider may set default: true.',
    );
  }

  const activeProvider =
    defaultProviders[0] ??
    ({
      ...providers[0],
      default: true,
    } as (typeof providers)[number]);
  const loggingSource = validatedConfig.logging ?? validatedConfig.log ?? {};

  if ((validatedConfig.stages as { fetch?: string } | undefined)?.fetch) {
    throw new ValidationError(
      'Invalid wf config: fetch stage cannot be overridden in stages.',
    );
  }

  if ((validatedConfig.stages as { commit?: string } | undefined)?.commit) {
    throw new ValidationError(
      'Invalid wf config: commit stage cannot be overridden in stages.',
    );
  }

  const stages = SUPPORTED_STAGE_NAMES.reduce(
    (result, stageName) => {
      const stageModel = validatedConfig.stages?.[stageName];
      if (stageModel) {
        result[stageName] = stageModel;
      }
      return result;
    },
    {} as Partial<Record<SupportedStageName, string>>,
  );

  const providerMap = new Map(
    providers.map((provider) => [provider.name, provider]),
  );
  const anthropicProvider = providerMap.get('anthropic');
  const openaiProvider = providerMap.get('openai');
  const geminiProvider = providerMap.get('gemini');
  const deepseekProvider = providerMap.get('deepseek');
  const jiraApiToken =
    validatedConfig.atlassian?.jira?.apiToken ??
    validatedConfig.atlassian?.apiToken;

  return {
    platforms: {
      primary: validatedConfig.platforms?.primary ?? 'jira',
      enabled: validatedConfig.platforms?.enabled,
    },
    output: {
      defaultFormat: validatedConfig.output?.defaultFormat ?? 'md',
    },
    ai: {
      provider: activeProvider.name,
      providers,
      apiKey: activeProvider.apiKey,
      anthropicApiKey: anthropicProvider?.apiKey,
      openaiApiKey: openaiProvider?.apiKey,
      geminiApiKey: geminiProvider?.apiKey,
      deepseekApiKey: deepseekProvider?.apiKey,
      model: activeProvider.model,
      maxTokens: activeProvider.maxTokens,
      stages,
    },
    atlassian: {
      baseUrl: validatedConfig.atlassian?.baseUrl,
      email: validatedConfig.atlassian?.email,
      apiToken: jiraApiToken,
      jira: {
        apiToken: jiraApiToken,
        defaultProject: validatedConfig.atlassian?.jira?.defaultProject,
      },
      bitbucket: {
        workspace: validatedConfig.atlassian?.bitbucket?.workspace,
        apiToken: validatedConfig.atlassian?.bitbucket?.apiToken,
      },
    },
    github: {
      token: validatedConfig.github?.token,
      defaultRepo: validatedConfig.github?.defaultRepo,
    },
    git: {
      defaultBranch: validatedConfig.git?.defaultBranch ?? 'develop',
      commitFormat: validatedConfig.git?.commitFormat ?? 'auto',
    },
    branching: {
      atlassianPattern:
        validatedConfig.branching?.atlassianPattern ??
        '^(bugfix|build|chore|ci|docs|feat|feature|fix|perf|performance|refactor|revert|style|test)\\/[A-Z]+-[0-9]+__|__.+$',
      githubPattern:
        validatedConfig.branching?.githubPattern ??
        '^(bugfix|build|chore|ci|docs|feat|feature|fix|perf|performance|refactor|revert|style|test)\\/[A-Za-z0-9_-]+$',
      prefixMapping: {
        implement:
          validatedConfig.branching?.prefixMapping?.implement ?? 'feature',
        fix: validatedConfig.branching?.prefixMapping?.fix ?? 'bugfix',
        investigate:
          validatedConfig.branching?.prefixMapping?.investigate ?? 'chore',
      },
    },
    workflows: {
      directory: validatedConfig.workflows?.directory ?? '.windsurf/workflows',
      autoDiscovery: validatedConfig.workflows?.autoDiscovery ?? false,
    },
    state: {
      directory: resolveWfPath(validatedConfig.state?.directory, 'state'),
    },
    logging: {
      directory: resolveWfPath(loggingSource.directory, 'logs'),
      level: loggingSource.level ?? 'info',
    },
    log: {
      directory: resolveWfPath(loggingSource.directory, 'logs'),
      level: loggingSource.level ?? 'info',
    },
    app: {
      nodeEnv: validatedConfig.app?.nodeEnv ?? 'development',
    },
    slack: {
      botToken: validatedConfig.slack?.botToken,
    },
  };
};

/**
 * Load and normalize the effective wf config for a consumer project.
 *
 * @param options - Optional project root and runtime overrides
 * @returns Normalized config object
 */
export const loadWfConfig = async (
  options: WfConfigLoadOptions = {},
): Promise<NormalizedWfConfig> => {
  const cwd = options.cwd ?? process.cwd();
  const configPath = discoverWfConfigPath(cwd);

  if (!configPath) {
    return normalizeWfConfig({});
  }

  const rawConfig = await loadConfigFile(configPath, options);
  return normalizeWfConfig(rawConfig);
};

/**
 * Preload config before Nest bootstraps so the ConfigModule can remain sync.
 *
 * @param cwd - Optional project root override
 * @returns Loaded normalized config
 */
export const initializeWfConfig = async (
  cwd: string = process.cwd(),
): Promise<NormalizedWfConfig> => {
  loadedConfig = await loadWfConfig({ cwd });
  return loadedConfig;
};

/**
 * Return the preloaded config, loading defaults on first access if needed.
 *
 * @returns Normalized config object
 */
export const getLoadedWfConfig = (): NormalizedWfConfig => {
  if (!loadedConfig) {
    loadedConfig = normalizeWfConfig({});
  }

  return loadedConfig;
};
