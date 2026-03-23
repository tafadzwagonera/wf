import { Module } from '@nestjs/common';
import { ApprovalSystemService } from './approval-system.service';
import { LoggerService } from '../../shared/logger/logger.service';

@Module({
  providers: [ApprovalSystemService, LoggerService],
  exports: [ApprovalSystemService],
})
export class ApprovalSystemModule {}
