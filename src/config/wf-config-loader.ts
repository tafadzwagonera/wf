import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import YAML from 'yaml';
import { ValidationError } from '../common/utils/errors';
import { wfConfigSchema } from '../common/schemas/config.schema';
import { formatFieldNames } from '../common/utils/zod-error.util';
import { findModelProviderMismatch } from '../common/utils/model-provider-match';
import { setWfPathOverrides } from '../common/utils/wf-paths';
import { appendToLogFile } from '../common/logger/log-file-writer';
import { lazyModuleKey, requireLazyModule } from '../bootstrap/lazy-module';
import { isSeaRuntime } from '../common/utils/runtime-assets';
import type {
  WfVerificationConditionsConfig,
  NormalizedAiProviderConfig,
  WfAiProviderConfig,
  WfAiStageTargetConfig,
  WfAiProviderName,
  WfBackendMode,
  WfConfig,
  WfImplementStageConfig,
  WfCreateStageConfig,
  LogLevel,
  NormalizedAiStageTargetConfig,
  NormalizedVerificationConditionsConfig,
  NormalizedImplementStageConfig,
  NormalizedCreateStageConfig,
  NormalizedPlanStageConfig,
  NormalizedReviewStageConfig,
  WfPlanStageConfig,
  WfReviewStageConfig,
} from '../common/types/config.types';

export type {
  NormalizedAiStageTargetConfig,
  NormalizedVerificationConditionsConfig,
  NormalizedImplementStageConfig,
  NormalizedCreateStageConfig,
  NormalizedPlanStageConfig,
  NormalizedReviewStageConfig,
} from '../common/types/config.types';

import {
  type StageBackendDefaultStageName,
  isAgentSupportedStage,
  resolveDefaultStageBackend,
} from './stage-backend-defaults';

import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_OPENAI_MODEL,
} from '../common/constant';

const configFileNames = [
  'wf.config.ts',
  'wf.config.mts',
  'wf.config.js',
  'wf.config.mjs',
  'wf.config.yaml',
  'wf.config.yml',
] as const;

type SupportedStageName = StageBackendDefaultStageName;
type SupportedModelStageName = Exclude<SupportedStageName, 'implement'>;
const modelStageNames = ['plan', 'review', 'generate', 'commit'] as const;

const agentSupportedProviders = new Set<WfAiProviderName>(['anthropic', 'openai']);

