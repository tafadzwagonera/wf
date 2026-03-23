import { Module } from '@nestjs/common';
import { WorkflowParserService } from './workflow-parser.service';
import { LoggerService } from '../../shared/logger/logger.service';

@Module({
  providers: [WorkflowParserService, LoggerService],
  exports: [WorkflowParserService],
})
export class WorkflowParserModule {}
