import {
  buildGeneratedTicketArtifactFilename,
  buildGeneratedTicketManifestFilename,
  hashGeneratedTicketSources,
} from './generated-ticket-artifact';

describe('generated ticket artifact helpers', () => {
  it('builds the new readable filename stem from the date and source hash', () => {
    const sources = ['https://example.com/spec', './notes.md'];
    const hash = hashGeneratedTicketSources(sources);

    expect(
      buildGeneratedTicketArtifactFilename(
        new Date('2026-04-16T00:00:00.000Z'),
        sources,
        'md',
      ),
    ).toBe(`2026-04-16-${hash}-ticket-description.md`);
  });

  it('builds a sidecar manifest filename for reversible source lookup', () => {
    expect(
      buildGeneratedTicketManifestFilename(
        '2026-04-16-1a2b3c4d-ticket-description.md',
      ),
    ).toBe('2026-04-16-1a2b3c4d-ticket-description.sources.json');
  });
});
