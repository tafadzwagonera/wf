import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  discoverWfConfigPath,
  loadTypeScriptConfig,
  loadWfConfig,
  normalizeWfConfig,
} from './wf-config-loader';

describe('wf-config-loader', () => {
  const tempRoots: string[] = [];

  const createProjectRoot = (): string => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-config-'));
    tempRoots.push(projectRoot);
    return projectRoot;
  };

  afterAll(() => {
    for (const tempRoot of tempRoots) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  describe('discoverWfConfigPath', () => {
    it('prefers JavaScript config files over TypeScript and YAML files', () => {
      const projectRoot = createProjectRoot();
      const jsPath = path.join(projectRoot, 'wf.config.js');

      fs.writeFileSync(
        path.join(projectRoot, 'wf.config.ts'),
        'export default {}',
      );
      fs.writeFileSync(path.join(projectRoot, 'wf.config.yaml'), 'ai: []\n');
      fs.writeFileSync(jsPath, 'module.exports = {};\n');

      expect(discoverWfConfigPath(projectRoot)).toBe(jsPath);
    });

    it('uses the documented precedence order when multiple config files are present', () => {
      const projectRoot = createProjectRoot();
      const jsPath = path.join(projectRoot, 'wf.config.js');

      fs.writeFileSync(jsPath, 'module.exports = {};\n');
      fs.writeFileSync(
        path.join(projectRoot, 'wf.config.mjs'),
        'export default {};\n',
      );

      expect(discoverWfConfigPath(projectRoot)).toBe(jsPath);
    });
  });

  describe('loadTypeScriptConfig', () => {
    it('throws a helpful error when Node cannot load TypeScript config natively and jiti is unavailable', async () => {
      const projectRoot = createProjectRoot();
      const configPath = path.join(projectRoot, 'wf.config.ts');

      fs.writeFileSync(configPath, 'export default {};\n');

      await expect(
        loadTypeScriptConfig(configPath, {
          cwd: projectRoot,
          runtime: 'node',
          nodeVersion: '22.12.0',
          execArgv: [],
          loadJiti: () => {
            throw new Error('jiti not installed');
          },
        }),
      ).rejects.toThrow(/install.*jiti/i);
    });

    it('uses jiti when available for Node TypeScript config files', async () => {
      const projectRoot = createProjectRoot();
      const configPath = path.join(projectRoot, 'wf.config.ts');

      fs.writeFileSync(configPath, 'export default {};\n');

      const config = await loadTypeScriptConfig(configPath, {
        cwd: projectRoot,
        runtime: 'node',
        nodeVersion: '20.11.0',
        execArgv: [],
        loadJiti: () => {
          return {
            __esModule: true,
            default: {
              ai: [
                { provider: 'openai', apiKey: 'test-key', model: 'gpt-5.4' },
              ],
            },
          };
        },
      });

      expect(config).toEqual({
        ai: [{ provider: 'openai', apiKey: 'test-key', model: 'gpt-5.4' }],
      });
    });
  });

  describe('normalizeWfConfig', () => {
    it('accepts a single AI provider when none is explicitly marked as default', () => {
      const config = normalizeWfConfig({
        ai: [{ provider: 'openai', apiKey: 'openai-key', model: 'gpt-5.4' }],
      });

      expect(config.ai.provider).toBe('openai');
      expect(config.ai.model).toBe('gpt-5.4');
      expect(config.ai.openaiApiKey).toBe('openai-key');
    });

    it('requires an explicit default AI provider when multiple providers are configured', () => {
      expect(() =>
        normalizeWfConfig({
          ai: [
            { provider: 'openai', apiKey: 'openai-key', model: 'gpt-5.4' },
            {
              provider: 'google',
              apiKey: 'gemini-key',
              model: 'gemini-2.5-pro',
            },
          ],
        }),
      ).toThrow(/default AI provider.*required/i);
    });

    it('exposes configured maxTokens only for the active Gemini provider', () => {
      const config = normalizeWfConfig({
        ai: [
          {
            provider: 'google',
            apiKey: 'gemini-key',
            model: 'gemini-2.5-pro',
            maxTokens: 8192,
            default: true,
          },
        ],
      });

      expect(config.ai.maxTokens).toBe(8192);
    });

    it('ignores configured maxTokens for non-Gemini providers', () => {
      const config = normalizeWfConfig({
        ai: [
          {
            provider: 'openai',
            apiKey: 'openai-key',
            model: 'gpt-5.4',
            maxTokens: 8192,
            default: true,
          },
        ],
      });

      expect(config.ai.maxTokens).toBeUndefined();
    });

    it('still resolves API keys for non-default providers', () => {
      const config = normalizeWfConfig({
        ai: [
          {
            provider: 'openai',
            apiKey: 'openai-key',
            model: 'gpt-5.4',
            default: true,
          },
          {
            provider: 'google',
            apiKey: 'gemini-key',
            model: 'gemini-2.5-pro',
          },
        ],
      });

      expect(config.ai.geminiApiKey).toBe('gemini-key');
    });

    it('rejects multiple default AI providers', () => {
      expect(() =>
        normalizeWfConfig({
          ai: [
            {
              provider: 'anthropic',
              apiKey: 'anthropic-key',
              model: 'claude-sonnet-4-20250514',
              default: true,
            },
            {
              provider: 'openai',
              apiKey: 'openai-key',
              model: 'gpt-5.4',
              default: true,
            },
          ],
        }),
      ).toThrow(/at most one AI provider/i);
    });

    it('rejects unsupported fetch stage overrides', () => {
      expect(() =>
        normalizeWfConfig({
          stages: {
            fetch: 'gpt-5.4',
          } as never,
        }),
      ).toThrow(/fetch.*cannot be overridden/i);
    });

    it('accepts commit stage model overrides', () => {
      const config = normalizeWfConfig({
        ai: [{ provider: 'openai', apiKey: 'openai-key', model: 'gpt-5.4' }],
        stages: {
          commit: 'gemini-2.5-pro',
        },
      });

      expect(config.ai.stages.commit).toBe('gemini-2.5-pro');
      expect(config.stages.commit).toBe('gemini-2.5-pro');
    });

    it('rejects legacy string implement stage overrides', () => {
      expect(() =>
        normalizeWfConfig({
          stages: {
            implement: 'gpt-5.4',
          } as never,
        }),
      ).toThrow(/implement.*object/i);
    });

    it('normalizes implement stage model and afterImplement settings', () => {
      const config = normalizeWfConfig({
        ai: [{ provider: 'openai', apiKey: 'openai-key', model: 'gpt-5.4' }],
        stages: {
          implement: {
            model: 'gemini-2.5-pro',
            afterImplement: {
              baseMaxAttempts: 3,
              maxProgressExtensions: 2,
              absoluteMaxAttempts: 5,
              fingerprintLineCount: 10,
              requireStateChangeForRetry: true,
              retryOnSameFailure: false,
              scripts: {
                formatWrite: 'npm run format:write',
                formatCheck: 'npm run format:check',
                lintFix: 'npm run lint:fix',
                lint: 'npm run lint',
                build: 'npm run build',
              },
            },
          },
        },
      });

      expect(config.stages.implement?.model).toBe('gemini-2.5-pro');
      expect(config.stages.implement?.afterImplement).toEqual({
        baseMaxAttempts: 3,
        maxProgressExtensions: 2,
        absoluteMaxAttempts: 5,
        fingerprintLineCount: 10,
        requireStateChangeForRetry: true,
        retryOnSameFailure: false,
        scripts: {
          formatWrite: 'npm run format:write',
          formatCheck: 'npm run format:check',
          lintFix: 'npm run lint:fix',
          lint: 'npm run lint',
          build: 'npm run build',
        },
      });
    });
  });

  describe('loadWfConfig', () => {
    it('loads JavaScript config files and applies defaults', async () => {
      const projectRoot = createProjectRoot();

      fs.writeFileSync(
        path.join(projectRoot, 'wf.config.js'),
        [
          'module.exports = {',
          '  ai: [{ provider: "openai", apiKey: "test-key", model: "gpt-5.4" }],',
          '  atlassian: {',
          '    baseUrl: "https://example.atlassian.net",',
          '    email: "dev@example.com",',
          '    jira: { apiToken: "jira-token" },',
          '  },',
          '};',
          '',
        ].join('\n'),
      );

      const config = await loadWfConfig({ cwd: projectRoot });

      expect(config.ai.provider).toBe('openai');
      expect(config.atlassian.apiToken).toBe('jira-token');
      expect(config.state.directory).toBe(
        path.join(os.homedir(), '.wf', 'state'),
      );
      expect(config.logging.directory).toBe(
        path.join(os.homedir(), '.wf', 'logs'),
      );
    });

    it('loads YAML config files', async () => {
      const projectRoot = createProjectRoot();

      fs.writeFileSync(
        path.join(projectRoot, 'wf.config.yaml'),
        [
          'ai:',
          '  - provider: google',
          '    apiKey: gemini-key',
          '    model: gemini-2.5-pro',
          '    default: true',
          'stages:',
          '  review: gemini-2.5-pro',
          '',
        ].join('\n'),
      );

      const config = await loadWfConfig({ cwd: projectRoot });

      expect(config.ai.provider).toBe('google');
      expect(config.ai.model).toBe('gemini-2.5-pro');
      expect(config.ai.stages.review).toBe('gemini-2.5-pro');
    });
  });
});
