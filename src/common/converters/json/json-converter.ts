import { Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { FormatConverter } from '../format-converter.interface';
import { UniversalTicket } from '../../dto/universal-ticket.dto';
import { WorkflowParseError } from '../../../shared/utils/errors';

/**
 * JSON format converter for UniversalTicket
 * Handles parsing and serialization of tickets in JSON format
 */
@Injectable()
export class JsonConverter implements FormatConverter {
  /**
   * Parse JSON content into a UniversalTicket
   */
  parse(content: string): UniversalTicket {
    try {
      const parsed = JSON.parse(content);
      const ticket = plainToInstance(UniversalTicket, parsed);
      this.assertValid(ticket);
      return ticket;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new WorkflowParseError(`Invalid JSON format: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Throw when a parsed ticket fails class-validator validation
   */
  private assertValid(ticket: UniversalTicket): void {
    const errors = validateSync(ticket);
    if (errors.length > 0) {
      const messages = errors.map(e => Object.values(e.constraints || {}));
      throw new WorkflowParseError(`Validation failed: ${messages.join(', ')}`);
    }
  }

  /**
   * Serialize a UniversalTicket into JSON format
   */
  serialize(ticket: UniversalTicket): string {
    try {
      // Convert to plain object and remove undefined values
      const plain = this.toPlainObject(ticket);
      return JSON.stringify(plain, null, 2);
    } catch (error) {
      throw new WorkflowParseError(`JSON serialization failed: ${error.message}`);
    }
  }

  /**
   * Get the format name
   */
  getFormatName(): string {
    return 'json';
  }

  /**
   * Validate if content is valid JSON
   */
  validate(content: string): boolean {
    try {
      JSON.parse(content);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the file extension
   */
  getFileExtension(): string {
    return '.json';
  }

  /**
   * Convert UniversalTicket to plain object, removing undefined values
   */
  private toPlainObject(ticket: UniversalTicket): Record<string, any> {
    const plain: Record<string, any> = {};

    for (const key of Object.keys(ticket)) {
      const value = ticket[key as keyof UniversalTicket];
      if (value !== undefined) {
        plain[key] = value;
      }
    }

    return plain;
  }
}
