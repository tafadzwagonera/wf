import { apiCallPreviewSchema } from './preview.schema';

describe('apiCallPreviewSchema', () => {
  it('accepts CLI preview entries', () => {
    expect(() => apiCallPreviewSchema.parse({
      method: 'CLI',
      endpoint: 'codex exec --json',
      platform: 'Codex CLI',
      description: 'Preview a CLI-backed review command',
    })).not.toThrow();
  });
});
