import { buildTicketMarkdownPreview } from './preview.helpers';

describe('buildTicketMarkdownPreview', () => {
  it('includes the ticket key in the Ticket field', () => {
    const result = buildTicketMarkdownPreview('WBP-42');
    expect(result).toContain('**Ticket:** WBP-42');
  });

  it('returns exactly 10 lines', () => {
    const result = buildTicketMarkdownPreview('WBP-1');
    expect(result.split('\n')).toHaveLength(10);
  });

  it('starts with a markdown h1 heading', () => {
    const result = buildTicketMarkdownPreview('WBP-1');
    expect(result.startsWith('# ')).toBe(true);
  });

  it('includes standard metadata placeholder fields', () => {
    const result = buildTicketMarkdownPreview('WBP-1');
    expect(result).toContain('**Type:**');
    expect(result).toContain('**Status:**');
    expect(result).toContain('**Priority:**');
    expect(result).toContain('**Assignee:**');
  });
});
