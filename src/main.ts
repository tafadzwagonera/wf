#!/usr/bin/env node
import { CommandFactory } from 'nest-commander';
import { AppModule } from './app.module';
import { initializeWfConfig } from './config/wf-config-loader';
import { resolveConfigCwd } from './bootstrap/resolve-config-cwd';

async function bootstrap() {
  await initializeWfConfig(resolveConfigCwd(process.argv.slice(2)));
  await CommandFactory.run(AppModule, ['warn', 'error']);
}
bootstrap();
