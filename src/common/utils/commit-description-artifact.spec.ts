import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  deriveCommitDescriptionPath,
  hashCommitDescriptionDiff,
  readCommitDescriptionRecord,
  renderCommitDescriptionContext,
} from './commit-description-artifact';

describe('commit description artifact', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-desc-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('derives the sidecar path from the review artifact path', () => {
    expect(deriveCommitDescriptionPath('/x/WBP-1-review.md')).toBe('/x/WBP-1-review.commit-description.json');
  });

  it.each(['json', 'yaml', 'yml'])('derives the same sidecar path from a .%s review artifact', extension => {
    expect(deriveCommitDescriptionPath(`/x/WBP-1-review.${extension}`)).toBe(
      '/x/WBP-1-review.commit-description.json'
    );
  });

  it('hashes identical diffs identically and different diffs differently', () => {
    const first = hashCommitDescriptionDiff('diff a');
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(hashCommitDescriptionDiff('diff a')).toBe(first);
    expect(hashCommitDescriptionDiff('diff b')).not.toBe(first);
  });

  it('returns null for a missing file', () => {
    expect(readCommitDescriptionRecord(path.join(tmpDir, 'missing.json'))).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    const file = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(file, '{not json');
    expect(readCommitDescriptionRecord(file)).toBeNull();
  });

  it('returns null for a record failing the schema', () => {
    const file = path.join(tmpDir, 'invalid.json');
    fs.writeFileSync(file, JSON.stringify({ nature: 'fix', description: 'D', diffSha256: 'short' }));
    expect(readCommitDescriptionRecord(file)).toBeNull();
  });

  it('returns the parsed record for a valid file', () => {
    const file = path.join(tmpDir, 'ok.json');
    const record = { nature: 'fix', description: 'D', diffSha256: hashCommitDescriptionDiff('x') };
    fs.writeFileSync(file, JSON.stringify(record));
    expect(readCommitDescriptionRecord(file)).toEqual(record);
  });

  it('renders the description with its change nature', () => {
    const rendered = renderCommitDescriptionContext({
      nature: 'fix',
      description: 'D',
      diffSha256: hashCommitDescriptionDiff('x'),
    });
    expect(rendered).toBe('D (change nature: fix)');
  });
});
