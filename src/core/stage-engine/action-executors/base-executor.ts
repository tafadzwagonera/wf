import {
  StageContext,
  StageResult,
  StageStatus,
} from '../../../common/interfaces';

export interface ActionExecutor {
  execute(action: any, context: StageContext): Promise<Partial<StageResult>>;
}

export abstract class BaseExecutor implements ActionExecutor {
  abstract execute(
    action: any,
    context: StageContext,
  ): Promise<Partial<StageResult>>;

  protected createSuccessResult(
    outputs: Record<string, any>,
  ): Partial<StageResult> {
    return {
      status: StageStatus.SUCCESS,
      outputs,
      completedAt: new Date(),
    };
  }

  protected createFailureResult(
    error: Error,
    code: string = 'EXECUTION_ERROR',
  ): Partial<StageResult> {
    return {
      status: StageStatus.FAILURE,
      outputs: {},
      error: {
        code,
        message: error.message,
        details: error,
        recoverable: true,
      },
      completedAt: new Date(),
    };
  }
}
