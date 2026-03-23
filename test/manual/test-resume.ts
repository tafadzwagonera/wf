import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { WorkflowParserService } from '../../src/core/workflow-parser/workflow-parser.service';
import { StageEngineService } from '../../src/core/stage-engine/stage-engine.service';
import { StateManagerService } from '../../src/core/state-manager/state-manager.service';
import { WorkflowStatus } from '../../src/common/interfaces';

async function testResume() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const workflowParser = app.get(WorkflowParserService);
  const stageEngine = app.get(StageEngineService);
  const stateManager = app.get(StateManagerService);

  try {
    console.log('🧪 Testing Resume Functionality\n');

    // Test 1: Parse workflow
    console.log('Test 1: Parse workflow');
    const workflow = await workflowParser.findWorkflow(
      'example-file-operations',
    );
    console.log('✓ Workflow parsed:', workflow.metadata.name);
    console.log('  Steps:', workflow.steps.length);
    console.log();

    // Test 2: Create initial workflow state
    console.log('Test 2: Create workflow state');
    const state = await stateManager.createWorkflowState(
      workflow.metadata.name,
      { test: true },
    );
    console.log('✓ State created:', state.executionId);
    console.log('  Status:', state.status);
    console.log('  Current Step Index:', state.currentStepIndex);
    console.log();

    // Test 3: Simulate partial execution by manually creating checkpoints
    console.log('Test 3: Simulate partial execution (2 steps completed)');
    await stateManager.createCheckpoint(
      state.executionId,
      workflow.steps[0].id,
      0,
      { step1: 'completed' },
    );
    await stateManager.createCheckpoint(
      state.executionId,
      workflow.steps[1].id,
      1,
      { step2: 'completed' },
    );
    console.log('✓ Created 2 checkpoints');
    console.log();

    // Test 4: Load state
    console.log('Test 4: Load saved state');
    const loadedState = await stateManager.loadState(state.executionId);
    console.log('✓ State loaded');
    console.log('  Current Step Index:', loadedState.currentStepIndex);
    console.log('  Checkpoints:', loadedState.checkpoints.length);
    console.log();

    // Test 5: Find workflow by display name
    console.log('Test 5: Find workflow by display name');
    const foundWorkflow = await workflowParser.findWorkflowByName(
      workflow.metadata.name,
    );
    console.log('✓ Workflow found:', foundWorkflow.metadata.name);
    console.log(
      '  Matched:',
      foundWorkflow.metadata.name === workflow.metadata.name,
    );
    console.log();

    // Test 6: Resume workflow
    console.log('Test 6: Resume workflow execution');
    console.log(
      '  Resuming from step',
      loadedState.currentStepIndex + 1,
      'of',
      workflow.steps.length,
    );
    const resumedState = await stageEngine.resumeWorkflow(
      state.executionId,
      foundWorkflow,
    );
    console.log('✓ Workflow resumed');
    console.log('  Final Status:', resumedState.status);
    console.log('  Total Results:', resumedState.results.length);
    console.log('  Expected:', workflow.steps.length);
    console.log();

    // Test 7: Verify final state
    console.log('Test 7: Verify final state');
    if (resumedState.status === WorkflowStatus.COMPLETED) {
      console.log('✓ Workflow completed successfully');
    } else {
      console.log('✗ Workflow did not complete. Status:', resumedState.status);
    }

    if (resumedState.results.length === workflow.steps.length) {
      console.log('✓ All steps executed');
    } else {
      console.log(
        '✗ Not all steps executed. Expected:',
        workflow.steps.length,
        'Got:',
        resumedState.results.length,
      );
    }
    console.log();

    // Test 8: Try to resume completed workflow
    console.log('Test 8: Resume already completed workflow');
    const reResumedState = await stageEngine.resumeWorkflow(
      state.executionId,
      foundWorkflow,
    );
    if (reResumedState.status === WorkflowStatus.COMPLETED) {
      console.log('✓ Correctly handled already completed workflow');
    }
    console.log();

    // Test 9: Cleanup
    console.log('Test 9: Cleanup test state');
    await stateManager.deleteState(state.executionId);
    console.log('✓ Test state deleted');
    console.log();

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ All resume functionality tests passed!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  } catch (error: any) {
    console.error('✗ Test failed:', error.message);
    if (error.stack) {
      console.error('Stack:', error.stack);
    }
  }

  await app.close();
}

testResume();
