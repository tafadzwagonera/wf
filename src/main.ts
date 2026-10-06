#!/usr/bin/env node
import { createRequire } from 'node:module';
import { CommandFactory } from 'nest-commander';
import { resolveConfigCwd } from './bootstrap/resolve-config-cwd';
import { isHelpInvocation } from './bootstrap/is-help-invocation';
import { getHelpText } from './bootstrap/help-output';

const moduleRequire = createRequire(__filename);

function registerSigintHandler(): void {
  let received = false;
  process.on('SIGINT', () => {
    if (received) process.exit(130);
    received = true;
  });
}

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
  registerSigintHandler();
  await CommandFactory.run(AppModule, ['warn', 'error']);
  process.exit(0);
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
