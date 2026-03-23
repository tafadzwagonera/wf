import { Module } from '@nestjs/common';
import { StateManagerService } from './state-manager.service';
import { LoggerService } from '../../shared/logger/logger.service';

@Module({
  providers: [StateManagerService, LoggerService],
  exports: [StateManagerService],
})
export class StateManagerModule {}
