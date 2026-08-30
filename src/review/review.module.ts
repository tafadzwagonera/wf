import { Module } from '@nestjs/common';
import { GitModule } from '../integrations/git/git.module';
import { SessionModule } from '../shared/session/session.module';
import { FigmaStageService } from './figma-stage.service';
import { SonarStageService } from './sonar-stage.service';

@Module({
  imports: [GitModule, SessionModule],
  providers: [FigmaStageService, SonarStageService],
  exports: [FigmaStageService, SonarStageService],
})
export class ReviewModule {}
