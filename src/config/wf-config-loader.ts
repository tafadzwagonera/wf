import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { z } from 'zod';
import YAML from 'yaml';
import { ValidationError } from '../shared/utils/errors';
import { formatFieldNames } from '../shared/utils/zod-error.util';
import type {
  WfVerificationConditionsConfig,
  WfAiProviderConfig,
  WfAiStageTargetConfig,
  WfAiProviderName,
  WfBackendMode,
  WfConfig,
  NormalizedAiStageTargetConfig,
  NormalizedVerificationConditionsConfig,
  NormalizedImplementStageConfig,
  NormalizedCreateStageConfig,
} from '../shared/types/config.types';

export type {
  NormalizedAiStageTargetConfig,
  NormalizedVerificationConditionsConfig,
  NormalizedImplementStageConfig,
  NormalizedCreateStageConfig,
} from '../shared/types/config.types';

import {
  type StageBackendDefaultStageName,
  isAgentSupportedStage,
  resolveDefaultStageBackend,
} from './stage-backend-defaults';

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

type SupportedStageName = StageBackendDefaultStageName;
type SupportedModelStageName = Exclude<SupportedStageName, 'implement' | 'create'>;
const AGENT_SUPPORTED_PROVIDERS = new Set<WfAiProviderName>(['anthropic', 'openai']);

