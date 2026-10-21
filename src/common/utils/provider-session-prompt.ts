import inquirer from 'inquirer';
import type { ProviderSessionCandidate, StageConfigFingerprint } from '../types/session.types';

export type ProviderSessionSelection
  = { kind: 'latest'; providerSessionId: string; stage: string }
    | { kind: 'provided'; providerSessionId: string }
    | { kind: 'new' };

type ProviderSessionPromptOptions = {
  candidate: ProviderSessionCandidate | null;
  fingerprint: StageConfigFingerprint;
  interactive: boolean;
};

type ProviderSessionChoice = 'latest' | 'provided' | 'new';

/**
 * Selects the provider session to use for a resumable stage.
 *
 * @param options - Candidate, configured backend, and interactivity details
 * @returns The selected provider-session action
 */
export const selectProviderSession = async (
  options: ProviderSessionPromptOptions
): Promise<ProviderSessionSelection> => {
  if (!options.interactive) return selectNonInteractiveProviderSession(options.candidate);

  const selected = await promptForProviderSessionChoice(options);
  if (selected === 'latest' && options.candidate) return selectNonInteractiveProviderSession(options.candidate);
  if (selected === 'new') return { kind: 'new' };
  return promptForProvidedProviderSession(options.fingerprint);
};

const selectNonInteractiveProviderSession = (candidate: ProviderSessionCandidate | null): ProviderSessionSelection => {
  if (!candidate) return { kind: 'new' };
  return { kind: 'latest', providerSessionId: candidate.providerSessionId, stage: candidate.stage };
};

type ProviderSessionChoiceOption = { name: string; value: ProviderSessionChoice };

const createLatestChoice = (candidate: ProviderSessionCandidate | null): ProviderSessionChoiceOption[] => {
  if (!candidate) return [];
  return [{
    name: `Resume latest recorded session — ${candidate.stage}: ${candidate.providerSessionId}`,
    value: 'latest',
  }];
};

const createProviderSessionChoices = (options: ProviderSessionPromptOptions): ProviderSessionChoiceOption[] => {
  return [
    ...createLatestChoice(options.candidate),
    {
      name: `Use an existing ${options.fingerprint.provider}/${options.fingerprint.backend} session`,
      value: 'provided',
    },
    { name: 'Start a new session', value: 'new' },
  ];
};

const promptForProviderSessionChoice = async (
  options: ProviderSessionPromptOptions
): Promise<ProviderSessionChoice> => {
  const choices = createProviderSessionChoices(options);
  const { selected } = await inquirer.prompt<{ selected: ProviderSessionChoice }>([{
    type: 'list',
    name: 'selected',
    message: 'Select provider session:',
    prefix: ' ',
    choices,
    default: options.candidate ? 'latest' : 'new',
  }]);
  return selected;
};

const promptForProvidedProviderSession = async (
  fingerprint: StageConfigFingerprint
): Promise<ProviderSessionSelection> => {
  const { providerSessionId } = await inquirer.prompt<{ providerSessionId: string }>([{
    type: 'input',
    name: 'providerSessionId',
    message: `Enter ${fingerprint.provider}/${fingerprint.backend} session ID:`,
    prefix: ' ',
    default: '',
    validate: (value: string) => value.trim().length > 0 || 'Provider session ID is required',
  }]);
  return { kind: 'provided', providerSessionId: providerSessionId.trim() };
};
