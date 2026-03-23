import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { JiraService } from './jira.service';
import { LoggerService } from '../../shared/logger/logger.service';
import { PlatformConfigService } from '../platforms/platform-config.service';

@Module({
  imports: [HttpModule, ConfigModule],
  providers: [JiraService, LoggerService, PlatformConfigService],
  exports: [JiraService],
})
export class JiraModule {}
