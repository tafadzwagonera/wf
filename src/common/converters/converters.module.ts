import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FormatConverterService } from './format-converter.service';
import { JsonConverter } from './json/json-converter';
import { YamlConverter } from './yaml/yaml-converter';
import { MarkdownConverter } from './markdown/markdown-converter';

/**
 * Module for format converters
 * Registers all format converters with the FormatConverterService
 */
@Module({
  imports: [ConfigModule],
  providers: [
    FormatConverterService,
    JsonConverter,
    YamlConverter,
    MarkdownConverter,
  ],
  exports: [FormatConverterService],
})
export class ConvertersModule implements OnModuleInit {
  constructor(
    private readonly formatConverterService: FormatConverterService,
    private readonly jsonConverter: JsonConverter,
    private readonly yamlConverter: YamlConverter,
    private readonly markdownConverter: MarkdownConverter,
  ) {}

  /**
   * Register all converters when module initializes
   */
  onModuleInit() {
    this.formatConverterService.registerConverter(this.jsonConverter);
    this.formatConverterService.registerConverter(this.yamlConverter);
    this.formatConverterService.registerConverter(this.markdownConverter);
  }
}
