import inquirer from 'inquirer';
import { selectProviderSession } from './provider-session-prompt';

jest.mock('inquirer');

const mockFingerprint = { provider: 'anthropic' as const, backend: 'cli' as const };
const mockCandidate = {
  stage: 'plan',
  provider: 'anthropic' as const,
  backend: 'agent' as const,
  providerSessionId: 'session-123',
  recordedAt: '2026-09-28T10:00:00.000Z',
};

describe('selectProviderSession', () => {
  const promptMock = inquirer.prompt as jest.MockedFunction<typeof inquirer.prompt>;

  beforeEach(() => {
    promptMock.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the latest candidate and displays its stage and session ID', async () => {
    promptMock.mockResolvedValue({ selected: 'latest' } as any);

    const selection = await selectProviderSession({
      candidate: mockCandidate,
      fingerprint: mockFingerprint,
      interactive: true,
    });

    expect(selection).toEqual({ kind: 'latest', stage: 'plan', providerSessionId: 'session-123' });
    const [[question]] = promptMock.mock.calls as any[];
    expect(question[0].choices).toEqual([
      { name: 'Resume latest recorded session — plan: session-123', value: 'latest' },
      { name: 'Use an existing anthropic/cli session', value: 'provided' },
      { name: 'Start a new session', value: 'new' },
    ]);
    expect(question[0].default).toBe('latest');
  });

  it('trims a user-provided provider session ID', async () => {
    promptMock
      .mockResolvedValueOnce({ selected: 'provided' } as any)
      .mockResolvedValueOnce({ providerSessionId: '  supplied-session  ' } as any);

    await expect(selectProviderSession({
      candidate: mockCandidate,
      fingerprint: mockFingerprint,
      interactive: true,
    })).resolves.toEqual({ kind: 'provided', providerSessionId: 'supplied-session' });
  });

  it('rejects blank provided session IDs without validating a provider-specific format', async () => {
    promptMock
      .mockResolvedValueOnce({ selected: 'provided' } as any)
      .mockResolvedValueOnce({ providerSessionId: '' } as any);

    await selectProviderSession({ candidate: mockCandidate, fingerprint: mockFingerprint, interactive: true });

    const [, [question]] = promptMock.mock.calls as any[];
    expect(question[0].validate('   ')).toBe('Provider session ID is required');
    expect(question[0].validate('provider session id / any-format')).toBe(true);
  });

  it('returns a new-session selection when chosen', async () => {
    promptMock.mockResolvedValue({ selected: 'new' } as any);

    await expect(selectProviderSession({
      candidate: null,
      fingerprint: mockFingerprint,
      interactive: true,
    })).resolves.toEqual({ kind: 'new' });
    const [[question]] = promptMock.mock.calls as any[];
    expect(question[0].default).toBe('new');
  });

  it('returns the latest candidate without invoking Inquirer when non-interactive', async () => {
    await expect(selectProviderSession({
      candidate: mockCandidate,
      fingerprint: mockFingerprint,
      interactive: false,
    })).resolves.toEqual({ kind: 'latest', stage: 'plan', providerSessionId: 'session-123' });

    expect(promptMock).not.toHaveBeenCalled();
  });

  it('returns a new-session selection without invoking Inquirer when no candidate exists', async () => {
    await expect(selectProviderSession({
      candidate: null,
      fingerprint: mockFingerprint,
      interactive: false,
    })).resolves.toEqual({ kind: 'new' });

    expect(promptMock).not.toHaveBeenCalled();
  });
});
