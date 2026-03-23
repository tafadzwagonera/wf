import { Test, TestingModule } from '@nestjs/testing';
import { BashExecutor } from './bash-executor';
import { LoggerService } from '../../../shared/logger/logger.service';
import { StageStatus } from '../../../common/interfaces';

describe('BashExecutor', () => {
  let executor: BashExecutor;
  let loggerService: LoggerService;

  const mockLoggerService = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BashExecutor,
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).compile();

    executor = module.get<BashExecutor>(BashExecutor);
    loggerService = module.get<LoggerService>(LoggerService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('execute', () => {
    it('should execute a simple command successfully', async () => {
      const action = {
        command: 'echo "Hello World"',
      };

      const context: any = {
        workflowId: 'test-workflow',
        stepId: 'test-step',
        parameters: {},
        previousOutputs: {},
        environment: {},
        retryCount: 0,
      };

      const result = await executor.execute(action, context);

      expect(result.status).toBe(StageStatus.SUCCESS);
      expect(result.outputs?.stdout).toBe('Hello World');
      expect(result.outputs?.exitCode).toBe(0);
      expect(result.duration).toBeGreaterThan(0);
    });

    it('should capture stderr when present', async () => {
      const action = {
        command: 'node -e "console.error(\'error message\')"',
      };

      const context: any = {
        workflowId: 'test-workflow',
        stepId: 'test-step',
        parameters: {},
        previousOutputs: {},
        environment: {},
        retryCount: 0,
      };

      const result = await executor.execute(action, context);

      expect(result.status).toBe(StageStatus.SUCCESS);
      expect(result.outputs?.stderr).toContain('error message');
    });

    it('should handle command failure', async () => {
      const action = {
        command: 'exit 1',
      };

      const context: any = {
        workflowId: 'test-workflow',
        stepId: 'test-step',
        parameters: {},
        previousOutputs: {},
        environment: {},
        retryCount: 0,
      };

      const result = await executor.execute(action, context);

      expect(result.status).toBe(StageStatus.FAILURE);
      expect(result.outputs?.exitCode).toBe(1);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('BASH_EXECUTION_ERROR');
    });

    it('should respect timeout setting', async () => {
      const action = {
        command: 'sleep 10',
        timeout: 100, // 100ms timeout
      };

      const context: any = {
        workflowId: 'test-workflow',
        stepId: 'test-step',
        parameters: {},
        previousOutputs: {},
        environment: {},
        retryCount: 0,
      };

      const result = await executor.execute(action, context);

      expect(result.status).toBe(StageStatus.FAILURE);
      expect(result.error).toBeDefined();
    }, 10000);

    it('should use custom working directory', async () => {
      const action = {
        command: 'pwd',
        cwd: '/tmp',
      };

      const context: any = {
        workflowId: 'test-workflow',
        stepId: 'test-step',
        parameters: {},
        previousOutputs: {},
        environment: {},
        retryCount: 0,
      };

      const result = await executor.execute(action, context);

      expect(result.status).toBe(StageStatus.SUCCESS);
      expect(result.outputs?.stdout).toContain('/tmp');
    });

    it('should use custom environment variables', async () => {
      const action = {
        command: 'echo $TEST_VAR',
        env: { TEST_VAR: 'test-value' },
      };

      const context: any = {
        workflowId: 'test-workflow',
        stepId: 'test-step',
        parameters: {},
        previousOutputs: {},
        environment: {},
        retryCount: 0,
      };

      const result = await executor.execute(action, context);

      expect(result.status).toBe(StageStatus.SUCCESS);
      expect(result.outputs?.stdout).toBe('test-value');
    });

    it('should not capture output when captureOutput is false', async () => {
      const action = {
        command: 'echo "Hello World"',
        captureOutput: false,
      };

      const context: any = {
        workflowId: 'test-workflow',
        stepId: 'test-step',
        parameters: {},
        previousOutputs: {},
        environment: {},
        retryCount: 0,
      };

      const result = await executor.execute(action, context);

      expect(result.status).toBe(StageStatus.SUCCESS);
      expect(result.outputs?.stdout).toBeUndefined();
    });

    it('should create artifacts from command output', async () => {
      const action = {
        command: 'echo "Artifact content"',
      };

      const context: any = {
        workflowId: 'test-workflow',
        stepId: 'test-step',
        parameters: {},
        previousOutputs: {},
        environment: {},
        retryCount: 0,
      };

      const result = await executor.execute(action, context);

      expect(result.status).toBe(StageStatus.SUCCESS);
      expect(result.artifacts).toBeDefined();
      expect(result.artifacts?.length).toBeGreaterThan(0);
      expect(result.artifacts?.[0].type).toBe('text');
      expect(result.artifacts?.[0].name).toBe('Command Output');
    });
  });
});
