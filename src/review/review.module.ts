import { Module } from '@nestjs/common';
import { GitModule } from '../integrations/git/git.module';
import { SessionModule } from '../common/session/session.module';
import { FigmaRestClient } from '../integrations/figma/figma-rest.client';
import { FigmaStageService } from './figma-stage.service';
import { SonarStageService } from './sonar-stage.service';
import { UiDesignScreenshotsStageService } from './ui-design-screenshots-stage.service';
import { CommentPolicyStageService } from './comment-policy-stage.service';

@Module({
  imports: [GitModule, SessionModule],
  providers: [
    FigmaRestClient, FigmaStageService, SonarStageService, UiDesignScreenshotsStageService, CommentPolicyStageService,
  ],
  exports: [FigmaStageService, SonarStageService, UiDesignScreenshotsStageService, CommentPolicyStageService],
})
export class ReviewModule {}
