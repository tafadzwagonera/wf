import { Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import * as YAML from 'yaml';
import { FormatConverter } from '../format-converter.interface';
import { UniversalTicket } from '../../dto/universal-ticket.dto';
import { WorkflowParseError } from '../../utils/errors';

@Injectable()
export class YamlConverter implements FormatConverter {
  parse(content: string): UniversalTicket {
    try {
      const ticket = this.parseObject(content);
      this.assertValid(ticket);
      return ticket;
    } catch (error) {
      if (error instanceof YAML.YAMLParseError) {
        throw new WorkflowParseError(`Invalid YAML format: ${error.message}`);
      }
      throw error;
    }
  }

  private parseObject(content: string): UniversalTicket {
    const parsed = YAML.parse(content);
    if (!parsed || typeof parsed !== 'object') {
      throw new WorkflowParseError('YAML content must be an object');
    }
    return plainToInstance(UniversalTicket, parsed);
  }

  private assertValid(ticket: UniversalTicket): void {
    const errors = validateSync(ticket);
    if (errors.length > 0) {
      const messages = errors.map(e => Object.values(e.constraints || {}));
      throw new WorkflowParseError(`Validation failed: ${messages.join(', ')}`);
    }
  }

  serialize(ticket: UniversalTicket): string {
    try {
      const plain = this.toPlainObject(ticket);

      return YAML.stringify(plain, {
        indent: 2,
        lineWidth: 0, // Disable line wrapping
        minContentWidth: 0,
      });
    } catch (error) {
      throw new WorkflowParseError(`YAML serialization failed: ${error.message}`);
    }
  }

  getFormatName(): string {
    return 'yaml';
  }

  validate(content: string): boolean {
    try {
      YAML.parse(content);
      return true;
    } catch {
      return false;
    }
  }

  getFileExtension(): string {
    return '.yaml';
  }

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
