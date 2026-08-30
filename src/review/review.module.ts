import { Module } from '@nestjs/common';
import { GitModule } from '../integrations/git/git.module';
import { SessionModule } from '../shared/session/session.module';
import { SonarStageService } from './sonar-stage.service';

@Module({
  imports: [GitModule, SessionModule],
  providers: [SonarStageService],
  exports: [SonarStageService],
})
export class ReviewModule {}
