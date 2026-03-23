/**
 * Manual Test Script for Action Executors
 *
 * Run: yarn ts-node -r tsconfig-paths/register test/manual/test-executors.ts
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { BashExecutor } from '../../src/core/stage-engine/action-executors/bash-executor';
import { FileExecutor } from '../../src/core/stage-engine/action-executors/file-executor';
import { StageContext } from '../../src/common/interfaces';

async function testExecutors() {
  console.log('🧪 Testing Action Executors\n');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const context: StageContext = {
    workflowId: 'test-workflow',
    stepId: 'test-step',
    parameters: {},
    previousOutputs: {},
    environment: {},
    retryCount: 0,
  };

  try {
    // Test 1: Bash Executor
    console.log('Test 1: Bash Executor');
    const bashExecutor = app.get(BashExecutor);

    const bashResult = await bashExecutor.execute(
      {
        command: 'echo "Hello from bash executor"',
      },
      context,
    );

    console.log('✓ Bash executor result:', bashResult.status);
    console.log('  Output:', bashResult.outputs?.stdout);
    console.log('  Duration:', bashResult.duration, 'ms\n');

    // Test 2: File Executor - Write
    console.log('Test 2: File Executor - Write');
    const fileExecutor = app.get(FileExecutor);

    const writeResult = await fileExecutor.execute(
      {
        operation: 'write',
        filePath: '/tmp/test-windsurf-agent.txt',
        content: 'Hello from file executor!\nThis is a test file.',
      },
      context,
    );

    console.log('✓ File write result:', writeResult.status);
    console.log('  Written:', writeResult.outputs?.fileResult.written);
    console.log('  Size:', writeResult.outputs?.fileResult.size, 'bytes\n');

    // Test 3: File Executor - Read
    console.log('Test 3: File Executor - Read');
    const readResult = await fileExecutor.execute(
      {
        operation: 'read',
        filePath: '/tmp/test-windsurf-agent.txt',
      },
      context,
    );

    console.log('✓ File read result:', readResult.status);
    console.log(
      '  Content:',
      readResult.outputs?.fileResult.substring(0, 50) + '...\n',
    );

    // Test 4: File Executor - Delete
    console.log('Test 4: File Executor - Delete');
    const deleteResult = await fileExecutor.execute(
      {
        operation: 'delete',
        filePath: '/tmp/test-windsurf-agent.txt',
      },
      context,
    );

    console.log('✓ File delete result:', deleteResult.status);
    console.log('  Deleted:', deleteResult.outputs?.fileResult.deleted, '\n');

    // Test 5: Bash Executor - Error handling
    console.log('Test 5: Bash Executor - Error Handling');
    const errorResult = await bashExecutor.execute(
      {
        command: 'exit 42',
      },
      context,
    );

    console.log('✓ Error handling result:', errorResult.status);
    console.log('  Exit code:', errorResult.outputs?.exitCode);
    console.log('  Error code:', errorResult.error?.code, '\n');

    console.log('✅ All manual executor tests completed!\n');
  } catch (error: any) {
    console.error('❌ Test failed:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
  } finally {
    await app.close();
  }
}

testExecutors();
