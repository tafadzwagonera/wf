import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { CliPresenter } from '../../src/shared/presentation/cli-presenter.service';
import { PresentationModule } from '../../src/shared/presentation/presentation.module';
import { LoggerModule } from '../../src/shared/logger/logger.module';
import { LoggerService } from '../../src/shared/logger/logger.service';

interface ConsoleCapture {
  stdout: string[];
  stderr: string[];
  debug: string[];
  restore: () => void;
}

const captureConsole = (): ConsoleCapture => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const debug: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalDebug = console.debug;

  console.log = (...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  };
  console.debug = (...args: unknown[]) => {
    debug.push(args.map(String).join(' '));
  };

  return {
    stdout,
    stderr,
    debug,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
      console.debug = originalDebug;
    },
  };
};

const buildServices = async (level: 'debug' | 'error'): Promise<{
  presenter: CliPresenter;
  logger: LoggerService;
  close: () => Promise<void>;
}> => {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({ logging: { level } })],
      }),
      LoggerModule,
      PresentationModule,
    ],
  }).compile();

  return {
    presenter: module.get(CliPresenter),
    logger: module.get(LoggerService),
    close: () => module.close(),
  };
};

async function main(): Promise<void> {
  const errorCapture = captureConsole();
  const errorServices = await buildServices('error');

  try {
    errorServices.presenter.stageHeader(2, 'Generate Implementation Plan');
    errorServices.presenter.separator();
  } finally {
    await errorServices.close();
    errorCapture.restore();
  }

  const errorOutput = errorCapture.stdout.join('\n');
  if (!errorOutput.includes('🤖 STAGE 2: Generate Implementation Plan')) {
    throw new Error('Expected presenter stage header output when log level is error.');
  }
  if (!errorOutput.includes('─'.repeat(70))) {
    throw new Error('Expected presenter separator output when log level is error.');
  }

  const debugCapture = captureConsole();
  const debugServices = await buildServices('debug');

  try {
    debugServices.presenter.progress('Presenter progress line');
    debugServices.logger.debug('Logger debug line', 'ManualSmoke');
  } finally {
    await debugServices.close();
    debugCapture.restore();
  }

  const debugStdout = debugCapture.stdout.join('\n');
  const debugConsole = debugCapture.debug.join('\n');
  if (!debugStdout.includes('Presenter progress line')) {
    throw new Error('Expected presenter progress output when log level is debug.');
  }
  if (!debugConsole.includes('Logger debug line')) {
    throw new Error('Expected logger debug output when log level is debug.');
  }

  console.log('✓ Manual smoke test passed: cli presenter and logger');
}

void main().catch(error => {
  console.error(`✗ Manual smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
