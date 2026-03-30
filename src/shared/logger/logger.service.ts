import { Injectable, LoggerService as NestLoggerService } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { getWfLogDir } from '../utils/wf-paths';

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

@Injectable()
export class LoggerService implements NestLoggerService {
  private logLevel: LogLevel;
  private logDirectory: string;
  private logFile: string;

  constructor(private configService: ConfigService) {
    const levelStr = this.configService.get<string>('logging.level', 'info');
    this.logLevel = this.parseLogLevel(levelStr);
    this.logDirectory = this.configService.get<string>(
      'logging.directory',
      getWfLogDir(),
    );
    this.ensureLogDirectory();
    this.logFile = path.join(
      this.logDirectory,
      `agent-${new Date().toISOString().split('T')[0]}.log`,
    );
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

  private ensureLogDirectory(): void {
    if (!fs.existsSync(this.logDirectory)) {
      fs.mkdirSync(this.logDirectory, { recursive: true });
    }
  }

  private writeToFile(level: string, message: string, context?: string): void {
    const timestamp = new Date().toISOString();
    const contextStr = context ? `[${context}] ` : '';
    const logLine = `${timestamp} [${level}] ${contextStr}${message}\n`;

    try {
      fs.appendFileSync(this.logFile, logLine);
    } catch (error) {
      // Silently fail if unable to write to log file
    }
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
      this.writeToFile(
        'ERROR',
        `${String(message)}${trace ? `\n${trace}` : ''}`,
        context,
      );
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
