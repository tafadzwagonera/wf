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

    it('does not overwrite type metadata from a bold field inside the description body', () => {
      const ticket = converter.parse(
        '# Fix Something\n\n**Type:** bug\n**Priority:** high\n\n## Description\n\n**Type:** task appears in description body'
      );
      expect(ticket.type).toBe('bug');
    });

    it('does not overwrite priority metadata from a bold field inside the description body', () => {
      const ticket = converter.parse(
        '# Add Feature\n\n**Type:** story\n**Priority:** medium\n\n## Description\n\n**Priority:** low appears in description'
      );
      expect(ticket.priority).toBe('medium');
    });
  });
});