export interface NormalizedWfConfig {
  tracker: 'jira' | 'github' | 'bitbucket';
  ai: {
    provider: WfAiProviderName;
    providers: NormalizedAiProviderConfig[];
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
    plan?: NormalizedPlanStageConfig;
    implement?: NormalizedImplementStageConfig;
    create?: NormalizedCreateStageConfig;
    review?: NormalizedReviewStageConfig;
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
    protectedBranches?: string[];
  };
  state: {
    directory?: string;
  };
  logging: {
    directory?: string;
    level: 'error' | 'warn' | 'info' | 'debug';
  };
  log: {
    directory?: string;
    level: 'error' | 'warn' | 'info' | 'debug';
  };
  slack: {
    botToken?: string;
    userToken?: string;
  };
  figma: {
    token?: string;
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

const getDefaultModelForProvider = (provider: WfAiProviderName): string => {
  if (provider === 'openai') return DEFAULT_OPENAI_MODEL;
  if (provider === 'google') return DEFAULT_GEMINI_MODEL;
  if (provider === 'deepseek') return DEFAULT_DEEPSEEK_MODEL;
  return DEFAULT_ANTHROPIC_MODEL;
};

const isGeminiConfig = ({ provider, model }: { provider: WfAiProviderName; model: string }): boolean =>
  provider === 'google' && model.startsWith('gemini');

/**
 * Validates that a model name is not obviously mismatched with its declared provider.
 * Throws when a well-known model prefix (e.g. `gpt-`) maps to a different provider
 * than the one declared. Unknown prefixes pass without error.
 *
 * @param provider - Declared provider name from the config entry
 * @param model - Explicit model name from the config entry (not the default)
 */
const validateProviderModelMatch = (provider: WfAiProviderName, model: string): void => {
  const mismatch = findModelProviderMismatch(provider, model);
  if (!mismatch) return;
  throw new ValidationError(
    `Invalid wf config: model "${model}" does not match provider "${provider}".`
    + ` Models starting with "${mismatch.prefix}" belong to the "${mismatch.expectedProvider}" provider.`
  );
};

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

const readPackageJsonType = (packageJsonPath: string): 'module' | 'commonjs' | null => {
  if (!fs.existsSync(packageJsonPath)) return null;
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { type?: unknown };
    return packageJson.type === 'module' || packageJson.type === 'commonjs' ? packageJson.type : null;
  } catch {
    return null;
  }
};

const detectNearestPackageType = (filePath: string): 'module' | 'commonjs' | null => {
  let currentDir = path.dirname(filePath);
  const { root } = path.parse(currentDir);

  while (currentDir !== root) {
    const packageJsonType = readPackageJsonType(path.join(currentDir, 'package.json'));
    if (packageJsonType) return packageJsonType;
    currentDir = path.dirname(currentDir);
  }

  return readPackageJsonType(path.join(root, 'package.json'));
};

const hasCommonJsExportSyntax = (sourceText: string): boolean => /\bmodule\.exports\b|\bexports\./.test(sourceText);

const createConfigScriptContext = (filePath: string, module: { exports: unknown }): vm.Context =>
  vm.createContext({
    exports: module.exports,
    module,
    require: createRequire(filePath),
    __filename: filePath,
    __dirname: path.dirname(filePath),
  });

const rethrowConfigScriptError = (filePath: string, error: unknown): never => {
  if (error instanceof ValidationError) {
    throw error;
  }

  const originalMessage = error instanceof Error ? error.message : String(error);
  throw new ValidationError(`Failed to evaluate config file "${filePath}": ${originalMessage}`);
};

const evaluateConfigScript = (filePath: string, sourceText: string): unknown => {
  const module = { exports: {} as unknown };
  try {
    new vm.Script(sourceText, { filename: filePath }).runInContext(createConfigScriptContext(filePath, module));
  } catch (error) {
    rethrowConfigScriptError(filePath, error);
  }

  return module.exports;
};

const evaluateCommonJsConfigSource = (filePath: string, sourceText: string): WfConfig =>
  unwrapModuleExport(evaluateConfigScript(filePath, sourceText));

const hasImportSyntax = (sourceText: string): boolean => /^\s*import\s/m.test(sourceText);

const hasEsmDefaultExportSyntax = (sourceText: string): boolean => /^\s*export\s+default\b/m.test(sourceText);

const isEmptyEsmExportSource = (sourceText: string): boolean => /^\s*export\s*\{\s*}\s*;?\s*$/.test(sourceText);

const evaluateEsmDefaultConfigSource = (filePath: string, sourceText: string): WfConfig => {
  const executableSource = sourceText.replace(/^\s*export\s+default\b/m, 'module.exports = ');

  return unwrapModuleExport(evaluateConfigScript(filePath, executableSource));
};

const buildMissingConfigError = (): ValidationError =>
  new ValidationError(
    'wf config file exists but did not export a config object. Use export default { ... } for ESM configs or module.exports = { ... } for CommonJS configs.'
  );

const shouldEvaluateEsmDefaultConfigSource = (message: string, sourceText: string): boolean =>
  (message.includes('--experimental-vm-modules') || message.includes('Unexpected token \'export\''))
  && !hasImportSyntax(sourceText)
  && hasEsmDefaultExportSyntax(sourceText);

const loadCommonJsConfigModule = (filePath: string): WfConfig => {
  const requireFromConfig = createRequire(filePath);
  return unwrapModuleExport(requireFromConfig(filePath));
};

const loadEsmConfigModule = async (filePath: string): Promise<WfConfig> => readConfigModule(filePath);

const handleEsmModuleLoadError = (filePath: string, sourceText: string, error: unknown): WfConfig => {
  const message = error instanceof Error ? error.message : String(error);
  if (isEmptyEsmExportSource(sourceText)) {
    throw buildMissingConfigError();
  }
  if (shouldEvaluateEsmDefaultConfigSource(message, sourceText)) {
    return evaluateEsmDefaultConfigSource(filePath, sourceText);
  }
  throw error;
};

const loadJavaScriptConfigFromModulePackage = async (filePath: string, sourceText: string): Promise<WfConfig> => {
  if (hasCommonJsExportSyntax(sourceText)) {
    return evaluateCommonJsConfigSource(filePath, sourceText);
  }

  try {
    return await loadEsmConfigModule(filePath);
  } catch (error) {
    return handleEsmModuleLoadError(filePath, sourceText, error);
  }
};

const loadJavaScriptConfigFromCommonJsPackage = async (filePath: string): Promise<WfConfig> => {
  try {
    return loadCommonJsConfigModule(filePath);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('import')) {
      throw error;
    }

    return readConfigModule(filePath);
  }
};

const readJavaScriptConfigModule = async (filePath: string): Promise<WfConfig> => {
  const sourceText = fs.readFileSync(filePath, 'utf-8');
  const nearestPackageType = detectNearestPackageType(filePath);

  if (nearestPackageType === 'module') {
    return loadJavaScriptConfigFromModulePackage(filePath, sourceText);
  }

  return loadJavaScriptConfigFromCommonJsPackage(filePath);
};

const createProjectRequire = (cwd: string): ReturnType<typeof createRequire> =>
  createRequire(path.join(cwd, 'package.json'));

interface RegisteredRequireExtensions {
  extensions?: Record<string, unknown>;
}

const readTypeScriptConfigFromRegisteredExtension = (filePath: string, cwd: string): WfConfig | null => {
  try {
    const requireFromProject = createProjectRequire(cwd);
    const registeredExtensions = (requireFromProject as unknown as RegisteredRequireExtensions).extensions;

    if (!registeredExtensions?.['.ts']) {
      return null;
    }

    return unwrapModuleExport(requireFromProject(filePath));
  } catch {
    return null;
  }
};

