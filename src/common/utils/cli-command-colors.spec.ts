jest.mock('chalk', () => {
  const wrap
    = (label: string) =>
      (value: string): string =>
        `<${label}>${value}</${label}>`;

  return {
    __esModule: true,
    default: {
      cyan: wrap('cyan'),
      yellow: wrap('yellow'),
      green: wrap('green'),
    },
  };
});

import { formatCliCommand } from './cli-command-colors';

describe('formatCliCommand', () => {
  it('colors the wf binary, flags, and flag values', () => {
    expect(formatCliCommand('wf issue:generate ./requirements.md --title "Add OAuth2" --save')).toBe(
      '<cyan>wf</cyan> issue:generate ./requirements.md <yellow>--title</yellow> <green>"Add OAuth2"</green> <yellow>--save</yellow>'
    );
  });

  it('colors long flags and their following values', () => {
    expect(formatCliCommand('wf issue:pr WBP-2971 --base main --dry-run')).toBe(
      '<cyan>wf</cyan> issue:pr WBP-2971 <yellow>--base</yellow> <green>main</green> <yellow>--dry-run</yellow>'
    );
  });
});
