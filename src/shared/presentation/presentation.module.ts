import { Global, Module } from '@nestjs/common';
import { CliPresenter } from './cli-presenter.service';

@Global()
@Module({
  providers: [CliPresenter],
  exports: [CliPresenter],
})
export class PresentationModule {}
