import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverWfConfigPath, loadTypeScriptConfig, loadWfConfig, normalizeWfConfig } from './wf-config-loader';
import { ValidationError } from '../shared/utils/errors';
import { createTempDir as createManagedTempDir } from '../shared/testing/temp-dir';

describe('wf-config-loader', () => {
  const tempRoots: string[] = [];

  const createProjectRoot = (): string => {
    const projectRoot = createManagedTempDir('config');
    tempRoots.push(projectRoot);
    return projectRoot;
  };

  afterAll(() => {
    for (const tempRoot of tempRoots) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  describe('discoverWfConfigPath', () => {
    afterEach(() => jest.restoreAllMocks());

    it('prefers TypeScript config files over JavaScript and YAML files', () => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      const projectRoot = createProjectRoot();
      const tsPath = path.join(projectRoot, 'wf.config.ts');

      fs.writeFileSync(tsPath, 'export default {}');
      fs.writeFileSync(path.join(projectRoot, 'wf.config.yaml'), 'ai: []\n');
      fs.writeFileSync(path.join(projectRoot, 'wf.config.js'), 'module.exports = {};\n');

      expect(discoverWfConfigPath(projectRoot)).toBe(tsPath);
    });

    it('uses the documented precedence order when multiple config files are present', () => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      const projectRoot = createProjectRoot();
      const tsPath = path.join(projectRoot, 'wf.config.ts');

      fs.writeFileSync(tsPath, 'export default {};\n');
      fs.writeFileSync(path.join(projectRoot, 'wf.config.js'), 'module.exports = {};\n');
      fs.writeFileSync(path.join(projectRoot, 'wf.config.mjs'), 'export default {};\n');

      expect(discoverWfConfigPath(projectRoot)).toBe(tsPath);
    });

    it('warns to stderr when multiple config files exist', () => {
      const projectRoot = createProjectRoot();
      const tsPath = path.join(projectRoot, 'wf.config.ts');

      fs.writeFileSync(tsPath, 'export default {};\n');
      fs.writeFileSync(path.join(projectRoot, 'wf.config.js'), 'module.exports = {};\n');

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      discoverWfConfigPath(projectRoot);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Multiple wf config files found')
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('wf.config.js')
      );

      warnSpy.mockRestore();
    });

    it('does not warn when only one config file exists', () => {
      const projectRoot = createProjectRoot();
      fs.writeFileSync(path.join(projectRoot, 'wf.config.ts'), 'export default {};\n');

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      discoverWfConfigPath(projectRoot);

      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
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
        })
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
              ai: [{ provider: 'openai', apiKey: 'test-key', model: 'gpt-5.4' }],
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
        })
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
        })
      ).toThrow(/at most one AI provider/i);
    });

    it('rejects unsupported fetch stage overrides', () => {
      expect(() =>
        normalizeWfConfig({
          stages: {
            fetch: 'gpt-5.4',
          } as never,
        })
      ).toThrow(/fetch.*cannot be overridden/i);
    });

    it('accepts commit stage model overrides', () => {
      const config = normalizeWfConfig({
        ai: [
          {
            provider: 'openai',
            apiKey: 'openai-key',
            model: 'gpt-5.4',
            default: true,
          },
          { provider: 'google', apiKey: 'gemini-key', model: 'gemini-2.5-pro' },
        ],
        stages: {
          commit: {
            provider: 'google',
            model: 'gemini-2.5-pro',
          },
        },
      });

      expect(config.ai.stages.commit).toEqual({
        provider: 'google',
        model: 'gemini-2.5-pro',
        backend: 'standard',
      });
      expect(config.stages.commit).toEqual({
        provider: 'google',
        model: 'gemini-2.5-pro',
        backend: 'standard',
      });
    });

    it('rejects legacy string implement stage overrides', () => {
      expect(() =>
        normalizeWfConfig({
          stages: {
            implement: 'gpt-5.4',
          } as never,
        })
      ).toThrow(/validation failed for.*stages\.implement/i);
    });

    it('accepts explicit stage objects with optional agent flag', () => {
      const config = normalizeWfConfig({
        ai: [
          {
            provider: 'openai',
            apiKey: 'openai-key',
            model: 'gpt-5.4',
            default: true,
          },
          {
            provider: 'anthropic',
            apiKey: 'anthropic-key',
            model: 'claude-sonnet-4-20250514',
          },
          {
            provider: 'google',
            apiKey: 'gemini-key',
            model: 'gemini-2.5-pro',
          },
        ],
        stages: {
          plan: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-20250514',
            backend: 'standard',
            maxTokens: 8192,
          },
          review: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-20250514',
            maxTokens: 4096,
          },
          implement: {
            provider: 'anthropic',
            model: 'claude-haiku-4-5-20251001',
            backend: 'agent',
            maxTokens: 2048,
            verificationConditions: {
              policyFile: '.wf/verification.json',
            },
          },
        },
      });

      expect(config.ai.stages.review).toEqual({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        backend: 'agent',
        maxTokens: 4096,
      });
      expect(config.stages.plan).toEqual({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        backend: 'standard',
        maxTokens: 8192,
      });
      expect(config.stages.implement).toEqual({
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        backend: 'agent',
        maxTokens: 2048,
        verificationConditions: {
          policyFile: '.wf/verification.json',
          scripts: {},
        },
      });
    });

    it('rejects string review stage overrides', () => {
      expect(() =>
        normalizeWfConfig({
          stages: {
            review: 'gemini-2.5-pro',
          } as never,
        })
      ).toThrow(/validation failed for.*stages\.review/i);
    });

    it('rejects stage targets that reference providers not configured in ai[]', () => {
      expect(() =>
        normalizeWfConfig({
          ai: [
            {
              provider: 'openai',
              apiKey: 'openai-key',
              model: 'gpt-5.4',
              default: true,
            },
          ],
          stages: {
            review: {
              provider: 'google',
              model: 'gemini-2.5-pro',
            },
          },
        })
      ).toThrow(/review.*google.*configured/i);
    });

    it('normalizes implement stage model and verificationConditions settings', () => {
      const config = normalizeWfConfig({
        ai: [
          {
            provider: 'openai',
            apiKey: 'openai-key',
            model: 'gpt-5.4',
            default: true,
          },
          {
            provider: 'openai',
            apiKey: 'openai-key-2',
            model: 'gpt-5.4-mini',
          },
        ],
        stages: {
          implement: {
            provider: 'openai',
            model: 'gpt-5.4-mini',
            verificationConditions: {
              scripts: {
                formatWrite: 'yarn format:write',
                formatCheck: 'yarn format:check',
                lintFix: 'yarn lint:fix',
                lint: 'yarn lint',
                build: 'yarn build',
              },
            },
          },
        },
      });

      expect(config.stages.implement?.provider).toBe('openai');
      expect(config.stages.implement?.model).toBe('gpt-5.4-mini');
      expect(config.stages.implement?.backend).toBe('agent');
      expect(config.stages.implement?.verificationConditions).toEqual({
        policyFile: undefined,
        scripts: {
          formatWrite: 'yarn format:write',
          formatCheck: 'yarn format:check',
          lintFix: 'yarn lint:fix',
          lint: 'yarn lint',
          build: 'yarn build',
        },
      });
    });

    it('accepts timeoutMs on implement stage config', () => {
      const config = normalizeWfConfig({
        ai: [{ provider: 'openai', apiKey: 'openai-key', model: 'gpt-5.4' }],
        stages: {
          implement: {
            provider: 'openai',
            model: 'gpt-5.4',
            timeoutMs: 1200000,
          },
        },
      });

      expect(config.stages.implement?.timeoutMs).toBe(1200000);
    });

    it('accepts inactivityTimeoutMs on implement stage config', () => {
      const config = normalizeWfConfig({
        ai: [{ provider: 'openai', apiKey: 'openai-key', model: 'gpt-5.4' }],
        stages: {
          implement: {
            provider: 'openai',
            model: 'gpt-5.4',
            inactivityTimeoutMs: 300000,
          },
        },
      });

      expect(config.stages.implement?.inactivityTimeoutMs).toBe(300000);
    });

    it('accepts timeoutMs: 0 on implement stage config to disable wall-clock limit', () => {
      const config = normalizeWfConfig({
        ai: [{ provider: 'openai', apiKey: 'openai-key', model: 'gpt-5.4' }],
        stages: {
          implement: {
            provider: 'openai',
            model: 'gpt-5.4',
            timeoutMs: 0,
          },
        },
      });

      expect(config.stages.implement?.timeoutMs).toBe(0);
    });

    it('accepts inactivityTimeoutMs: 0 on implement stage config to disable inactivity limit', () => {
      const config = normalizeWfConfig({
        ai: [{ provider: 'openai', apiKey: 'openai-key', model: 'gpt-5.4' }],
        stages: {
          implement: {
            provider: 'openai',
            model: 'gpt-5.4',
            inactivityTimeoutMs: 0,
          },
        },
      });

      expect(config.stages.implement?.inactivityTimeoutMs).toBe(0);
    });

    it('normalizes both timeout fields alongside other implement stage fields', () => {
      const config = normalizeWfConfig({
        ai: [{ provider: 'openai', apiKey: 'openai-key', model: 'gpt-5.4' }],
        stages: {
          implement: {
            provider: 'openai',
            model: 'gpt-5.4',
            timeoutMs: 1800000,
            inactivityTimeoutMs: 600000,
            verificationConditions: {
              scripts: { lint: 'yarn lint' },
            },
          },
        },
      });

      expect(config.stages.implement?.timeoutMs).toBe(1800000);
      expect(config.stages.implement?.inactivityTimeoutMs).toBe(600000);
      expect(config.stages.implement?.verificationConditions?.scripts).toEqual({ lint: 'yarn lint' });
    });

    it('accepts a manifest path without inline scripts', () => {
      const config = normalizeWfConfig({
        ai: [{ provider: 'openai', apiKey: 'openai-key', model: 'gpt-5.4' }],
        stages: {
          implement: {
            provider: 'openai',
            model: 'gpt-5.4',
            verificationConditions: {
              policyFile: '.wf/verification.json',
            },
          },
        },
      });

      expect(config.stages.implement?.verificationConditions).toEqual({
        policyFile: '.wf/verification.json',
        scripts: {},
      });
    });

    it('rejects deprecated stages.implement.experimentalAgent', () => {
      expect(() =>
        normalizeWfConfig({
          ai: [{ provider: 'openai', apiKey: 'openai-key', model: 'gpt-5.4' }],
          stages: {
            implement: {
              provider: 'openai',
              model: 'gpt-5.4',
              experimentalAgent: true,
            } as never,
          },
        })
      ).toThrow(/validation failed for.*stages\.implement/i);
    });

    it('strips provider-level model when models is present', () => {
      const config = normalizeWfConfig({
        ai: [
          {
            provider: 'anthropic',
            apiKey: 'anthropic-key',
            model: 'claude-sonnet-4-20250514',
            default: true,
          },
        ],
        stages: {
          implement: {
            provider: 'anthropic',
            models: {
              default: 'claude-opus-4-6',
              mechanical: 'claude-haiku-4-5-20251001',
            },
          },
        },
      });

      expect(config.stages.implement?.models).toEqual({
        default: 'claude-opus-4-6',
        mechanical: 'claude-haiku-4-5-20251001',
      });
      expect(config.stages.implement?.model).toBeUndefined();
    });

    it('preserves model when models is not present', () => {
      const config = normalizeWfConfig({
        ai: [
          {
            provider: 'anthropic',
            apiKey: 'anthropic-key',
            model: 'claude-sonnet-4-20250514',
            default: true,
          },
        ],
        stages: {
          implement: {
            provider: 'anthropic',
            model: 'claude-opus-4-6',
          },
        },
      });

      expect(config.stages.implement?.model).toBe('claude-opus-4-6');
      expect(config.stages.implement?.models).toBeUndefined();
    });

    it('strips provider-injected model when user did not explicitly set model or models', () => {
      const config = normalizeWfConfig({
        ai: [
          {
            provider: 'anthropic',
            apiKey: 'anthropic-key',
            model: 'claude-sonnet-4-20250514',
            default: true,
          },
        ],
        stages: {
          implement: {
            provider: 'anthropic',
          },
        },
      });

      expect(config.stages.implement?.model).toBeUndefined();
      expect(config.stages.implement?.models).toBeUndefined();
    });

    it('defaults stage backend to standard when omitted', () => {
      const config = normalizeWfConfig({
        ai: [
          {
            provider: 'openai',
            apiKey: 'openai-key',
            model: 'gpt-5.4',
            default: true,
          },
        ],
        stages: {
          review: {
            provider: 'openai',
            model: 'gpt-5.4',
          },
        },
      });

      expect(config.stages.review?.backend).toBe('agent');
      expect(config.ai.stages.review?.backend).toBe('agent');
    });

    it('resolves missing stage model from configured provider defaults', () => {
      const config = normalizeWfConfig({
        ai: [
          {
            provider: 'openai',
            apiKey: 'openai-key',
            model: 'gpt-5.4',
            default: true,
          },
          {
            provider: 'anthropic',
            apiKey: 'anthropic-key',
            model: 'claude-sonnet-4-20250514',
          },
        ],
        stages: {
          review: {
            provider: 'openai',
            backend: 'agent',
          },
          plan: {
            provider: 'anthropic',
          },
        },
      });

      expect(config.stages.review).toEqual({
        provider: 'openai',
        model: 'gpt-5.4',
        backend: 'agent',
      });
      expect(config.stages.plan).toEqual({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        backend: 'agent',
      });
    });

    it('keeps commit on the standard backend when backend is omitted', () => {
      const config = normalizeWfConfig({
        ai: [
          {
            provider: 'google',
            apiKey: 'gemini-key',
            model: 'gemini-2.5-pro',
            default: true,
          },
        ],
        stages: {
          commit: {
            provider: 'google',
          },
        },
      });

      expect(config.stages.commit).toEqual({
        provider: 'google',
        model: 'gemini-2.5-pro',
        backend: 'standard',
      });
    });

    it('normalizes create stage without provider for validation-only mode', () => {
      const config = normalizeWfConfig({
        ai: [
          {
            provider: 'openai',
            apiKey: 'openai-key',
            model: 'gpt-5.4',
            default: true,
          },
        ],
        stages: {
          create: {
            verificationConditions: {
              scripts: {
                testVerifyRequestFormat: 'nr test:manual -- test-verify-request-format',
              },
            },
          },
        },
      });

      expect(config.stages.create).toBeDefined();
      expect(config.stages.create?.provider).toBeUndefined();
      expect(config.stages.create?.verificationConditions).toEqual({
        policyFile: undefined,
        scripts: {
          testVerifyRequestFormat: 'nr test:manual -- test-verify-request-format',
        },
      });
    });

    it('normalizes create stage with provider and verificationConditions', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const config = normalizeWfConfig({
        ai: [
          {
            provider: 'openai',
            apiKey: 'openai-key',
            model: 'gpt-5.4',
            default: true,
          },
        ],
        stages: {
          create: {
            provider: 'openai',
            verificationConditions: {
              scripts: {
                format: 'nr test:manual -- test-verify-request-format',
              },
            },
          },
        },
      });

      expect(config.stages.create).toBeDefined();
      expect(config.stages.create?.provider).toBeUndefined();
      expect(config.stages.create?.backend).toBeUndefined();
      expect(config.stages.create?.verificationConditions).toEqual({
        policyFile: undefined,
        scripts: {
          format: 'nr test:manual -- test-verify-request-format',
        },
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('stages.create provider/model/backend/skills settings are currently ignored')
      );
    });

    it('normalizes create stage without provider for validation-only mode', () => {
      const config = normalizeWfConfig({
        ai: [
          {
            provider: 'openai',
            apiKey: 'openai-key',
            model: 'gpt-5.4',
            default: true,
          },
        ],
        stages: {
          create: {
            verificationConditions: {
              scripts: {
                testVerifyRequestFormat: 'nr test:manual -- test-verify-request-format',
              },
            },
          },
        },
      });

      expect(config.stages.create).toBeDefined();
      expect(config.stages.create?.provider).toBeUndefined();
      expect(config.stages.create?.verificationConditions).toEqual({
        policyFile: undefined,
        scripts: {
          testVerifyRequestFormat: 'nr test:manual -- test-verify-request-format',
        },
      });
    });

    it('fails fast when agent mode is enabled for unsupported providers', () => {
      expect(() =>
        normalizeWfConfig({
          ai: [
            {
              provider: 'google',
              apiKey: 'gemini-key',
              model: 'gemini-2.5-pro',
              default: true,
            },
          ],
          stages: {
            review: {
              provider: 'google',
              backend: 'agent',
            },
          },
        })
      ).toThrow(/backend.*agent.*google/i);
    });

    it('accepts backend: cli', () => {
      const config = normalizeWfConfig({
        ai: [
          {
            provider: 'anthropic',
            apiKey: 'anthropic-key',
            model: 'claude-sonnet-4-6',
            default: true,
          },
        ],
        stages: {
          plan: {
            provider: 'anthropic',
            backend: 'cli',
          },
        },
      });

      expect(config.stages.plan?.backend).toBe('cli');
    });

    it('accepts backend: cli with provider: openai', () => {
      const config = normalizeWfConfig({
        ai: [
          {
            provider: 'openai',
            apiKey: 'openai-key',
            model: 'gpt-5.4',
            default: true,
          },
        ],
        stages: {
          plan: {
            provider: 'openai',
            backend: 'cli',
          },
        },
      });

      expect(config.stages.plan?.backend).toBe('cli');
    });

    it('rejects backend: cli on unsupported stage', () => {
      expect(() =>
        normalizeWfConfig({
          ai: [
            {
              provider: 'anthropic',
              apiKey: 'anthropic-key',
              model: 'claude-sonnet-4-6',
              default: true,
            },
          ],
          stages: {
            commit: {
              provider: 'anthropic',
              backend: 'cli',
            },
          },
        })
      ).toThrow(/commit.*does not support.*cli/i);
    });

    it('accepts backend: standard on implement stage at config level', () => {
      const config = normalizeWfConfig({
        ai: [
          {
            provider: 'openai',
            apiKey: 'openai-key',
            model: 'gpt-5.4',
            default: true,
          },
        ],
        stages: {
          implement: {
            provider: 'openai',
            model: 'gpt-5.4',
            backend: 'standard',
          },
        },
      });

      expect(config.stages.implement?.backend).toBe('standard');
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
        ].join('\n')
      );

      const config = await loadWfConfig({ cwd: projectRoot });

      expect(config.ai.provider).toBe('openai');
      expect(config.atlassian.apiToken).toBe('jira-token');
    });

    it('loads CommonJS JavaScript config files from ESM repos without falling back to defaults', async () => {
      const projectRoot = createProjectRoot();

      fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
      fs.writeFileSync(
        path.join(projectRoot, 'wf.config.js'),
        [
          'module.exports = {',
          '  ai: [',
          '    {',
          '      provider: "openai",',
          '      apiKey: "openai-key",',
          '      model: "gpt-5.4",',
          '      default: true,',
          '    },',
          '    {',
          '      provider: "google",',
          '      apiKey: "gemini-key",',
          '      model: "gemini-2.5-pro",',
          '    },',
          '  ],',
          '  stages: {',
          '    generate: {',
          '      provider: "openai",',
          '      model: "gpt-5.4",',
          '    },',
          '  },',
          '};',
          '',
        ].join('\n')
      );

      const config = await loadWfConfig({ cwd: projectRoot });

      expect(config.ai.providers).toEqual([
        expect.objectContaining({
          provider: 'openai',
          apiKey: 'openai-key',
          model: 'gpt-5.4',
          default: true,
        }),
        expect.objectContaining({
          provider: 'google',
          apiKey: 'gemini-key',
          model: 'gemini-2.5-pro',
          default: false,
        }),
      ]);
      expect(config.ai.provider).toBe('openai');
      expect(config.ai.openaiApiKey).toBe('openai-key');
      expect(config.ai.geminiApiKey).toBe('gemini-key');
      expect(config.stages.generate).toEqual({
        provider: 'openai',
        model: 'gpt-5.4',
        backend: 'agent',
      });
    });

    it('keeps loading CommonJS JavaScript config files in non-ESM repos', async () => {
      const projectRoot = createProjectRoot();

      fs.writeFileSync(
        path.join(projectRoot, 'wf.config.js'),
        ['exports.default = {', '  ai: [{ provider: "openai", apiKey: "test-key", model: "gpt-5.4" }],', '};', ''].join(
          '\n'
        )
      );

      const config = await loadWfConfig({ cwd: projectRoot });

      expect(config.ai.provider).toBe('openai');
      expect(config.ai.openaiApiKey).toBe('test-key');
      expect(config.ai.model).toBe('gpt-5.4');
    });

    it('keeps loading ESM-style JavaScript config files', async () => {
      const projectRoot = createProjectRoot();

      fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
      fs.writeFileSync(
        path.join(projectRoot, 'wf.config.js'),
        [
          'export default {',
          '  ai: [{ provider: "openai", apiKey: "openai-key", model: "gpt-5.4", default: true }],',
          '  stages: {',
          '    generate: {',
          '      provider: "openai",',
          '      model: "gpt-5.4",',
          '    },',
          '  },',
          '};',
          '',
        ].join('\n')
      );

      const config = await loadWfConfig({ cwd: projectRoot });

      expect(config.ai.provider).toBe('openai');
      expect(config.ai.openaiApiKey).toBe('openai-key');
      expect(config.stages.generate).toEqual({
        provider: 'openai',
        model: 'gpt-5.4',
        backend: 'agent',
      });
    });

    it('fails fast when a discovered JavaScript config loads as an empty module namespace', async () => {
      const projectRoot = createProjectRoot();

      fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
      fs.writeFileSync(path.join(projectRoot, 'wf.config.js'), 'export {};\n');

      await expect(loadWfConfig({ cwd: projectRoot })).rejects.toThrow(/did not export a config object/i);
    });

    it('loads YAML config files', async () => {
      const projectRoot = createProjectRoot();

      fs.writeFileSync(
        path.join(projectRoot, 'wf.config.yaml'),
        [
          'ai:',
          '  - provider: openai',
          '    apiKey: openai-key',
          '    model: gpt-5.4',
          '    default: true',
          'stages:',
          '  review:',
          '    provider: openai',
          '    model: gpt-5.4',
          '',
        ].join('\n')
      );

      const config = await loadWfConfig({ cwd: projectRoot });

      expect(config.ai.provider).toBe('openai');
      expect(config.ai.model).toBe('gpt-5.4');
      expect(config.ai.stages.review).toEqual({
        provider: 'openai',
        model: 'gpt-5.4',
        backend: 'agent',
      });
    });

    it('wraps SyntaxError from CJS config evaluation with file path context', async () => {
      const projectRoot = createProjectRoot();

      fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
      fs.writeFileSync(
        path.join(projectRoot, 'wf.config.js'),
        'module.exports = { ai: [{ provider: : }] };\n'
      );

      const error = await loadWfConfig({ cwd: projectRoot }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toMatch(/Failed to evaluate config file.*wf\.config\.js/);
    });

    // Jest runs in CJS mode so import() fails and falls back to the VM evaluation path.
    it('wraps ReferenceError from ESM-fallback config evaluation with file path context', async () => {
      const projectRoot = createProjectRoot();

      fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
      fs.writeFileSync(
        path.join(projectRoot, 'wf.config.js'),
        'export default { ai: undeclaredVariable };\n'
      );

      const error = await loadWfConfig({ cwd: projectRoot }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toMatch(/Failed to evaluate config file/);
    });

    it('defaults git.branchNamePattern to the Atlassian regex', () => {
      const config = normalizeWfConfig({});

      expect(config.git.branchNamePattern).toBe(
        '^(bugfix|build|chore|ci|docs|feat|feature|fix|perf|performance|refactor|revert|style|test)\\/[A-Z]+-[0-9]+__|-.+$'
      );
    });

    it('defaults git.branchPrefixMapping correctly', () => {
      const config = normalizeWfConfig({});

      expect(config.git.branchPrefixMapping).toEqual({
        feature: 'feature',
        fix: 'bugfix',
        investigate: 'chore',
      });
    });

    it('accepts custom git.branchNamePattern', () => {
      const config = normalizeWfConfig({
        git: { branchNamePattern: '^custom/.+$' },
      });

      expect(config.git.branchNamePattern).toBe('^custom/.+$');
    });

    it('accepts custom git.branchPrefixMapping', () => {
      const config = normalizeWfConfig({
        git: {
          branchPrefixMapping: {
            feature: 'feat',
            fix: 'fix',
            investigate: 'research',
          },
        },
      });

      expect(config.git.branchPrefixMapping).toEqual({
        feature: 'feat',
        fix: 'fix',
        investigate: 'research',
      });
    });

    it('rejects provider/model mismatch when model prefix does not match declared provider', () => {
      expect(() =>
        normalizeWfConfig({
          ai: [{ provider: 'anthropic', apiKey: 'k', model: 'gpt-5.4' }],
        })
      ).toThrow(/model "gpt-5\.4" does not match provider "anthropic"/i);
    });

    it('rejects OpenAI provider with a Claude model', () => {
      expect(() =>
        normalizeWfConfig({
          ai: [{ provider: 'openai', apiKey: 'k', model: 'claude-sonnet-4-6' }],
        })
      ).toThrow(/model "claude-sonnet-4-6" does not match provider "openai"/i);
    });

    it('rejects Google provider with an OpenAI model', () => {
      expect(() =>
        normalizeWfConfig({
          ai: [{ provider: 'google', apiKey: 'k', model: 'gpt-4.1' }],
        })
      ).toThrow(/model "gpt-4\.1" does not match provider "google"/i);
    });

    it('allows provider/model combinations that match', () => {
      expect(() =>
        normalizeWfConfig({
          ai: [{ provider: 'openai', apiKey: 'k', model: 'gpt-5.4' }],
        })
      ).not.toThrow();
    });

    it('allows unknown model prefixes without throwing', () => {
      expect(() =>
        normalizeWfConfig({
          ai: [{ provider: 'anthropic', apiKey: 'k', model: 'custom-fine-tuned-v1' }],
        })
      ).not.toThrow();
    });

    it('skips provider/model validation when model is omitted (uses default)', () => {
      expect(() =>
        normalizeWfConfig({
          ai: [{ provider: 'openai', apiKey: 'k' }],
        })
      ).not.toThrow();
    });

    it('rejects old branching.* keys', () => {
      expect(() =>
        normalizeWfConfig({
          branching: { atlassianPattern: '^test$' },
        } as never)
      ).toThrow(/validation failed/i);
    });
  });
});
