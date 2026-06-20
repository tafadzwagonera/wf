import {
  stripInlineMarkdownDelimiters,
  stripRedundantSections,
} from './markdown-text';

describe('stripInlineMarkdownDelimiters', () => {
  it('removes backtick, bold, and italic delimiters', () => {
    expect(stripInlineMarkdownDelimiters('`code` **bold** *italic*')).toBe(
      'code bold italic',
    );
  });
});

describe('stripRedundantSections', () => {
  const description = [
    '### Summary',
    'A brief summary.',
    '',
    '### Acceptance Criteria',
    '- First criterion',
    '',
    '### Unit Test Scope',
    '- DTO validation covers required fields.',
    '',
    '#### Dependencies',
    '- service-auth v2',
    '',
    '### Risks & Assumptions',
    '- None',
    '',
    '### Affected Repositories',
    '- service-document-v1',
    '',
    '#### References',
    '- https://example.com/doc',
    '- Internal wiki link',
    '',
    '#### Out of Scope',
    '- Refund handling',
  ].join('\n');

  it('removes all four stripped sections', () => {
    const result = stripRedundantSections(description);
    expect(result).not.toContain('### Unit Test Scope');
    expect(result).not.toContain('#### Dependencies');
    expect(result).not.toContain('### Affected Repositories');
    expect(result).not.toContain('#### References');
  });

  it('preserves retained sections', () => {
    const result = stripRedundantSections(description);
    expect(result).toContain('### Summary');
    expect(result).toContain('### Acceptance Criteria');
    expect(result).toContain('### Risks & Assumptions');
    expect(result).toContain('#### Out of Scope');
  });

  it('returns the description unchanged when no stripped sections exist', () => {
    const clean = '### Summary\nA brief summary.\n';
    expect(stripRedundantSections(clean)).toBe(clean);
  });
});
