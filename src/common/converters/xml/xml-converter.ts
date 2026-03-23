import { Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { FormatConverter } from '../format-converter.interface';
import { UniversalTicket } from '../../dto/universal-ticket.dto';

/**
 * XML format converter for UniversalTicket
 * Handles parsing and serialization of tickets in XML format
 */
@Injectable()
export class XmlConverter implements FormatConverter {
  private readonly parser: XMLParser;
  private readonly builder: XMLBuilder;

  constructor() {
    // Configure XML parser options
    this.parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      parseTagValue: true,
      parseAttributeValue: true,
      trimValues: true,
    });

    // Configure XML builder options
    this.builder = new XMLBuilder({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      format: true,
      indentBy: '  ',
      suppressEmptyNode: true,
    });
  }

  /**
   * Parse XML content into a UniversalTicket
   */
  parse(content: string): UniversalTicket {
    try {
      const parsed = this.parser.parse(content);

      // Extract ticket data from XML root (expect <ticket> root element)
      const ticketData = parsed.ticket || parsed;

      if (!ticketData || typeof ticketData !== 'object') {
        throw new Error('XML content must contain a valid ticket object');
      }

      // Convert XML structure to plain object
      const plainData = this.xmlToPlain(ticketData);

      const ticket = plainToInstance(UniversalTicket, plainData);

      // Validate the ticket
      const errors = validateSync(ticket);
      if (errors.length > 0) {
        const messages = errors.map((e) => Object.values(e.constraints || {}));
        throw new Error(`Validation failed: ${messages.join(', ')}`);
      }

      return ticket;
    } catch (error) {
      if (error.message && error.message.includes('Validation failed')) {
        throw error;
      }
      throw new Error(`Invalid XML format: ${error.message}`);
    }
  }

  /**
   * Serialize a UniversalTicket into XML format
   */
  serialize(ticket: UniversalTicket): string {
    try {
      // Convert to plain object and remove undefined values
      const plain = this.toPlainObject(ticket);

      // Wrap in <ticket> root element
      const xmlObj = { ticket: plain };

      const xml = this.builder.build(xmlObj);

      // Add XML declaration
      return `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
    } catch (error) {
      throw new Error(`XML serialization failed: ${error.message}`);
    }
  }

  /**
   * Get the format name
   */
  getFormatName(): string {
    return 'xml';
  }

  /**
   * Validate if content is valid XML
   */
  validate(content: string): boolean {
    try {
      this.parser.parse(content);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the file extension
   */
  getFileExtension(): string {
    return '.xml';
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

  /**
   * Convert XML parsed structure to plain object
   * Handles arrays and nested objects from XML parser
   */
  private xmlToPlain(xmlData: any): Record<string, any> {
    const plain: Record<string, any> = {};

    Object.keys(xmlData).forEach((key) => {
      // Skip XML attributes and text nodes
      if (key.startsWith('@_') || key === '#text') {
        return;
      }

      const value = xmlData[key];

      // Handle arrays (labels, components)
      if (key === 'labels' || key === 'components') {
        if (value && typeof value === 'object' && value.item) {
          // XML parser wraps array items
          plain[key] = Array.isArray(value.item) ? value.item : [value.item];
        } else if (Array.isArray(value)) {
          plain[key] = value;
        } else {
          plain[key] = value ? [value] : [];
        }
      } else {
        plain[key] = value;
      }
    });

    return plain;
  }
}
