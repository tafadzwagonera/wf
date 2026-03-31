#!/usr/bin/env node
import { CommandFactory } from 'nest-commander';
import { AppModule } from './app.module';
import { initializeWfConfig } from './config/wf-config-loader';

async function bootstrap() {
  await initializeWfConfig();
  await CommandFactory.run(AppModule, ['warn', 'error']);
}
bootstrap();
