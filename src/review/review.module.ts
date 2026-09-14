import { Module } from '@nestjs/common';
import { GitModule } from '../integrations/git/git.module';
import { SessionModule } from '../shared/session/session.module';
import { FigmaRestClient } from '../integrations/figma/figma-rest.client';
import { FigmaStageService } from './figma-stage.service';
import { SonarStageService } from './sonar-stage.service';
import { UiDesignScreenshotsStageService } from './ui-design-screenshots-stage.service';

@Module({
  imports: [GitModule, SessionModule],
  providers: [FigmaRestClient, FigmaStageService, SonarStageService, UiDesignScreenshotsStageService],
  exports: [FigmaStageService, SonarStageService, UiDesignScreenshotsStageService],
})
export class ReviewModule {}
