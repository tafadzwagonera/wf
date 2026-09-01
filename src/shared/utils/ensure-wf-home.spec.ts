import * as fs from 'node:fs';
import inquirer from 'inquirer';
import { ensureWfHome } from './ensure-wf-home';
import { getWfHomeDir } from './wf-paths';

jest.mock('fs');
jest.mock('inquirer');

const mockExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
const mockMkdirSync = fs.mkdirSync as jest.MockedFunction<typeof fs.mkdirSync>;
const mockPrompt = inquirer.prompt as jest.MockedFunction<typeof inquirer.prompt>;

describe('ensureWfHome', () => {
  const originalIsTTY = process.stdin.isTTY;

  afterEach(() => {
    jest.resetAllMocks();
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
  });

  it('returns immediately when ~/.wf exists', async () => {
    mockExistsSync.mockReturnValue(true);

    await ensureWfHome();

    expect(mockExistsSync).toHaveBeenCalledWith(getWfHomeDir());
    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  it('prompts and creates directories when TTY available and user confirms', async () => {
    mockExistsSync.mockReturnValue(false);
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      writable: true,
      configurable: true,
    });
    mockPrompt.mockResolvedValue({ confirm: true });

    await ensureWfHome();

    expect(mockMkdirSync).toHaveBeenCalledTimes(3);
  });

  it('throws when user declines', async () => {
    mockExistsSync.mockReturnValue(false);
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      writable: true,
      configurable: true,
    });
    mockPrompt.mockResolvedValue({ confirm: false });

    await expect(ensureWfHome()).rejects.toThrow(/wf home directory.*is required/);
  });

  it('throws when no TTY available', async () => {
    mockExistsSync.mockReturnValue(false);
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      writable: true,
      configurable: true,
    });

    await expect(ensureWfHome()).rejects.toThrow(/does not exist.*Create it manually/);
  });
});