const readJitiPackageVersion = (cwd: string): string => {
  const requireFromProject = createProjectRequire(cwd);
  const packageJsonPath = requireFromProject.resolve('jiti/package.json');
  const packageJson = requireFromProject(packageJsonPath) as { version?: string };
  return packageJson.version ?? '0.0.0';
};

const buildUnsupportedTypeScriptConfigError = (): ValidationError =>
  new ValidationError(
    'Node.js cannot load wf TypeScript config files in this process. Install jiti@2.2.0 or newer as a dev dependency, or run Node.js >= 22.13.0 with --experimental-strip-types.'
  );

const createJitiModuleLoader = (cwd: string): ((filePath: string) => unknown) => {
  const createJiti = createProjectRequire(cwd)('jiti') as (filename: string) => (targetPath: string) => unknown;
  const jiti = createJiti(cwd);
  return (filePath: string) => jiti(filePath);
};

const assertSupportedJitiVersion = (cwd: string): void => {
  const version = readJitiPackageVersion(cwd);
  if (!isVersionGte(version, 2, 2, 0)) {
    throw new ValidationError(
      `Installed jiti version ${version} is unsupported. Install jiti@2.2.0 or newer to load wf.config.ts files in Node.js.`
    );
  }
};

const createJitiLoader = (cwd: string): ((filePath: string) => unknown) | null => {
  try {
    assertSupportedJitiVersion(cwd);
    return createJitiModuleLoader(cwd);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    return null;
  }
};

const createBundledJitiLoader = (cwd: string): ((filePath: string) => unknown) => {
  const createJiti = requireLazyModule(lazyModuleKey.jiti, () => {
    throw new ValidationError('Bundled jiti is not registered in this process.');
  }) as (filename: string) => (targetPath: string) => unknown;
  const jiti = createJiti(cwd);
  return (filePath: string) => jiti(filePath);
};

const shouldReadTypeScriptConfigDirectly = (runtime: string, nodeVersion: string, execArgv: string[]): boolean =>
  runtime === 'bun'
  || runtime === 'deno'
  || hasNativeNodeTypeStripping(nodeVersion, execArgv);

const getTypeScriptConfigLoader = (
  options: TypeScriptConfigLoadOptions,
  cwd: string
): ((filePath: string) => unknown) | null | undefined =>
  options.loadJiti
  ?? (isSeaRuntime() ? createBundledJitiLoader(cwd) : createJitiLoader(cwd))
  ?? undefined;

const loadTypeScriptConfigWithLoader = (
  loader: (filePath: string) => unknown,
  filePath: string
): WfConfig => {
  try {
    return unwrapModuleExport(loader(filePath));
  } catch {
    throw buildUnsupportedTypeScriptConfigError();
  }
};

/**
 * Resolve the highest-priority config file in a project root.
 *
 * @param cwd - Consumer project root
 * @returns Absolute config path or null when no config exists
 */
