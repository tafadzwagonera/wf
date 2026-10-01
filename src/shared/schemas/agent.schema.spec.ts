import { implementerOptionsSchema, verificationScriptSchema } from './agent.schema';

describe('verificationScriptSchema earlyExitPattern', () => {
  afterEach(() => jest.restoreAllMocks());

  it('preserves a valid early-exit pattern', () => {
    const result = verificationScriptSchema.parse({ id: 'tf', name: 'tf', command: 'terraform plan', policy: 'enforced', aliases: [], earlyExitPattern: 'Preparing the remote plan' });
    expect(result.earlyExitPattern).toBe('Preparing the remote plan');
  });

  it('remains backward-compatible without an early-exit pattern', () => {
    expect(verificationScriptSchema.parse({ id: 'lint', name: 'lint', command: 'yarn lint', policy: 'enforced', aliases: [] }).earlyExitPattern).toBeUndefined();
  });
});

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
