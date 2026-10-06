import { createRequire } from 'node:module';

const SKIP_CONFIG_BOOTSTRAP_ENV = 'WF_SKIP_CONFIG_BOOTSTRAP';
const moduleRequire = createRequire(__filename);

/**
 * Load the normalized CLI config when bootstrap has preloaded it.
 *
 * @returns The preloaded config, or an empty object for help-only bootstrap
 */
export default () => {
  if (process.env[SKIP_CONFIG_BOOTSTRAP_ENV] === 'true') {
    return {};
  }

  const { getLoadedWfConfig } = moduleRequire('./wf-config-loader');
  return getLoadedWfConfig();
};
