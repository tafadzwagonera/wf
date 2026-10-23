export const lazyModuleKey = {
  wfConfigLoader: 'config/wf-config-loader',
  appModule: 'app.module',
  jiti: 'jiti',
} as const;

export type LazyModuleKey = (typeof lazyModuleKey)[keyof typeof lazyModuleKey];

const registeredModules = new Map<LazyModuleKey, unknown>();

export const registerLazyModule = (key: LazyModuleKey, moduleExports: unknown): void => {
  registeredModules.set(key, moduleExports);
};

export const requireLazyModule = (key: LazyModuleKey, loadFromDisk: () => unknown): any =>
  registeredModules.has(key) ? registeredModules.get(key) : loadFromDisk();
