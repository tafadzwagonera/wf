#!/usr/bin/env node
import { createRequire } from 'module';
import { CommandFactory } from 'nest-commander';
import { resolveConfigCwd } from './bootstrap/resolve-config-cwd';
import { isHelpInvocation } from './bootstrap/is-help-invocation';
import { getHelpText } from './bootstrap/help-output';

const moduleRequire = createRequire(__filename);

/**
 * Start the CLI, loading config only for non-help invocations.
 *
 * @returns Resolves when the CLI command exits
 */
export async function bootstrap(): Promise<void> {
  const argv = process.argv.slice(2);
  const shouldSkipConfigBootstrap = isHelpInvocation(argv);

  if (shouldSkipConfigBootstrap) {
    console.log(getHelpText(argv));
    return;
  }

  const { initializeWfConfig } = moduleRequire('./config/wf-config-loader');
  await initializeWfConfig(resolveConfigCwd(argv));

  const { AppModule } = moduleRequire('./app.module');
  await CommandFactory.run(AppModule, ['warn', 'error']);
}

/**
 * Exit the CLI with a non-zero status when bootstrap fails before command handlers run.
 *
 * @param error - The startup error that rejected bootstrap
 * @returns Never returns because the process exits
 */
const handleBootstrapError = (error: unknown): never => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
};

void bootstrap().catch(handleBootstrapError);
