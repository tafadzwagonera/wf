import { implementerOptionsSchema } from './agent.schema';

describe('implementerOptionsSchema initialPromptOverride', () => {
  afterEach(() => jest.restoreAllMocks());

  it('accepts initialPromptOverride when provided', () => {
    const result = implementerOptionsSchema.parse({
      trackerName: 'jira',
      initialPromptOverride: 'Custom override prompt',
    });
    expect(result.initialPromptOverride).toBe('Custom override prompt');
  });

  it('accepts an object without initialPromptOverride', () => {
    const result = implementerOptionsSchema.parse({ trackerName: 'jira' });
    expect(result.initialPromptOverride).toBeUndefined();
  });

  it('rejects a non-string initialPromptOverride', () => {
    expect(() =>
      implementerOptionsSchema.parse({ trackerName: 'jira', initialPromptOverride: 123 }),
    ).toThrow();
  });
});
