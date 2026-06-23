import { MarkdownConverter } from './markdown-converter';

describe('MarkdownConverter', () => {
  let converter: MarkdownConverter;

  beforeEach(() => {
    converter = new MarkdownConverter();
  });

  describe('parse', () => {
    it('strips inline markdown delimiters from the parsed title', () => {
      const ticket = converter.parse(`# Fix \`service-document\` startup failures

**Type:** bug
**Priority:** low

## Description

Body`);

      expect(ticket.title).toBe('Fix service-document startup failures');
    });

    it('strips a generated heading label from the parsed title', () => {
      const ticket = converter.parse(`# Heading: Actual title

**Type:** story
**Priority:** high

## Description

Body`);

      expect(ticket.title).toBe('Actual title');
    });

    it('strips a generated title label from the parsed title', () => {
      const ticket = converter.parse(`# Title : Actual title

**Type:** story
**Priority:** high

## Description

Body`);

      expect(ticket.title).toBe('Actual title');
    });

    it('preserves ordinary titles that legitimately contain a colon', () => {
      const ticket = converter.parse(`# API Gateway: add rate limiting

**Type:** story
**Priority:** high

## Description

Body`);

      expect(ticket.title).toBe('API Gateway: add rate limiting');
    });
  });
});
