import { Injectable } from '@nestjs/common';
import { BaseExecutor } from './base-executor';
import {
  StageContext,
  StageResult,
  Artifact,
} from '../../../common/interfaces';
import {
  GitService,
  CommitOptions,
} from '../../../integrations/git/git.service';
import { LoggerService } from '../../../shared/logger/logger.service';

export interface GitActionConfig {
  operation:
    | 'status'
    | 'branch'
    | 'commit'
    | 'diff'
    | 'stash'
    | 'push'
    | 'pull';
  branchName?: string;
  baseBranch?: string;
  commitOptions?: CommitOptions;
  remote?: string;
  stashMessage?: string;
}

@Injectable()
export class GitExecutor extends BaseExecutor {
  constructor(
    private gitService: GitService,
    private logger: LoggerService,
  ) {
    super();
  }

  async execute(
    action: GitActionConfig,
    context: StageContext,
  ): Promise<Partial<StageResult>> {
    void context;
    const { operation } = action;

    this.logger.debug(`Executing Git action: ${operation}`);

    try {
      const startTime = Date.now();
      let result: any;
      const artifacts: Artifact[] = [];

      switch (operation) {
        case 'status':
          result = await this.gitService.getStatus();
          artifacts.push({
            type: 'json',
            name: 'Git Status',
            content: JSON.stringify(result, null, 2),
          });
          break;

        case 'branch':
          if (!action.branchName) {
            // Get branch info if no branch name provided
            result = await this.gitService.getBranchInfo();
          } else {
            // Create new branch
            await this.gitService.createBranch(
              action.branchName,
              action.baseBranch,
            );
            result = { branchName: action.branchName, created: true };
          }
          break;

        case 'commit':
          if (!action.commitOptions) {
            throw new Error('Commit operation requires commitOptions');
          }
          result = await this.gitService.commit(action.commitOptions);
          artifacts.push({
            type: 'text',
            name: 'Commit Hash',
            content: result,
          });
          break;

        case 'diff':
          result = await this.gitService.getDiff(false);
          artifacts.push({
            type: 'text',
            name: 'Git Diff',
            content: result,
          });
          break;

        case 'stash':
          await this.gitService.stashChanges(action.stashMessage);
          result = { stashed: true };
          break;

        case 'push':
          await this.gitService.push(action.remote, undefined, true);
          result = { pushed: true, remote: action.remote || 'origin' };
          break;

        case 'pull':
          await this.gitService.pull(action.remote);
          result = { pulled: true, remote: action.remote || 'origin' };
          break;

        default:
          throw new Error(`Unknown Git operation: ${operation}`);
      }

      const duration = Date.now() - startTime;

      this.logger.success(`Git ${operation} completed in ${duration}ms`);

      return {
        ...this.createSuccessResult({ gitResult: result }),
        artifacts,
        duration,
      };
    } catch (error: any) {
      this.logger.error(`Git action failed: ${error.message}`);
      return this.createFailureResult(error, 'GIT_EXECUTION_ERROR');
    }
  }
}
