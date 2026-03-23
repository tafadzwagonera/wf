import { Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import * as YAML from 'yaml';
import { FormatConverter } from '../format-converter.interface';
import { UniversalTicket } from '../../dto/universal-ticket.dto';

/**
 * YAML format converter for UniversalTicket
 * Handles parsing and serialization of tickets in YAML format
 */
@Injectable()
export class YamlConverter implements FormatConverter {
  /**
   * Parse YAML content into a UniversalTicket
   */
  parse(content: string): UniversalTicket {
    try {
      const parsed = YAML.parse(content);

      if (!parsed || typeof parsed !== 'object') {
        throw new Error('YAML content must be an object');
      }

      const ticket = plainToInstance(UniversalTicket, parsed);

      // Validate the ticket
      const errors = validateSync(ticket);
      if (errors.length > 0) {
        const messages = errors.map((e) => Object.values(e.constraints || {}));
        throw new Error(`Validation failed: ${messages.join(', ')}`);
      }

      return ticket;
    } catch (error) {
      if (error instanceof YAML.YAMLParseError) {
        throw new Error(`Invalid YAML format: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Serialize a UniversalTicket into YAML format
   */
  serialize(ticket: UniversalTicket): string {
    try {
      // Convert to plain object and remove undefined values
      const plain = this.toPlainObject(ticket);

      return YAML.stringify(plain, {
        indent: 2,
        lineWidth: 0, // Disable line wrapping
        minContentWidth: 0,
      });
    } catch (error) {
      throw new Error(`YAML serialization failed: ${error.message}`);
    }
  }

  /**
   * Get the format name
   */
  getFormatName(): string {
    return 'yaml';
  }

  /**
   * Validate if content is valid YAML
   */
  validate(content: string): boolean {
    try {
      YAML.parse(content);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the file extension
   */
  getFileExtension(): string {
    return '.yaml';
  }

  /**
   * Convert UniversalTicket to plain object, removing undefined values
   */
  private toPlainObject(ticket: UniversalTicket): Record<string, any> {
    const plain: Record<string, any> = {};

    Object.keys(ticket).forEach((key) => {
      const value = ticket[key as keyof UniversalTicket];
      if (value !== undefined) {
        plain[key] = value;
      }
    });

    return plain;
  }
}