export const discoverWfConfigPath = (cwd: string): string | null => {
  const found = configFileNames.map(f => path.join(cwd, f)).filter(p => fs.existsSync(p));
  if (found.length === 0) return null;
  if (found.length > 1) {
    console.warn(
      `Multiple wf config files found. Using ${path.basename(found[0])}, ignoring: ${found.slice(1).map(p => path.basename(p)).join(', ')}`
    );
  }
  return found[0];
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

  if (shouldReadTypeScriptConfigDirectly(runtime, nodeVersion, execArgv)) return readConfigModule(filePath);
  const registeredExtensionConfig = readTypeScriptConfigFromRegisteredExtension(filePath, cwd);
  if (registeredExtensionConfig) return registeredExtensionConfig;
  const jitiLoader = getTypeScriptConfigLoader(options, cwd);
  if (!jitiLoader) throw buildUnsupportedTypeScriptConfigError();
  return loadTypeScriptConfigWithLoader(jitiLoader, filePath);
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

const normalizeProvider = (provider: WfAiProviderConfig): NormalizedAiProviderConfig => {
  if (provider.model) validateProviderModelMatch(provider.provider, provider.model);
  const model = provider.model || getDefaultModelForProvider(provider.provider);
  const maxTokens = isGeminiConfig({ provider: provider.provider, model }) ? (provider.maxTokens ?? 4096) : undefined;
  return { ...provider, default: provider.default ?? false, model, maxTokens };
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

const assertStageTargetProviderIsConfigured = (
  stageName: SupportedStageName,
  stageTarget: WfAiStageTargetConfig,
  configuredProviderNames: Set<WfAiProviderName>
): void => {
  if (!configuredProviderNames.has(stageTarget.provider)) {
    throw new ValidationError(
      `Invalid wf config: ${stageName} stage references provider "${stageTarget.provider}" which is not configured in ai[].`
    );
  }
};

const resolveStageTargetModel = (
  stageName: SupportedStageName,
  stageTarget: WfAiStageTargetConfig,
  configuredProvidersByName: Map<WfAiProviderName, { model: string }>
): string => {
  const providerConfig = configuredProvidersByName.get(stageTarget.provider);
  const model = stageTarget.model ?? providerConfig?.model;

  if (!model) {
    throw new ValidationError(
      `Invalid wf config: ${stageName} stage must define model or configure a default model for provider "${stageTarget.provider}" in ai[].`
    );
  }

  return model;
};

const buildInvalidStageBackendError = (stageName: SupportedStageName, backend: WfBackendMode): ValidationError =>
  new ValidationError(`Invalid wf config: ${stageName} stage does not support backend "${backend}".`);

const buildUnsupportedAgentStageProviderError = (
  stageName: SupportedStageName,
  provider: WfAiProviderName
): ValidationError =>
  new ValidationError(
    `Invalid wf config: ${stageName} stage with backend: 'agent' is unsupported for provider "${provider}".`
  );

const resolveStageTargetBackend = (
  stageName: SupportedStageName,
  stageTarget: WfAiStageTargetConfig
): WfBackendMode => {
  const backend: WfBackendMode = stageTarget.backend ?? resolveDefaultStageBackend(stageName);

  if (backend !== 'standard' && !isAgentSupportedStage(stageName)) {
    throw buildInvalidStageBackendError(stageName, backend);
  }

  if (backend === 'agent' && !agentSupportedProviders.has(stageTarget.provider)) {
    throw buildUnsupportedAgentStageProviderError(stageName, stageTarget.provider);
  }

  return backend;
};

type StageTargetInput = {
  stageName: SupportedStageName;
  stageTarget?: WfAiStageTargetConfig;
  configuredProviderNames: Set<WfAiProviderName>;
  configuredProvidersByName: Map<WfAiProviderName, { model: string }>;
};

type ImplementStageInput = {
  implementStageConfig: WfImplementStageConfig | undefined;
  implementTarget: NormalizedAiStageTargetConfig | undefined;
};

const buildNormalizedStageTarget = (
  stageTarget: WfAiStageTargetConfig,
  model: string,
  backend: WfBackendMode
): NormalizedAiStageTargetConfig => ({
  provider: stageTarget.provider,
  model,
  backend,
  maxTokens: stageTarget.maxTokens,
  outputFormat: stageTarget.outputFormat,
  timeoutMs: stageTarget.timeoutMs,
  inactivityTimeoutMs: stageTarget.inactivityTimeoutMs,
});

/**
 * Validate and normalize an explicit AI stage target against configured providers.
 *
 * @param stageName - Workflow stage name for error messages
 * @param stageTarget - Consumer-authored stage target
 * @param configuredProviderNames - Providers declared in ai[]
 * @param configuredProvidersByName - Map from provider name to its configured model
 * @returns Normalized stage target or undefined when absent
 */
const normalizeStageTarget = ({
  stageName,
  stageTarget,
  configuredProviderNames,
  configuredProvidersByName,
}: StageTargetInput): NormalizedAiStageTargetConfig | undefined => {
  if (!stageTarget) return undefined;
  assertStageTargetProviderIsConfigured(stageName, stageTarget, configuredProviderNames);
  if (stageTarget.model) validateProviderModelMatch(stageTarget.provider, stageTarget.model);
  const model = resolveStageTargetModel(stageName, stageTarget, configuredProvidersByName);
  const backend = resolveStageTargetBackend(stageName, stageTarget);
  return buildNormalizedStageTarget(stageTarget, model, backend);
};

/**
 * Normalize the implement stage configuration, handling both single-model and multi-model configs.
 * Strips the provider-injected model when the user didn't explicitly set it, so that
 * resolveModelConfig falls through to the hardcoded mechanical default for auto-routing.
 * When models is present, always strips the injected model to prevent conflicts.
 */
const omitModel = (
  stageTarget: NormalizedAiStageTargetConfig
): Omit<NormalizedAiStageTargetConfig, 'model'> => {
  const rest: Partial<NormalizedAiStageTargetConfig> = { ...stageTarget };
  delete rest.model;
  return rest as Omit<NormalizedAiStageTargetConfig, 'model'>;
};

const resolveImplementStageTargetConfig = (
  implementStageConfig: WfImplementStageConfig,
  implementTarget: NormalizedAiStageTargetConfig
): NormalizedAiStageTargetConfig | Omit<NormalizedAiStageTargetConfig, 'model'> =>
  implementStageConfig.model !== undefined && implementStageConfig.models === undefined
    ? implementTarget
    : omitModel(implementTarget);

const buildImplementStageOptionalFields = (implementStageConfig: WfImplementStageConfig) => ({
  ...(implementStageConfig.models && { models: implementStageConfig.models }),
  ...(implementStageConfig.modelRoutingThresholds && {
    modelRoutingThresholds: implementStageConfig.modelRoutingThresholds,
  }),
  ...(implementStageConfig.skills && { skills: implementStageConfig.skills }),
  ...(implementStageConfig.planStepVerification && {
    planStepVerification: implementStageConfig.planStepVerification,
  }),
  ...(implementStageConfig.designConformance && { designConformance: implementStageConfig.designConformance }),
  ...(implementStageConfig.figma !== undefined && { figma: implementStageConfig.figma }),
  ...(implementStageConfig.stallThresholdForVerificationFix !== undefined && {
    stallThresholdForVerificationFix: implementStageConfig.stallThresholdForVerificationFix,
  }),
});

const validateImplementStageModels = (
  implementStageConfig: WfImplementStageConfig,
  implementProvider: WfAiProviderName
): void => {
  const { models, planStepVerification } = implementStageConfig;
  for (const model of [models?.default, models?.mechanical]) {
    if (model) validateProviderModelMatch(implementProvider, model);
  }
  if (!planStepVerification?.model) return;
  validateProviderModelMatch(planStepVerification.provider ?? implementProvider, planStepVerification.model);
};

const normalizeImplementStageConfig = (
  { implementStageConfig, implementTarget }: ImplementStageInput,
): NormalizedImplementStageConfig | undefined => {
  if (!implementStageConfig || !implementTarget) return undefined;
  validateImplementStageModels(implementStageConfig, implementTarget.provider);
  return {
    ...resolveImplementStageTargetConfig(implementStageConfig, implementTarget),
    ...buildImplementStageOptionalFields(implementStageConfig),
    verificationConditions: normalizeVerificationConditionsConfig(implementStageConfig.verificationConditions),
  };
};

const normalizeCreateStageConfig = (
  createStageConfig: WfCreateStageConfig | undefined
): NormalizedCreateStageConfig | undefined => {
  if (!createStageConfig) return undefined;
  return { verificationConditions: normalizeVerificationConditionsConfig(createStageConfig.verificationConditions) };
};

const normalizePlanStageConfig = (
  planConfig: WfPlanStageConfig | undefined,
  planTarget: NormalizedAiStageTargetConfig | undefined
): NormalizedPlanStageConfig | undefined => {
  if (!planTarget) return undefined;
  return {
    ...planTarget,
    ...(planConfig?.skills && { skills: planConfig.skills }),
    ...(planConfig?.figma !== undefined && { figma: planConfig.figma }),
  };
};

const normalizeReviewStageConfig = (
  reviewConfig: WfReviewStageConfig | undefined,
  reviewTarget: NormalizedAiStageTargetConfig | undefined
): NormalizedReviewStageConfig | undefined => {
  if (!reviewTarget) return undefined;
  const normalized: NormalizedReviewStageConfig = { ...reviewTarget };
  if (reviewConfig?.maxDiffLength !== undefined) normalized.maxDiffLength = reviewConfig.maxDiffLength;
  if (reviewConfig?.epilogueTimeoutMs !== undefined) normalized.epilogueTimeoutMs = reviewConfig.epilogueTimeoutMs;
  if (reviewConfig?.sonar !== undefined) normalized.sonar = reviewConfig.sonar;
  if (reviewConfig?.figma !== undefined) normalized.figma = reviewConfig.figma;
  return normalized;
};

const getInputProviders = (validatedConfig: WfConfig): WfAiProviderConfig[] =>
  validatedConfig.ai?.length
    ? validatedConfig.ai
    : [
        {
          provider: 'anthropic',
          model: DEFAULT_ANTHROPIC_MODEL,
          default: true,
        },
      ];

const getDefaultProviders = (providers: NormalizedAiProviderConfig[]): NormalizedAiProviderConfig[] =>
  providers.filter(provider => provider.default);

const assertProviderDefaultRules = (
  providers: NormalizedAiProviderConfig[],
  defaultProviders: NormalizedAiProviderConfig[]
): void => {
  if (defaultProviders.length > 1) {
    throw new ValidationError('Invalid wf config: at most one AI provider may set default: true.');
  }

  if (providers.length > 1 && defaultProviders.length === 0) {
    throw new ValidationError(
      'Invalid wf config: a default AI provider is required when multiple AI providers are configured.'
    );
  }
};

const selectActiveProvider = (
  providers: NormalizedAiProviderConfig[],
  defaultProviders: NormalizedAiProviderConfig[]
): NormalizedAiProviderConfig =>
  defaultProviders[0] ?? ({
    ...providers[0],
    default: true,
  } as NormalizedAiProviderConfig);

const getProviderConfig = (
  providers: NormalizedAiProviderConfig[],
  providerName: WfAiProviderName
): NormalizedAiProviderConfig | undefined => providers.find(provider => provider.provider === providerName);

const buildConfiguredProviderLookup = (providers: NormalizedAiProviderConfig[]): {
  configuredProviderNames: Set<WfAiProviderName>;
  configuredProvidersByName: Map<WfAiProviderName, { model: string }>;
} => ({
  configuredProviderNames: new Set(providers.map(provider => provider.provider)),
  configuredProvidersByName: new Map(providers.map(provider => [provider.provider, { model: provider.model }])),
});

const buildAiStageTargets = (
  validatedConfig: WfConfig,
  configuredProviderNames: Set<WfAiProviderName>,
  configuredProvidersByName: Map<WfAiProviderName, { model: string }>
): Partial<Record<SupportedModelStageName, NormalizedAiStageTargetConfig>> =>
  modelStageNames.reduce(
    (result, stageName) =>
      addStageTarget(result, validatedConfig, stageName, configuredProviderNames, configuredProvidersByName),
    {} as Partial<Record<SupportedModelStageName, NormalizedAiStageTargetConfig>>
  );

const addStageTarget = (
  result: Partial<Record<SupportedModelStageName, NormalizedAiStageTargetConfig>>,
  validatedConfig: WfConfig,
  stageName: SupportedModelStageName,
  configuredProviderNames: Set<WfAiProviderName>,
  configuredProvidersByName: Map<WfAiProviderName, { model: string }>
): Partial<Record<SupportedModelStageName, NormalizedAiStageTargetConfig>> => {
  const stageTarget = normalizeStageTarget({
    stageName,
    stageTarget: validatedConfig.stages?.[stageName],
    configuredProviderNames,
    configuredProvidersByName,
  });
  return stageTarget ? { ...result, [stageName]: stageTarget } : result;
};

const resolveImplementStageTarget = (
  validatedConfig: WfConfig,
  configuredProviderNames: Set<WfAiProviderName>,
  configuredProvidersByName: Map<WfAiProviderName, { model: string }>
): NormalizedAiStageTargetConfig | undefined => {
  const implementStageConfig = validatedConfig.stages?.implement;
  return implementStageConfig
    ? normalizeStageTarget({
        stageName: 'implement',
        stageTarget: implementStageConfig,
        configuredProviderNames,
        configuredProvidersByName,
      })
    : undefined;
};

const hasFetchStageOverride = (validatedConfig: WfConfig): boolean =>
  Boolean((validatedConfig.stages as { fetch?: string } | undefined)?.fetch);

const buildAtlassianConfig = (validatedConfig: WfConfig, jiraApiToken: string | undefined) => ({
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
});

const buildGitConfig = (validatedConfig: WfConfig) => ({
  commitFormat: validatedConfig.git?.commitFormat ?? 'auto',
  branchNamePattern:
    validatedConfig.git?.branchNamePattern
    ?? String.raw`^(bugfix|build|chore|ci|docs|feat|feature|fix|perf|performance|refactor|revert|style|test)\/[A-Z]+-[0-9]+__|-.+$`,
  branchPrefixMapping: {
    feature: validatedConfig.git?.branchPrefixMapping?.feature ?? 'feature',
    fix: validatedConfig.git?.branchPrefixMapping?.fix ?? 'bugfix',
    investigate: validatedConfig.git?.branchPrefixMapping?.investigate ?? 'chore',
  },
  protectedBranches: validatedConfig.git?.protectedBranches,
});

type LoggingSourceConfig = { directory?: string; level?: LogLevel };

const buildLoggingConfig = (loggingSource: LoggingSourceConfig): { directory?: string; level: LogLevel } => ({
  directory: loggingSource.directory,
  level: loggingSource.level ?? 'info',
});

type NormalizedStages = {
  aiStages: Partial<Record<SupportedModelStageName, NormalizedAiStageTargetConfig>>;
  normalizedPlanStage: NormalizedPlanStageConfig | undefined;
  normalizedImplementStage: NormalizedImplementStageConfig | undefined;
  normalizedCreateStage: NormalizedCreateStageConfig | undefined;
  normalizedReviewStage: NormalizedReviewStageConfig | undefined;
};

const buildNormalizedStagesFromAiStages = (
  aiStages: Partial<Record<SupportedModelStageName, NormalizedAiStageTargetConfig>>,
  validatedConfig: WfConfig,
  configuredProviderNames: Set<WfAiProviderName>,
  configuredProvidersByName: Map<WfAiProviderName, { model: string }>
): NormalizedStages => ({
  aiStages,
  normalizedPlanStage: normalizePlanStageConfig(validatedConfig.stages?.plan, aiStages.plan),
  normalizedImplementStage: normalizeImplementStageConfig({
    implementStageConfig: validatedConfig.stages?.implement,
    implementTarget: resolveImplementStageTarget(validatedConfig, configuredProviderNames, configuredProvidersByName),
  }),
  normalizedCreateStage: normalizeCreateStageConfig(validatedConfig.stages?.create),
  normalizedReviewStage: normalizeReviewStageConfig(validatedConfig.stages?.review, aiStages.review),
});

const buildNormalizedStages = (
  validatedConfig: WfConfig,
  configuredProviderNames: Set<WfAiProviderName>,
  configuredProvidersByName: Map<WfAiProviderName, { model: string }>
): NormalizedStages => buildNormalizedStagesFromAiStages(
  buildAiStageTargets(validatedConfig, configuredProviderNames, configuredProvidersByName),
  validatedConfig, configuredProviderNames, configuredProvidersByName
);

const buildAiApiKeys = (providers: NormalizedAiProviderConfig[]) => ({
  anthropicApiKey: getProviderConfig(providers, 'anthropic')?.apiKey,
  openaiApiKey: getProviderConfig(providers, 'openai')?.apiKey,
  geminiApiKey: getProviderConfig(providers, 'google')?.apiKey,
  deepseekApiKey: getProviderConfig(providers, 'deepseek')?.apiKey,
});

const buildAiSection = (
  providers: NormalizedAiProviderConfig[],
  activeProvider: NormalizedAiProviderConfig,
  aiStages: Partial<Record<SupportedModelStageName, NormalizedAiStageTargetConfig>>
): NormalizedWfConfig['ai'] => ({
  provider: activeProvider.provider,
  providers,
  apiKey: activeProvider.apiKey,
  ...buildAiApiKeys(providers),
  model: activeProvider.model,
  maxTokens: activeProvider.maxTokens,
  stages: aiStages,
});

const buildStageSection = (
  aiStages: Partial<Record<SupportedModelStageName, NormalizedAiStageTargetConfig>>,
  normalizedPlanStage: NormalizedPlanStageConfig | undefined,
  normalizedImplementStage: NormalizedImplementStageConfig | undefined,
  normalizedCreateStage: NormalizedCreateStageConfig | undefined,
  normalizedReviewStage: NormalizedReviewStageConfig | undefined
): NormalizedWfConfig['stages'] => ({
  plan: normalizedPlanStage,
  implement: normalizedImplementStage,
  create: normalizedCreateStage,
  review: normalizedReviewStage,
  generate: aiStages.generate,
  commit: aiStages.commit,
});

const buildOutputConfigSection = (validatedConfig: WfConfig, jiraApiToken: string | undefined, aiSection: NormalizedWfConfig['ai'], stageSection: NormalizedWfConfig['stages'], loggingSource: LoggingSourceConfig): Omit<NormalizedWfConfig, 'tracker'> => ({
  ai: aiSection,
  stages: stageSection,
  atlassian: buildAtlassianConfig(validatedConfig, jiraApiToken),
  github: buildGitHubConfig(validatedConfig),
  git: buildGitConfig(validatedConfig),
  state: buildStateConfig(validatedConfig),
  logging: buildLoggingConfig(loggingSource),
  log: buildLoggingConfig(loggingSource),
  slack: buildSlackConfig(validatedConfig),
  figma: buildFigmaConfig(validatedConfig),
});

const buildGitHubConfig = (validatedConfig: WfConfig) => ({
  token: validatedConfig.github?.token,
  defaultRepo: validatedConfig.github?.defaultRepo,
});

const buildStateConfig = (validatedConfig: WfConfig) => ({
  directory: validatedConfig.state?.directory,
});

const buildSlackConfig = (validatedConfig: WfConfig) => ({
  botToken: validatedConfig.slack?.botToken,
  userToken: validatedConfig.slack?.userToken,
});

const buildFigmaConfig = (validatedConfig: WfConfig) => ({
  token: validatedConfig.figma?.token,
});

const buildNormalizedProviderContext = (
  validatedConfig: WfConfig
): {
  providers: NormalizedAiProviderConfig[];
  activeProvider: NormalizedAiProviderConfig;
} => {
  const inputProviders = getInputProviders(validatedConfig);
  const providers = inputProviders.map(normalizeProvider);
  const defaultProviders = getDefaultProviders(providers);
  assertProviderDefaultRules(providers, defaultProviders);
  return { providers, activeProvider: selectActiveProvider(providers, defaultProviders) };
};

type BuildNormalizedWfConfigInput = {
  validatedConfig: WfConfig;
  providers: NormalizedAiProviderConfig[];
  activeProvider: NormalizedAiProviderConfig;
  aiStages: Partial<Record<SupportedModelStageName, NormalizedAiStageTargetConfig>>;
  normalizedPlanStage: NormalizedPlanStageConfig | undefined;
  normalizedImplementStage: NormalizedImplementStageConfig | undefined;
  normalizedCreateStage: NormalizedCreateStageConfig | undefined;
  normalizedReviewStage: NormalizedReviewStageConfig | undefined;
  loggingSource: LoggingSourceConfig;
};

const buildNormalizedWfConfig = (input: BuildNormalizedWfConfigInput): NormalizedWfConfig => ({
  tracker: input.validatedConfig.tracker ?? 'jira',
  ...buildOutputConfigSection(
    input.validatedConfig,
    input.validatedConfig.atlassian?.jira?.apiToken ?? input.validatedConfig.atlassian?.apiToken,
    buildAiSection(input.providers, input.activeProvider, input.aiStages),
    buildStageSection(
      input.aiStages, input.normalizedPlanStage, input.normalizedImplementStage,
      input.normalizedCreateStage, input.normalizedReviewStage
    ),
    input.loggingSource
  ),
});

const getValidationFieldNames = (issues: z.core.$ZodIssue[]): string[] => issues.flatMap(issue =>
  issue.code === 'unrecognized_keys'
    ? issue.keys.map(key => [...issue.path, key].join('.'))
    : [issue.path.join('.')]
);

/**
 * Normalize user config into the runtime shape consumed by Nest ConfigService.
 *
 * @param rawConfig - Consumer-authored config object
 * @returns Normalized config with defaults applied
 */
export const normalizeWfConfig = (rawConfig: WfConfig = {}): NormalizedWfConfig => {
  const result = wfConfigSchema.safeParse(rawConfig);
  if (!result.success) {
    const fieldNames = getValidationFieldNames(result.error.issues);
    throw new ValidationError(
      `Invalid wf config: validation failed for: ${formatFieldNames(fieldNames)}`,
      result.error
    );
  }

  return normalizeValidatedWfConfig(result.data);
};

const intentionalStageFieldDrops = new Set(['implement.model']);

/**
 * Diff validated stage configs against their normalized counterparts. The normalizers rebuild
 * each stage from an explicit field list, so a field declared in the raw schema but not copied
 * there vanishes silently — this surfaces that drift instead of letting it pass unnoticed.
 *
 * @param rawStages - Stage configs as validated from the user's config file
 * @param normalizedStages - Stage configs after normalization
 * @returns Dotted stage.field paths that were accepted by validation but dropped
 */
export const collectDroppedStageFields = (
  rawStages: Record<string, Record<string, unknown> | undefined>,
  normalizedStages: Record<string, object | undefined>,
): string[] =>
  Object.entries(rawStages).flatMap(([stageName, rawStage]) => {
    if (!rawStage) return [];
    const normalizedStage = normalizedStages[stageName];
    return Object.keys(rawStage)
      .filter(key => rawStage[key] !== undefined)
      .filter(key => !normalizedStage || !(key in normalizedStage))
      .map(key => `${stageName}.${key}`)
      .filter(fieldPath => !intentionalStageFieldDrops.has(fieldPath));
  });

const warnDroppedStageFields = (droppedFields: string[]): void => {
  if (droppedFields.length === 0) return;
  const fieldList = droppedFields.map(field => `stages.${field}`).join(', ');
  console.warn(`⚠ wf config: ${fieldList} passed validation but was not carried into the runtime config and will be ignored`);
  appendToLogFile('WARN', `config.normalize dropped-fields ${fieldList}`, 'wf-config');
};

const auditDroppedStageFields = (validatedConfig: WfConfig, normalized: NormalizedWfConfig): NormalizedWfConfig => {
  warnDroppedStageFields(collectDroppedStageFields(
    (validatedConfig.stages ?? {}) as Record<string, Record<string, unknown> | undefined>,
    normalized.stages as Record<string, object | undefined>,
  ));
  return normalized;
};

const normalizeValidatedWfConfig = (validatedConfig: WfConfig): NormalizedWfConfig => {
  const { providers, activeProvider } = buildNormalizedProviderContext(validatedConfig);
  if (hasFetchStageOverride(validatedConfig)) throw new ValidationError('Invalid wf config: fetch stage cannot be overridden in stages.');
  const { configuredProviderNames, configuredProvidersByName } = buildConfiguredProviderLookup(providers);
  return auditDroppedStageFields(validatedConfig, buildNormalizedWfConfig({
    validatedConfig,
    providers,
    activeProvider,
    loggingSource: validatedConfig.logging ?? validatedConfig.log ?? {},
    ...buildNormalizedStages(validatedConfig, configuredProviderNames, configuredProvidersByName),
  }));
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

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const mergeConfigKeyInPlace = (target: Record<string, unknown>, key: string, value: unknown): void => {
  const current = target[key];
  if (!isPlainObject(current) || !isPlainObject(value)) {
    target[key] = value;
    return;
  }
  for (const k of Object.keys(current)) delete current[k];
  Object.assign(current, value);
};

const mergeConfigInPlace = (target: NormalizedWfConfig, fresh: NormalizedWfConfig): NormalizedWfConfig => {
  const t = target as unknown as Record<string, unknown>;
  const f = fresh as unknown as Record<string, unknown>;
  for (const key of Object.keys(fresh)) mergeConfigKeyInPlace(t, key, f[key]);
  return target;
};

/**
 * Loads and normalizes the wf config rooted at `cwd`, then merges it into the
 * module-level `loadedConfig` in place so that existing `ConfigService` references
 * remain valid across multi-repo runs.
 *
 * @param cwd - Directory to search for `wf.config.*`. Defaults to `process.cwd()`.
 * @returns The same `loadedConfig` object on every call after the first — the reference never changes.
 */
export const initializeWfConfig = async (cwd: string = process.cwd()): Promise<NormalizedWfConfig> => {
  const fresh = await loadWfConfig({ cwd });
  loadedConfig = loadedConfig ? mergeConfigInPlace(loadedConfig, fresh) : fresh;
  setWfPathOverrides({ logDir: loadedConfig.log.directory, stateDir: loadedConfig.state.directory });
  return loadedConfig;
};

/**
 * Return the preloaded config, loading defaults on first access if needed.
 *
 * @returns Normalized config object
 */
export const getLoadedWfConfig = (): NormalizedWfConfig => {
  loadedConfig ||= normalizeWfConfig({});

  return loadedConfig;
};
