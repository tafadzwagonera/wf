import { Injectable, LoggerService as NestLoggerService } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import chalk from 'chalk';
import { appendToLogFile } from './log-file-writer';

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

@Injectable()
export class LoggerService implements NestLoggerService {
  private logLevel: LogLevel;

  constructor(private configService: ConfigService) {
    const levelStr = this.configService.get<string>('logging.level', 'info');
    this.logLevel = this.parseLogLevel(levelStr);
  }

  private parseLogLevel(level: string): LogLevel {
    const levels: Record<string, LogLevel> = {
      error: LogLevel.ERROR,
      warn: LogLevel.WARN,
      info: LogLevel.INFO,
      debug: LogLevel.DEBUG,
    };
    return levels[level.toLowerCase()] ?? LogLevel.INFO;
  }

  private writeToFile(level: string, message: string, context?: string): void {
    appendToLogFile(level, message, context);
  }

  log(message: any, context?: string) {
    if (this.logLevel >= LogLevel.INFO) {
      console.log(chalk.white(message));
      this.writeToFile('INFO', String(message), context);
    }
  }

  error(message: any, trace?: string, context?: string) {
    if (this.logLevel >= LogLevel.ERROR) {
      console.error(chalk.red(message));
      if (trace) {
        console.error(chalk.gray(trace));
      }
      this.writeToFile('ERROR', `${String(message)}${trace ? `\n${trace}` : ''}`, context);
    }
  }

  warn(message: any, context?: string) {
    if (this.logLevel >= LogLevel.WARN) {
      console.warn(chalk.yellow(message));
      this.writeToFile('WARN', String(message), context);
    }
  }

  debug(message: any, context?: string) {
    if (this.logLevel >= LogLevel.DEBUG) {
      console.debug(chalk.gray(message));
      this.writeToFile('DEBUG', String(message), context);
    }
  }

  verbose(message: any, context?: string) {
    this.debug(message, context);
  }

  success(message: string, context?: string) {
    if (this.logLevel >= LogLevel.INFO) {
      console.log(chalk.green(`✓ ${message}`));
      this.writeToFile('INFO', `✓ ${message}`, context);
    }
  }

  info(message: string, context?: string) {
    if (this.logLevel >= LogLevel.INFO) {
      console.log(chalk.blue(`ℹ ${message}`));
      this.writeToFile('INFO', message, context);
    }
  }
}
