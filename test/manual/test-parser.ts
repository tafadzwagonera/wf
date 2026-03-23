import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { WorkflowParserService } from '../../src/core/workflow-parser/workflow-parser.service';

async function testParser() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  const parser = app.get(WorkflowParserService);

  try {
    console.log('Attempting to parse example-git-commit...');
    const workflow = await parser.findWorkflow('example-git-commit');
    console.log('Success!');
    console.log('Name:', workflow.metadata.name);
    console.log('Steps:', workflow.steps.length);
  } catch (error: any) {
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
  }

  await app.close();
}

testParser();
