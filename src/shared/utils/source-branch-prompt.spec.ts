import inquirer from 'inquirer';
import { isRemoteBranch, promptForSourceBranch } from './source-branch-prompt';

jest.mock('inquirer');

describe('promptForSourceBranch', () => {
  const promptMock = inquirer.prompt as jest.MockedFunction<typeof inquirer.prompt>;

  beforeEach(() => {
    promptMock.mockReset();
  });

  it('offers dev branches and the main branch as choices', async () => {
    promptMock.mockResolvedValue({ selected: 'develop' } as any);

    const result = await promptForSourceBranch(['develop', 'dev'], 'main');

    expect(result).toBe('develop');
    const [[question]] = promptMock.mock.calls as any[];
    expect(question[0].choices.map((c: any) => c.value)).toEqual(['develop', 'dev', 'main']);
  });

  it('omits the main branch choice when none is detected', async () => {
    promptMock.mockResolvedValue({ selected: 'develop' } as any);

    await promptForSourceBranch(['develop']);

    const [[question]] = promptMock.mock.calls as any[];
    expect(question[0].choices.map((c: any) => c.value)).toEqual(['develop']);
  });

  it('defaults the prompt selection to the first dev branch', async () => {
    promptMock.mockResolvedValue({ selected: 'develop' } as any);

    await promptForSourceBranch(['develop', 'dev']);

    const [[question]] = promptMock.mock.calls as any[];
    expect(question[0].default).toBe('develop');
  });
});

describe('isRemoteBranch', () => {
  it('treats origin/-prefixed branches as remote', () => {
    expect(isRemoteBranch('origin/develop')).toBe(true);
  });

  it('treats remotes/-prefixed branches as remote', () => {
    expect(isRemoteBranch('remotes/origin/develop')).toBe(true);
  });

  it('treats a plain local branch name as not remote', () => {
    expect(isRemoteBranch('develop')).toBe(false);
  });
});
