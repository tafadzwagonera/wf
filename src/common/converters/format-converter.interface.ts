import { UniversalTicket } from '../dto/universal-ticket.dto';

/**
 * Supported output formats for ticket descriptions
 */
export enum TicketFormat {
  JSON = 'json',
  MARKDOWN = 'md',
  YAML = 'yaml',
  XML = 'xml',
}

/**
 * Base interface that all format converters must implement.
 * Enables conversion between different ticket description formats.
 */
export interface FormatConverter {
  /**
   * Parse content in this format into a UniversalTicket
   * @param content Raw content string in the converter's format
   * @returns Parsed UniversalTicket object
   * @throws Error if content is invalid
   */
  parse(content: string): UniversalTicket;

  /**
   * Serialize a UniversalTicket into this format
   * @param ticket Universal ticket to serialize
   * @returns Serialized content string
   */
  serialize(ticket: UniversalTicket): string;

  /**
   * Get the format name (e.g., "json", "md", "yaml", "xml")
   * @returns Format identifier
   */
  getFormatName(): string;

  /**
   * Validate if content is valid for this format
   * @param content Content string to validate
   * @returns true if valid, false otherwise
   */
  validate(content: string): boolean;

  /**
   * Get the file extension for this format (e.g., ".json", ".md")
   * @returns File extension with leading dot
   */
  getFileExtension(): string;
}
