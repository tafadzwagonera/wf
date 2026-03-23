import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FormatConverter, TicketFormat } from './format-converter.interface';

/**
 * Factory service for managing and retrieving format converters.
 * Provides centralized access to different format implementations.
 */
@Injectable()
export class FormatConverterService {
  private converters: Map<string, FormatConverter> = new Map();

  constructor(private readonly configService: ConfigService) {}

  /**
   * Register a format converter
   * @param converter Format converter instance to register
   */
  registerConverter(converter: FormatConverter): void {
    const formatName = converter.getFormatName();
    this.converters.set(formatName, converter);
  }

  /**
   * Get a converter for a specific format
   * @param format Format identifier (e.g., "json", "md", "yaml", "xml")
   * @returns Format converter instance
   * @throws BadRequestException if format is not supported
   */
  getConverter(format?: string): FormatConverter {
    const targetFormat =
      format || this.configService.get<string>('output.defaultFormat', 'md');

    const converter = this.converters.get(targetFormat);
    if (!converter) {
      throw new BadRequestException(
        `Format converter not found for: ${targetFormat}. Supported formats: ${this.getSupportedFormats().join(', ')}`,
      );
    }

    return converter;
  }

  /**
   * Get the default format converter from configuration
   * @returns Default format converter
   */
  getDefaultConverter(): FormatConverter {
    const defaultFormat = this.configService.get<string>(
      'output.defaultFormat',
      'md',
    );
    return this.getConverter(defaultFormat);
  }

  /**
   * Check if a format is supported
   * @param format Format identifier
   * @returns true if supported, false otherwise
   */
  isSupported(format: string): boolean {
    return this.converters.has(format);
  }

  /**
   * Get list of all supported format names
   * @returns Array of format identifiers
   */
  getSupportedFormats(): string[] {
    return Array.from(this.converters.keys());
  }

  /**
   * Get all registered converters
   * @returns Map of format name to converter instance
   */
  getAllConverters(): Map<string, FormatConverter> {
    return new Map(this.converters);
  }

  /**
   * Auto-detect format from file extension
   * @param filename Filename with extension
   * @returns Detected format or null if cannot detect
   */
  detectFormat(filename: string): string | null {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (!ext) return null;

    for (const [format, converter] of this.converters.entries()) {
      if (converter.getFileExtension() === `.${ext}`) {
        return format;
      }
    }

    return null;
  }

  /**
   * Convert content from one format to another
   * @param content Source content string
   * @param sourceFormat Source format identifier
   * @param targetFormat Target format identifier
   * @returns Converted content string
   */
  convert(content: string, sourceFormat: string, targetFormat: string): string {
    const sourceConverter = this.getConverter(sourceFormat);
    const targetConverter = this.getConverter(targetFormat);

    // Parse from source format to UniversalTicket
    const ticket = sourceConverter.parse(content);

    // Serialize to target format
    return targetConverter.serialize(ticket);
  }
}
