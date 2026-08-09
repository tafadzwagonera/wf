import { Global, Module } from '@nestjs/common';
import { CliPresenter } from './cli-presenter.service';
import { ReviewPresenter } from './review-presenter.service';

@Global()
@Module({
  providers: [CliPresenter, ReviewPresenter],
  exports: [CliPresenter, ReviewPresenter],
})
export class PresentationModule {}
