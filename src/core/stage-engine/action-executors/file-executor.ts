import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { BaseExecutor } from './base-executor';
import {
  StageContext,
  StageResult,
  Artifact,
} from '../../../common/interfaces';
import { FileSystemError } from '../../../shared/utils/errors';
import { LoggerService } from '../../../shared/logger/logger.service';

const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);
const appendFileAsync = promisify(fs.appendFile);
const unlinkAsync = promisify(fs.unlink);
const mkdirAsync = promisify(fs.mkdir);

export interface FileActionConfig {
  operation: 'read' | 'write' | 'append' | 'delete' | 'mkdir' | 'exists';
  filePath: string;
  content?: string;
  encoding?: BufferEncoding;
  recursive?: boolean;
}

@Injectable()
export class FileExecutor extends BaseExecutor {
  constructor(private logger: LoggerService) {
    super();
  }

  async execute(
    action: FileActionConfig,
    context: StageContext,
  ): Promise<Partial<StageResult>> {
    void context;
    const {
      operation,
      filePath,
      content,
      encoding = 'utf-8',
      recursive = false,
    } = action;

    this.logger.debug(`Executing File action: ${operation} on ${filePath}`);

    try {
      const startTime = Date.now();
      let result: any;
      const artifacts: Artifact[] = [];

      switch (operation) {
        case 'read':
          result = await readFileAsync(filePath, encoding);
          artifacts.push({
            type: 'text',
            name: path.basename(filePath),
            path: filePath,
            content:
              result.substring(0, 1000) + (result.length > 1000 ? '...' : ''),
          });
          break;

        case 'write':
          if (content === undefined) {
            throw new Error('Write operation requires content');
          }
          await writeFileAsync(filePath, content, encoding);
          result = { filePath, written: true, size: content.length };
          break;

        case 'append':
          if (content === undefined) {
            throw new Error('Append operation requires content');
          }
          await appendFileAsync(filePath, content, encoding);
          result = { filePath, appended: true };
          break;

        case 'delete':
          await unlinkAsync(filePath);
          result = { filePath, deleted: true };
          break;

        case 'mkdir':
          await mkdirAsync(filePath, { recursive });
          result = { filePath, created: true };
          break;

        case 'exists':
          result = { filePath, exists: fs.existsSync(filePath) };
          break;

        default:
          throw new Error(`Unknown File operation: ${operation}`);
      }

      const duration = Date.now() - startTime;

      this.logger.success(`File ${operation} completed in ${duration}ms`);

      return {
        ...this.createSuccessResult({ fileResult: result }),
        artifacts,
        duration,
      };
    } catch (error: any) {
      this.logger.error(`File action failed: ${error.message}`);
      return this.createFailureResult(
        new FileSystemError(error.message, error),
        'FILE_EXECUTION_ERROR',
      );
    }
  }
}
