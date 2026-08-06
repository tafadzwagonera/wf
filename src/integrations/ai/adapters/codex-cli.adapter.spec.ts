import { ConfigService } from '@nestjs/config';
import { CodexCliAdapter } from './codex-cli.adapter';
import * as codexRunner from './codex-cli-runner';

jest.mock('./codex-cli-runner');
jest.mock('./shared-routing', () => {
  const actual = jest.requireActual<typeof import('./shared-routing')>('./shared-routing');
  return {
    ...actual,
    discoverChangedFiles: jest.fn().mockResolvedValue(new Set<string>()),
  };
});

const mockAssertCodexCliAvailable = codexRunner.assertCodexCliAvailable as jest.MockedFunction<
  typeof codexRunner.assertCodexCliAvailable
>;
const mockBuildCodexCliArgs = codexRunner.buildCodexCliArgs as jest.MockedFunction<
  typeof codexRunner.buildCodexCliArgs
>;
const mockSpawnCodex = codexRunner.spawnCodex as jest.MockedFunction<typeof codexRunner.spawnCodex>;

const createMockConfigService = (): Pick<ConfigService, 'get'> => ({
  get: jest.fn(() => undefined),
});

describe('CodexCliAdapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertCodexCliAvailable.mockImplementation(() => undefined);
    mockBuildCodexCliArgs.mockImplementation(() => ['codex', 'exec', '--json']);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes repo conventions into the initial prompt', async () => {
    mockSpawnCodex.mockReturnValue(
      (async function* () {
        yield {
          type: 'result',
          result: 'done',
          session_id: 'codex-session',
          num_turns: 1,
          total_cost_usd: 0.01,
        };
      })()
    );

    const adapter = new CodexCliAdapter(createMockConfigService() as ConfigService);
    await adapter.generateAndVerify({
      ticket: { ticketKey: 'TEST-1', content: 'test', path: '/tmp/t.md' },
      planArtifact: {
        plan: {
          action: 'feature',
          summary: 'test',
          steps: ['step 1'],
          estimatedComplexity: 'low',
          affectedFiles: [],
          affectedRepositories: [],
          risks: [],
        },
        action: 'feature',
        path: '/tmp/p.json',
      },
      options: { trackerName: 'jira', repoDir: '/repo' },
      verificationScripts: [],
      repoFiles: [],
      repoName: 'repo',
      trackedFilePaths: [],
      conventionsSection: 'Repository conventions (repo):\n- Formatter: prettier (semi: false)',
    });

    expect(mockBuildCodexCliArgs).toHaveBeenCalledTimes(1);
    expect(mockBuildCodexCliArgs.mock.calls[0][0].prompt).toContain('Repository conventions (repo):');
    expect(mockBuildCodexCliArgs.mock.calls[0][0].prompt).toContain('Formatter: prettier');
  });
});