export interface NormalizedWfConfig {
  tracker: 'jira' | 'github' | 'bitbucket';
  ai: {
    provider: WfAiProviderName;
    providers: Array<
      WfAiProviderConfig & {
        default: boolean;
        model: string;
        maxTokens?: number;
      }
    >;
    apiKey?: string;
    anthropicApiKey?: string;
    openaiApiKey?: string;
    geminiApiKey?: string;
    deepseekApiKey?: string;
    model: string;
    maxTokens?: number;
    stages: Partial<Record<SupportedModelStageName, NormalizedAiStageTargetConfig>>;
  };
  stages: {
    plan?: NormalizedAiStageTargetConfig;
    implement?: NormalizedImplementStageConfig;
    create?: NormalizedCreateStageConfig;
    review?: NormalizedAiStageTargetConfig;
    generate?: NormalizedAiStageTargetConfig;
    commit?: NormalizedAiStageTargetConfig;
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
    commitFormat: 'conventional' | 'freeform' | 'auto';
    branchNamePattern: string;
    branchPrefixMapping: {
      feature: string;
      fix: string;
      investigate: string;
    };
  };
  logging: {
    level: 'error' | 'warn' | 'info' | 'debug';
  };
  log: {
    level: 'error' | 'warn' | 'info' | 'debug';
  };
  slack: {
    botToken?: string;
    userToken?: string;
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

const providerNames = ['anthropic', 'openai', 'google', 'deepseek'] as const;
const backendModes = ['agent', 'cli', 'standard'] as const;

const providerSchema = z.object({
  provider: z.enum(providerNames),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  maxTokens: z.number().int().min(1).optional(),
  default: z.boolean().optional(),
});

const verificationConditionsSchema = z
  .object({
    policyFile: z.string().min(1).optional(),
    scripts: z.record(z.string().min(1), z.string().min(1)).optional(),
  })
  .refine(data => data.policyFile || (data.scripts && Object.keys(data.scripts).length > 0), {
    message: 'verificationConditions must specify policyFile or scripts',
  });

const aiStageTargetSchema = z.object({
  provider: z.enum(providerNames),
  model: z.string().min(1).optional(),
  backend: z.enum(backendModes).optional(),
  outputFormat: z.enum(['json', 'md', 'yaml', 'yml']).optional(),
});

const createStageSchema = z.object({
  provider: z.enum(providerNames).optional(),
  model: z.string().min(1).optional(),
  backend: z.enum(backendModes).optional(),
  verificationConditions: verificationConditionsSchema.optional(),
});

const implementStageSchema = z
  .object({
    provider: z.enum(providerNames),
    model: z.string().min(1).optional(),
    models: z
      .object({
        default: z.string().min(1).optional(),
        mechanical: z.string().min(1).optional(),
      })
      .optional(),
    backend: z.enum(backendModes).optional(),
    verificationConditions: verificationConditionsSchema.optional(),
  })
  .strict();

const logLevels = ['error', 'warn', 'info', 'debug'] as const;

const configSchema = z
  .object({
    tracker: z.enum(['jira', 'github', 'bitbucket']).optional(),
    ai: z.array(providerSchema).optional(),
    atlassian: z
      .object({
        baseUrl: z.string().url().optional(),
        email: z.string().email().optional(),
        apiToken: z.string().optional(),
        jira: z
          .object({
            apiToken: z.string().optional(),
            defaultProject: z.string().optional(),
          })
          .optional(),
        bitbucket: z
          .object({
            workspace: z.string().optional(),
            apiToken: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
    github: z
      .object({
        token: z.string().optional(),
        defaultRepo: z.string().optional(),
      })
      .optional(),
    git: z
      .object({
        commitFormat: z.enum(['conventional', 'freeform', 'auto']).optional(),
        branchNamePattern: z.string().optional(),
        branchPrefixMapping: z
          .object({
            feature: z.string().optional(),
            fix: z.string().optional(),
            investigate: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
    state: z
      .object({
        directory: z.string().optional(),
      })
      .optional(),
    log: z
      .object({
        directory: z.string().optional(),
        level: z.enum(logLevels).optional(),
      })
      .optional(),
    logging: z
      .object({
        directory: z.string().optional(),
        level: z.enum(logLevels).optional(),
      })
      .optional(),
    slack: z
      .object({
        botToken: z.string().optional(),
        userToken: z.string().optional(),
      })
      .optional(),
    stages: z
      .object({
        plan: aiStageTargetSchema.optional(),
        implement: implementStageSchema.optional(),
        create: createStageSchema.optional(),
        review: aiStageTargetSchema.optional(),
        generate: aiStageTargetSchema.optional(),
        fetch: z.string().optional(),
        commit: aiStageTargetSchema.optional(),
      })
      .optional(),
  })
  .strict();

const getDefaultModelForProvider = (provider: WfAiProviderName): string => {
  if (provider === 'openai') return DEFAULT_OPENAI_MODEL;
  if (provider === 'google') return DEFAULT_GEMINI_MODEL;
  if (provider === 'deepseek') return DEFAULT_DEEPSEEK_MODEL;
  return DEFAULT_ANTHROPIC_MODEL;
};

const isGeminiConfig = ({ provider, model }: { provider: WfAiProviderName; model: string }): boolean =>
  provider === 'google' && model.startsWith('gemini');

const parseNodeVersion = (nodeVersion: string): [number, number, number] =>
  nodeVersion
    .split('.')
    .slice(0, 3)
    .map(segment => Number.parseInt(segment, 10) || 0) as [number, number, number];

const isVersionGte = (version: string, major: number, minor: number, patch: number): boolean => {
  const [versionMajor, versionMinor, versionPatch] = parseNodeVersion(version);
  if (versionMajor !== major) return versionMajor > major;
  if (versionMinor !== minor) return versionMinor > minor;
  return versionPatch >= patch;
};

const hasNativeNodeTypeStripping = (nodeVersion: string, execArgv: string[]): boolean =>
  isVersionGte(nodeVersion, 22, 13, 0) && execArgv.some(arg => arg.includes('--experimental-strip-types'));

const unwrapModuleExport = (loaded: unknown): WfConfig => {
  const candidate
    = loaded && typeof loaded === 'object' && 'default' in loaded ? (loaded as { default: unknown }).default : loaded;

  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new ValidationError('wf config files must export an object as the default export.');
  }

  return candidate as WfConfig;
};

const isEmptyModuleNamespace = (loaded: unknown): boolean => {
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
    return false;
  }

  const moduleTag = (loaded as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag];
  return moduleTag === 'Module' && Reflect.ownKeys(loaded).length === 0;
};

const readConfigModule = async (filePath: string): Promise<WfConfig> => {
  const loaded = await import(pathToFileURL(filePath).href);
  if (isEmptyModuleNamespace(loaded)) {
    throw new ValidationError(
      'wf config file exists but did not export a config object. Use export default { ... } for ESM configs or module.exports = { ... } for CommonJS configs.'
    );
  }

  return unwrapModuleExport(loaded);
};

const detectNearestPackageType = (filePath: string): 'module' | 'commonjs' | null => {
  let currentDir = path.dirname(filePath);
  const { root } = path.parse(currentDir);

  while (true) {
    const packageJsonPath = path.join(currentDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { type?: unknown };
        if (packageJson.type === 'module' || packageJson.type === 'commonjs') {
          return packageJson.type;
        }
      } catch {
        return null;
      }
    }

    if (currentDir === root) {
      return null;
    }

    currentDir = path.dirname(currentDir);
  }
};

const hasCommonJsExportSyntax = (sourceText: string): boolean => /\bmodule\.exports\b|\bexports\./.test(sourceText);

const evaluateConfigScript = (filePath: string, sourceText: string): unknown => {
  const requireFromConfig = createRequire(filePath);
  const module = { exports: {} as unknown };
  const context = vm.createContext({
    exports: module.exports,
    module,
    require: requireFromConfig,
    __filename: filePath,
    __dirname: path.dirname(filePath),
  });

  new vm.Script(sourceText, { filename: filePath }).runInContext(context);

  return module.exports;
};

const evaluateCommonJsConfigSource = (filePath: string, sourceText: string): WfConfig =>
  unwrapModuleExport(evaluateConfigScript(filePath, sourceText));

const hasImportSyntax = (sourceText: string): boolean => /^\s*import\s/m.test(sourceText);

const hasEsmDefaultExportSyntax = (sourceText: string): boolean => /^\s*export\s+default\b/m.test(sourceText);

const isEmptyEsmExportSource = (sourceText: string): boolean => /^\s*export\s*\{\s*\}\s*;?\s*$/.test(sourceText);

const evaluateEsmDefaultConfigSource = (filePath: string, sourceText: string): WfConfig => {
  const executableSource = sourceText.replace(/^\s*export\s+default\b/m, 'module.exports = ');

  return unwrapModuleExport(evaluateConfigScript(filePath, executableSource));
};

const readJavaScriptConfigModule = async (filePath: string): Promise<WfConfig> => {
  const sourceText = fs.readFileSync(filePath, 'utf-8');
  const nearestPackageType = detectNearestPackageType(filePath);

  if (nearestPackageType === 'module') {
    if (hasCommonJsExportSyntax(sourceText)) {
      return evaluateCommonJsConfigSource(filePath, sourceText);
    }

    try {
      return await readConfigModule(filePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (isEmptyEsmExportSource(sourceText)) {
        throw new ValidationError(
          'wf config file exists but did not export a config object. Use export default { ... } for ESM configs or module.exports = { ... } for CommonJS configs.'
        );
      }

      if (
        (message.includes('--experimental-vm-modules') || message.includes('Unexpected token \'export\''))
        && !hasImportSyntax(sourceText)
        && hasEsmDefaultExportSyntax(sourceText)
      ) {
        return evaluateEsmDefaultConfigSource(filePath, sourceText);
      }

      throw error;
    }
  }

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

const readTypeScriptConfigFromRegisteredExtension = (filePath: string, cwd: string): WfConfig | null => {
  try {
    const requireFromProject = createRequire(path.join(cwd, 'package.json'));
    const extensions = requireFromProject.extensions as Record<string, unknown> | undefined;

    if (!extensions?.['.ts']) {
      return null;
    }

    return unwrapModuleExport(requireFromProject(filePath));
  } catch {
    return null;
  }
};

const loadJitiFromProject = (cwd: string): ((filePath: string) => unknown) | null => {
  try {
    const requireFromProject = createRequire(path.join(cwd, 'package.json'));
    const packageJsonPath = requireFromProject.resolve('jiti/package.json');
    const packageJson = requireFromProject(packageJsonPath) as {
      version?: string;
    };
    const version = packageJson.version ?? '0.0.0';

    if (!isVersionGte(version, 2, 2, 0)) {
      throw new ValidationError(
        `Installed jiti version ${version} is unsupported. Install jiti@2.2.0 or newer to load wf.config.ts files in Node.js.`
      );
    }

    const createJiti = requireFromProject('jiti') as (filename: string) => (targetPath: string) => unknown;
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
  options: TypeScriptConfigLoadOptions = {}
): Promise<WfConfig> => {
  const cwd = options.cwd ?? process.cwd();
  const runtime = options.runtime ?? ((globalThis as typeof globalThis & { Bun?: unknown }).Bun ? 'bun' : 'node');
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const execArgv = options.execArgv ?? process.execArgv;

  if (runtime === 'bun' || runtime === 'deno') {
    return readConfigModule(filePath);
  }

  if (hasNativeNodeTypeStripping(nodeVersion, execArgv)) {
    return readConfigModule(filePath);
  }

  const registeredExtensionConfig = readTypeScriptConfigFromRegisteredExtension(filePath, cwd);
  if (registeredExtensionConfig) {
    return registeredExtensionConfig;
  }

  const jitiLoader = options.loadJiti ?? loadJitiFromProject(cwd) ?? undefined;

  if (!jitiLoader) {
    throw new ValidationError(
      'Node.js cannot load wf TypeScript config files in this process. Install jiti@2.2.0 or newer as a dev dependency, or run Node.js >= 22.13.0 with --experimental-strip-types.'
    );
  }

  try {
    return unwrapModuleExport(jitiLoader(filePath));
  } catch {
    throw new ValidationError(
      'Node.js cannot load wf TypeScript config files in this process. Install jiti@2.2.0 or newer as a dev dependency, or run Node.js >= 22.13.0 with --experimental-strip-types.'
    );
  }
};

const loadConfigFile = async (filePath: string, options: TypeScriptConfigLoadOptions = {}): Promise<WfConfig> => {
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
  provider: WfAiProviderConfig
): WfAiProviderConfig & {
  default: boolean;
  model: string;
  maxTokens?: number;
} => {
  const model = provider.model || getDefaultModelForProvider(provider.provider);

  return {
    ...provider,
    default: provider.default ?? false,
    model,
    maxTokens: isGeminiConfig({ provider: provider.provider, model }) ? (provider.maxTokens ?? 4096) : undefined,
  };
};

const normalizeVerificationConditionsConfig = (
  config?: WfVerificationConditionsConfig
): NormalizedVerificationConditionsConfig | undefined => {
  if (!config) {
    return undefined;
  }

  return {
    policyFile: config.policyFile,
    scripts: config.scripts ?? {},
  };
};

/**
 * Validate and normalize an explicit AI stage target against configured providers.
 *
 * @param stageName - Workflow stage name for error messages
 * @param stageTarget - Consumer-authored stage target
 * @param configuredProviderNames - Providers declared in ai[]
 * @returns Normalized stage target or undefined when absent
 */
const normalizeStageTarget = ({
  stageName,
  stageTarget,
  configuredProviderNames,
  configuredProvidersByName,
}: {
  stageName: SupportedStageName;
  stageTarget?: WfAiStageTargetConfig;
  configuredProviderNames: Set<WfAiProviderName>;
  configuredProvidersByName: Map<WfAiProviderName, { model: string }>;
}): NormalizedAiStageTargetConfig | undefined => {
  if (!stageTarget) {
    return undefined;
  }

  if (!configuredProviderNames.has(stageTarget.provider)) {
    throw new ValidationError(
      `Invalid wf config: ${stageName} stage references provider "${stageTarget.provider}" which is not configured in ai[].`
    );
  }

  const providerConfig = configuredProvidersByName.get(stageTarget.provider);
  const model = stageTarget.model ?? providerConfig?.model;
  if (!model) {
    throw new ValidationError(
      `Invalid wf config: ${stageName} stage must define model or configure a default model for provider "${stageTarget.provider}" in ai[].`
    );
  }

  const backend: WfBackendMode = stageTarget.backend ?? resolveDefaultStageBackend(stageName);
  if (backend !== 'standard' && !isAgentSupportedStage(stageName)) {
    throw new ValidationError(`Invalid wf config: ${stageName} stage does not support backend "${backend}".`);
  }
  if (backend === 'agent' && !AGENT_SUPPORTED_PROVIDERS.has(stageTarget.provider)) {
    throw new ValidationError(
      `Invalid wf config: ${stageName} stage with backend: 'agent' is unsupported for provider "${stageTarget.provider}".`
    );
  }
  return {
    provider: stageTarget.provider,
    model,
    backend,
    outputFormat: stageTarget.outputFormat,
  };
};

/**
 * Normalize user config into the runtime shape consumed by Nest ConfigService.
 *
 * @param rawConfig - Consumer-authored config object
 * @returns Normalized config with defaults applied
 */
export const normalizeWfConfig = (rawConfig: WfConfig = {}): NormalizedWfConfig => {
  const result = configSchema.safeParse(rawConfig);
  if (!result.success) {
    const fieldNames = result.error.issues.map(i => i.path.join('.'));
    throw new ValidationError(
      `Invalid wf config: validation failed for: ${formatFieldNames(fieldNames)}`,
      result.error
    );
  }

  const validatedConfig = result.data as WfConfig;
  const inputProviders = validatedConfig.ai?.length
    ? validatedConfig.ai
    : [
        {
          provider: 'anthropic' as const,
          model: DEFAULT_ANTHROPIC_MODEL,
          default: true,
        },
      ];
  const providers = inputProviders.map(normalizeProvider);
  const defaultProviders = providers.filter(provider => provider.default);

  if (defaultProviders.length > 1) {
    throw new ValidationError('Invalid wf config: at most one AI provider may set default: true.');
  }

  if (providers.length > 1 && defaultProviders.length === 0) {
    throw new ValidationError(
      'Invalid wf config: a default AI provider is required when multiple AI providers are configured.'
    );
  }

  const activeProvider
    = defaultProviders[0]
      ?? ({
        ...providers[0],
        default: true,
      } as (typeof providers)[number]);
  const loggingSource = validatedConfig.logging ?? validatedConfig.log ?? {};

  if ((validatedConfig.stages as { fetch?: string } | undefined)?.fetch) {
    throw new ValidationError('Invalid wf config: fetch stage cannot be overridden in stages.');
  }

  const configuredProviderNames = new Set(providers.map(provider => provider.provider));
  const configuredProvidersByName = new Map(providers.map(provider => [provider.provider, { model: provider.model }]));

  const aiStages = (['plan', 'review', 'generate', 'commit'] as const).reduce(
    (result, stageName) => {
      const stageTarget = normalizeStageTarget({
        stageName,
        stageTarget: validatedConfig.stages?.[stageName],
        configuredProviderNames,
        configuredProvidersByName,
      });
      if (stageTarget) {
        result[stageName] = stageTarget;
      }
      return result;
    },
    {} as Partial<Record<SupportedModelStageName, NormalizedAiStageTargetConfig>>
  );

  const normalizedImplementStage = (() => {
    const implementStageConfig = validatedConfig.stages?.implement;
    if (!implementStageConfig) {
      return undefined;
    }

    const implementTarget = normalizeStageTarget({
      stageName: 'implement',
      stageTarget: implementStageConfig,
      configuredProviderNames,
      configuredProvidersByName,
    });

    if (!implementTarget) {
      return undefined;
    }

    return {
      ...implementTarget,
      ...(implementStageConfig.models && {
        models: implementStageConfig.models,
      }),
      verificationConditions: normalizeVerificationConditionsConfig(implementStageConfig.verificationConditions),
    };
  })();

  const normalizedCreateStage = (() => {
    const createStageConfig = validatedConfig.stages?.create;

    if (!createStageConfig) {
      return undefined;
    }

    // The create stage supports validation-only mode (no provider needed).
    // Only resolve provider/model when one is explicitly configured.
    if (createStageConfig.provider) {
      const createTarget = normalizeStageTarget({
        stageName: 'create',
        stageTarget: createStageConfig as WfAiStageTargetConfig,
        configuredProviderNames,
        configuredProvidersByName,
      });

      if (!createTarget) {
        return undefined;
      }

      return {
        ...createTarget,
        verificationConditions: normalizeVerificationConditionsConfig(createStageConfig.verificationConditions),
      };
    }

    return {
      verificationConditions: normalizeVerificationConditionsConfig(createStageConfig.verificationConditions),
    };
  })();

  const providerMap = new Map(providers.map(provider => [provider.provider, provider]));
  const anthropicProvider = providerMap.get('anthropic');
  const openaiProvider = providerMap.get('openai');
  const geminiProvider = providerMap.get('google');
  const deepseekProvider = providerMap.get('deepseek');
  const jiraApiToken = validatedConfig.atlassian?.jira?.apiToken ?? validatedConfig.atlassian?.apiToken;

  return {
    tracker: validatedConfig.tracker ?? 'jira',
    ai: {
      provider: activeProvider.provider,
      providers,
      apiKey: activeProvider.apiKey,
      anthropicApiKey: anthropicProvider?.apiKey,
      openaiApiKey: openaiProvider?.apiKey,
      geminiApiKey: geminiProvider?.apiKey,
      deepseekApiKey: deepseekProvider?.apiKey,
      model: activeProvider.model,
      maxTokens: activeProvider.maxTokens,
      stages: aiStages,
    },
    stages: {
      plan: aiStages.plan,
      implement: normalizedImplementStage,
      create: normalizedCreateStage,
      review: aiStages.review,
      generate: aiStages.generate,
      commit: aiStages.commit,
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
      commitFormat: validatedConfig.git?.commitFormat ?? 'auto',
      branchNamePattern:
        validatedConfig.git?.branchNamePattern
        ?? '^(bugfix|build|chore|ci|docs|feat|feature|fix|perf|performance|refactor|revert|style|test)\\/[A-Z]+-[0-9]+__|-.+$',
      branchPrefixMapping: {
        feature: validatedConfig.git?.branchPrefixMapping?.feature ?? 'feature',
        fix: validatedConfig.git?.branchPrefixMapping?.fix ?? 'bugfix',
        investigate: validatedConfig.git?.branchPrefixMapping?.investigate ?? 'chore',
      },
    },
    logging: {
      level: loggingSource.level ?? 'info',
    },
    log: {
      level: loggingSource.level ?? 'info',
    },
    slack: {
      botToken: validatedConfig.slack?.botToken,
      userToken: validatedConfig.slack?.userToken,
    },
  };
};

/**
 * Load and normalize the effective wf config for a consumer project.
 *
 * @param options - Optional project root and runtime overrides
 * @returns Normalized config object
 */
export const loadWfConfig = async (options: WfConfigLoadOptions = {}): Promise<NormalizedWfConfig> => {
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
export const initializeWfConfig = async (cwd: string = process.cwd()): Promise<NormalizedWfConfig> => {
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
