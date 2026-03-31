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
              ai: [{ name: 'openai', apiKey: 'test-key', model: 'gpt-5.4' }],
            },
          };
        },
      });

      expect(config).toEqual({
        ai: [{ name: 'openai', apiKey: 'test-key', model: 'gpt-5.4' }],
      });
    });
  });

  describe('normalizeWfConfig', () => {
    it('defaults the first AI provider when none is explicitly marked as default', () => {
      const config = normalizeWfConfig({
        ai: [
          { name: 'openai', apiKey: 'openai-key', model: 'gpt-5.4' },
          { name: 'gemini', apiKey: 'gemini-key', model: 'gemini-2.5-pro' },
        ],
      });

      expect(config.ai.provider).toBe('openai');
      expect(config.ai.model).toBe('gpt-5.4');
      expect(config.ai.openaiApiKey).toBe('openai-key');
      expect(config.ai.geminiApiKey).toBe('gemini-key');
    });

    it('rejects multiple default AI providers', () => {
      expect(() =>
        normalizeWfConfig({
          ai: [
            {
              name: 'anthropic',
              apiKey: 'anthropic-key',
              model: 'claude-sonnet-4-20250514',
              default: true,
            },
            {
              name: 'openai',
              apiKey: 'openai-key',
              model: 'gpt-5.4',
              default: true,
            },
          ],
        }),
      ).toThrow(/at most one AI provider/i);
    });

    it('rejects unsupported stage overrides', () => {
      expect(() =>
        normalizeWfConfig({
          stages: {
            commit: 'gpt-5.4',
          } as never,
        }),
      ).toThrow(/commit.*cannot be overridden/i);
    });
  });

  describe('loadWfConfig', () => {
    it('loads JavaScript config files and applies defaults', async () => {
      const projectRoot = createProjectRoot();

      fs.writeFileSync(
        path.join(projectRoot, 'wf.config.js'),
        [
          'module.exports = {',
          '  ai: [{ name: "openai", apiKey: "test-key", model: "gpt-5.4" }],',
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
          '  - name: gemini',
          '    apiKey: gemini-key',
          '    model: gemini-2.5-pro',
          '    default: true',
          'stages:',
          '  review: gemini-2.5-pro',
          '',
        ].join('\n'),
      );

      const config = await loadWfConfig({ cwd: projectRoot });

      expect(config.ai.provider).toBe('gemini');
      expect(config.ai.model).toBe('gemini-2.5-pro');
      expect(config.ai.stages.review).toBe('gemini-2.5-pro');
    });
  });
});
