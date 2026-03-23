import { Module } from '@nestjs/common';
import { GitService } from './git.service';
import { LoggerService } from '../../shared/logger/logger.service';

@Module({
  providers: [GitService, LoggerService],
  exports: [GitService],
})
export class GitModule {}
