import { Injectable } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import { BaseExecutor } from './base-executor';
import {
  StageContext,
  StageResult,
  Artifact,
} from '../../../common/interfaces';
import { LoggerService } from '../../../shared/logger/logger.service';

const execAsync = promisify(exec);

export interface BashActionConfig {
  command: string;
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
  captureOutput?: boolean;
}

@Injectable()
export class BashExecutor extends BaseExecutor {
  constructor(private logger: LoggerService) {
    super();
  }

  async execute(
    action: BashActionConfig,
    context: StageContext,
  ): Promise<Partial<StageResult>> {
    void context;
    const { command, cwd, timeout = 30000, env, captureOutput = true } = action;

    this.logger.debug(`Executing bash command: ${command}`);

    try {
      const startTime = Date.now();

      const { stdout, stderr } = await execAsync(command, {
        cwd: cwd || process.cwd(),
        timeout,
        env: { ...process.env, ...env },
        maxBuffer: 1024 * 1024 * 10, // 10MB
      });

      const duration = Date.now() - startTime;

      const outputs: Record<string, any> = {
        exitCode: 0,
        duration,
      };

      if (captureOutput) {
        outputs.stdout = stdout.trim();
        if (stderr) {
          outputs.stderr = stderr.trim();
        }
      }

      const artifacts: Artifact[] = [];

      if (stdout && captureOutput) {
        artifacts.push({
          type: 'text',
          name: 'Command Output',
          content: stdout.trim(),
        });
      }

      this.logger.success(`Command completed in ${duration}ms`);

      return {
        ...this.createSuccessResult(outputs),
        artifacts,
        duration,
      };
    } catch (error: any) {
      this.logger.error(`Bash command failed: ${error.message}`);

      const outputs: Record<string, any> = {
        exitCode: error.code || 1,
        stderr: error.stderr?.trim() || error.message,
      };

      if (error.stdout) {
        outputs.stdout = error.stdout.trim();
      }

      return {
        ...this.createFailureResult(error, 'BASH_EXECUTION_ERROR'),
        outputs,
      };
    }
  }
}
