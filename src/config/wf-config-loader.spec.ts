import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { collectDroppedStageFields, discoverWfConfigPath, getLoadedWfConfig, initializeWfConfig, loadTypeScriptConfig, loadWfConfig, normalizeWfConfig } from './wf-config-loader';
import { ValidationError } from '../common/utils/errors';
import { DEFAULT_OPENAI_MODEL } from '../common/constant';
import { createTempDir as createManagedTempDir } from '../common/testing/temp-dir';

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

  describe('normalizeWfConfig provider defaults', () => {
    it('marks an unflagged second provider as non-default and fills its default model', () => {
      const normalized = normalizeWfConfig({
        ai: [
          { provider: 'anthropic', apiKey: 'k1', model: 'claude-sonnet-4-6', default: true },
          { provider: 'openai', apiKey: 'k2' },
        ],
      });

      expect(normalized.ai.providers[1]).toMatchObject({ default: false, model: DEFAULT_OPENAI_MODEL });
    });
  });

  describe('normalizeWfConfig git and skills', () => {
    it('carries git.protectedBranches into the normalized config', () => {
      const normalized = normalizeWfConfig({ git: { protectedBranches: ['release'] } });

      expect(normalized.git.protectedBranches).toEqual(['release']);
    });

    it('rejects a plan skill outside the allowed enum', () => {
      const rawConfig = JSON.parse('{"stages":{"plan":{"provider":"anthropic","skills":["typo-skill"]}}}');

      expect(() => normalizeWfConfig(rawConfig)).toThrow(ValidationError);
    });

    it('rejects an implement skill outside the allowed enum', () => {
      const rawConfig = JSON.parse('{"stages":{"implement":{"provider":"anthropic","skills":["typo-skill"]}}}');

      expect(() => normalizeWfConfig(rawConfig)).toThrow(ValidationError);
    });

    it.each(['review', 'generate', 'commit'])('rejects skills on the %s stage naming the field', stage => {
      const rawConfig = JSON.parse(`{"stages":{"${stage}":{"provider":"anthropic","skills":["x"]}}}`);

      const run = () => normalizeWfConfig(rawConfig);

      expect(run).toThrow(ValidationError);
      expect(run).toThrow(new RegExp(`stages\\.${stage}\\.skills`));
    });

    it.each(['plan', 'review', 'generate', 'commit'])('rejects an unknown key on the %s stage', stage => {
      const rawConfig = JSON.parse(`{"stages":{"${stage}":{"provider":"anthropic","unknownKey":true}}}`);

      const run = () => normalizeWfConfig(rawConfig);

      expect(run).toThrow(ValidationError);
      expect(run).toThrow(new RegExp(`stages\\.${stage}\\.unknownKey`));
    });

    it.each(['default', 'mechanical'])('rejects an empty implement.models.%s', key => {
      const rawConfig = JSON.parse(`{"stages":{"implement":{"provider":"anthropic","models":{"${key}":""}}}}`);

      expect(() => normalizeWfConfig(rawConfig)).toThrow(ValidationError);
    });

    it('rejects an unknown top-level key', () => {
      expect(() => normalizeWfConfig(JSON.parse('{"unknownKey":true}'))).toThrow(ValidationError);
    });
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
    afterEach(() => jest.restoreAllMocks());

    it('rejects an invalid git.branchNamePattern regex at config load', () => {
      expect(() => normalizeWfConfig({ git: { branchNamePattern: '[' } })).toThrow(/git\.branchNamePattern/);
    });

    it('accepts a valid git.branchNamePattern regex', () => {
      const config = normalizeWfConfig({ git: { branchNamePattern: '^team\\/[a-z-]+$' } });

      expect(config.git.branchNamePattern).toBe('^team\\/[a-z-]+$');
    });

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

    it('preserves skills on plan stage config through normalization', () => {
      const config = normalizeWfConfig({
        ai: [{ provider: 'openai', apiKey: 'openai-key', model: 'gpt-5.4' }],
        stages: {
          plan: {
            provider: 'openai',
            model: 'gpt-5.4',
            skills: ['test-driven-development', 'writing-plans'],
          },
        },
      });

      expect(config.stages.plan?.skills).toEqual(['test-driven-development', 'writing-plans']);
    });

    it('preserves skills on implement stage config through normalization', () => {
      const config = normalizeWfConfig({
        ai: [{ provider: 'openai', apiKey: 'openai-key', model: 'gpt-5.4' }],
        stages: {
          implement: {
            provider: 'openai',
            model: 'gpt-5.4',
            skills: ['coding-style', 'test-driven-development'],
          },
        },
      });

      expect(config.stages.implement?.skills).toEqual(['coding-style', 'test-driven-development']);
    });

    it('preserves figma on plan stage config through normalization', () => {
      const config = normalizeWfConfig({
        ai: [{ provider: 'openai', apiKey: 'openai-key', model: 'gpt-5.4' }],
        stages: {
          plan: { provider: 'openai', model: 'gpt-5.4', figma: true },
        },
      });

      expect(config.stages.plan?.figma).toBe(true);
    });

    it('preserves figma and stallThresholdForVerificationFix on implement stage config through normalization', () => {
      const config = normalizeWfConfig({
        ai: [{ provider: 'openai', apiKey: 'openai-key', model: 'gpt-5.4' }],
        stages: {
          implement: { provider: 'openai', model: 'gpt-5.4', figma: false, stallThresholdForVerificationFix: 3 },
        },
      });

      expect(config.stages.implement?.figma).toBe(false);
      expect(config.stages.implement?.stallThresholdForVerificationFix).toBe(3);
    });

    it('preserves figma and sonar on review stage config through normalization', () => {
      const config = normalizeWfConfig({
        ai: [{ provider: 'openai', apiKey: 'openai-key', model: 'gpt-5.4' }],
        stages: {
          review: { provider: 'openai', model: 'gpt-5.4', figma: true, sonar: true },
        },
      });

      expect(config.stages.review?.figma).toBe(true);
      expect(config.stages.review?.sonar).toBe(true);
    });

    it('omits skills from normalized stage configs when not configured', () => {
      const config = normalizeWfConfig({
        ai: [{ provider: 'openai', apiKey: 'openai-key', model: 'gpt-5.4' }],
        stages: {
          plan: { provider: 'openai', model: 'gpt-5.4' },
          implement: { provider: 'openai', model: 'gpt-5.4' },
        },
      });

      expect(config.stages.plan?.skills).toBeUndefined();
      expect(config.stages.implement?.skills).toBeUndefined();
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

    it('preserves modelRoutingThresholds for the implement stage', () => {
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
            modelRoutingThresholds: {
              maxTargetedWritesForDefault: 8,
              maxPlanStepsForDefault: 12,
            },
          },
        },
      });

      expect(config.stages.implement?.modelRoutingThresholds).toEqual({
        maxTargetedWritesForDefault: 8,
        maxPlanStepsForDefault: 12,
      });
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

    it('normalizes create stage verification conditions without AI settings', () => {
      const config = normalizeWfConfig({
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

      expect(config.stages.create).toEqual({
        verificationConditions: {
          policyFile: undefined,
          scripts: {
            testVerifyRequestFormat: 'nr test:manual -- test-verify-request-format',
          },
        },
      });
      expect((config.ai.stages as Record<string, unknown>).create).toBeUndefined();
    });

    it.each([
      ['provider', 'openai'],
      ['model', 'gpt-5.4'],
      ['backend', 'agent'],
      ['skills', ['writing-plans']],
    ])('rejects unsupported create stage %s configuration', (key, value) => {
      const run = () => normalizeWfConfig({ stages: { create: { [key]: value } as never } });

      expect(run).toThrow(ValidationError);
      expect(run).toThrow(/validation failed for.*stages\.create/i);
      expect(run).toThrow(new RegExp(key));
    });

    it('keeps omitted stages.create valid', () => {
      const config = normalizeWfConfig({
        ai: [{ provider: 'openai', apiKey: 'openai-key', model: 'gpt-5.4' }],
      });

      expect(config.stages.create).toBeUndefined();
    });

    it('does not warn about ignored create-stage AI settings for valid create config', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      normalizeWfConfig({
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

      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('stages.create provider/model/backend/skills settings are currently ignored')
      );
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

    describe('review stage knob propagation', () => {
      afterEach(() => jest.restoreAllMocks());

      it('carries maxDiffLength and epilogueTimeoutMs into the normalized config', () => {
        const config = normalizeWfConfig({
          ai: [{ provider: 'anthropic', apiKey: 'anthropic-key', model: 'claude-sonnet-4-6', default: true }],
          stages: {
            review: {
              provider: 'anthropic',
              maxDiffLength: 50_000,
              epilogueTimeoutMs: 60_000,
            },
          },
        });
        expect(config.stages.review?.maxDiffLength).toBe(50_000);
        expect(config.stages.review?.epilogueTimeoutMs).toBe(60_000);
      });

      it('omits knobs from normalized config when not present in raw config', () => {
        const config = normalizeWfConfig({
          ai: [{ provider: 'anthropic', apiKey: 'anthropic-key', model: 'claude-sonnet-4-6', default: true }],
          stages: {
            review: { provider: 'anthropic' },
          },
        });
        expect(config.stages.review?.maxDiffLength).toBeUndefined();
        expect(config.stages.review?.epilogueTimeoutMs).toBeUndefined();
      });
    });
  });

  describe('collectDroppedStageFields', () => {
    it('reports stage fields present in the validated config but absent from the normalized config', () => {
      const dropped = collectDroppedStageFields(
        { plan: { provider: 'openai', skills: ['writing-plans'] } },
        { plan: { provider: 'openai', model: 'gpt-5.4', backend: 'standard' } },
      );

      expect(dropped).toEqual(['plan.skills']);
    });

    it('excludes the intentional implement model strip from the report', () => {
      const dropped = collectDroppedStageFields(
        { implement: { provider: 'openai', model: 'gpt-5.4', models: { mechanical: 'gpt-5-mini' } } },
        { implement: { provider: 'openai', backend: 'standard', models: { mechanical: 'gpt-5-mini' } } },
      );

      expect(dropped).toEqual([]);
    });

    it('returns an empty list when every validated field is carried through', () => {
      const dropped = collectDroppedStageFields(
        { commit: { provider: 'google', model: 'gemini-2.5-flash' } },
        { commit: { provider: 'google', model: 'gemini-2.5-flash', backend: 'standard' } },
      );

      expect(dropped).toEqual([]);
    });

    it('reports every field of a stage whose normalized counterpart is missing entirely', () => {
      const dropped = collectDroppedStageFields(
        { generate: { provider: 'openai', model: 'gpt-5.4' } },
        {},
      );

      expect(dropped).toEqual(['generate.provider', 'generate.model']);
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

    it('exposes process.env to ESM-style JavaScript configs that read environment variables', async () => {
      const projectRoot = createProjectRoot();
      const previousKey = process.env.WF_TEST_ESM_API_KEY;
      process.env.WF_TEST_ESM_API_KEY = 'env-openai-key';

      fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
      fs.writeFileSync(
        path.join(projectRoot, 'wf.config.js'),
        [
          'export default {',
          '  ai: [{ provider: "openai", apiKey: process.env.WF_TEST_ESM_API_KEY, model: "gpt-5.4", default: true }],',
          '};',
          '',
        ].join('\n')
      );

      try {
        const config = await loadWfConfig({ cwd: projectRoot });

        expect(config.ai.openaiApiKey).toBe('env-openai-key');
      } finally {
        if (previousKey === undefined) delete process.env.WF_TEST_ESM_API_KEY;
        else process.env.WF_TEST_ESM_API_KEY = previousKey;
      }
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

    it('defaults git.branchNamePattern to the Atlassian regex', () => {
      const config = normalizeWfConfig({});

      expect(config.git.branchNamePattern.startsWith('^(bugfix|build|chore|')).toBe(true);
    });

    it('defaults git.commitFormat to auto when omitted', () => {
      const config = normalizeWfConfig({});

      expect(config.git.commitFormat).toBe('auto');
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

  describe('planStepVerification config', () => {
    afterEach(() => jest.restoreAllMocks());

    it('accepts and normalizes planStepVerification verbatim', () => {
      const normalized = normalizeWfConfig({
        ai: [{ provider: 'anthropic', apiKey: 'key', model: 'claude-3' }],
        stages: { implement: { provider: 'anthropic', planStepVerification: { enabled: true, stallWindow: 2 } } },
      });
      expect(normalized.stages?.implement?.planStepVerification).toEqual({ enabled: true, stallWindow: 2 });
    });

    it('rejects an unknown nested key under planStepVerification', () => {
      expect(() =>
        normalizeWfConfig({
          ai: [{ provider: 'anthropic', apiKey: 'key', model: 'claude-3' }],
          stages: {
            implement: {
              provider: 'anthropic',
              planStepVerification: { unknownKey: true } as never,
            },
          },
        }),
      ).toThrow(ValidationError);
    });

    it('accepts and normalizes planStepVerification mode and assessor target', () => {
      const normalized = normalizeWfConfig({
        ai: [
          { provider: 'anthropic', apiKey: 'key', model: 'claude-3', default: true },
          { provider: 'openai', apiKey: 'key', model: 'gpt-5.6-terra' },
        ],
        stages: {
          implement: {
            provider: 'anthropic',
            planStepVerification: { mode: 'pull', provider: 'openai', model: 'gpt-5.6-terra' },
          },
        },
      });
      expect(normalized.stages?.implement?.planStepVerification).toEqual({
        mode: 'pull', provider: 'openai', model: 'gpt-5.6-terra',
      });
    });

    it('rejects invalid verification modes and providers without models', () => {
      expect(() => normalizeWfConfig({
        ai: [{ provider: 'anthropic', apiKey: 'key', model: 'claude-3' }],
        stages: { implement: { provider: 'anthropic', planStepVerification: { mode: 'poll' } as never } },
      })).toThrow(ValidationError);
      expect(() => normalizeWfConfig({
        ai: [{ provider: 'anthropic', apiKey: 'key', model: 'claude-3' }],
        stages: { implement: { provider: 'anthropic', planStepVerification: { provider: 'openai' } as never } },
      })).toThrow(ValidationError);
    });

    it('rejects google and deepseek pull providers but permits them in push mode', () => {
      const ai = [
        { provider: 'anthropic' as const, apiKey: 'key', model: 'claude-3', default: true },
        { provider: 'google' as const, apiKey: 'key', model: 'gemini-2.5-pro' },
        { provider: 'deepseek' as const, apiKey: 'key', model: 'deepseek-chat' },
      ];
      expect(() => normalizeWfConfig({
        ai, stages: { implement: { provider: 'google', planStepVerification: { mode: 'pull' } } },
      })).toThrow(ValidationError);
      expect(() => normalizeWfConfig({
        ai, stages: { implement: { provider: 'anthropic', planStepVerification: { mode: 'pull', provider: 'deepseek', model: 'deepseek-chat' } } },
      })).toThrow(ValidationError);
      expect(() => normalizeWfConfig({
        ai, stages: { implement: { provider: 'anthropic', planStepVerification: { mode: 'push', provider: 'google', model: 'gemini-2.5-pro' } } },
      })).not.toThrow();
    });
  });

  describe('stage provider/model validation', () => {
    afterEach(() => jest.restoreAllMocks());

    const ai = [
      { provider: 'anthropic' as const, apiKey: 'key', model: 'claude-3', default: true },
      { provider: 'openai' as const, apiKey: 'key', model: 'gpt-5.4' },
    ];

    it('rejects a stage target with an explicit mismatched model', () => {
      expect(() => normalizeWfConfig({
        ai, stages: { review: { provider: 'anthropic', model: 'gpt-5.4' } },
      })).toThrow(ValidationError);
    });

    it('accepts a stage target with an explicit matching model', () => {
      expect(() => normalizeWfConfig({
        ai, stages: { review: { provider: 'openai', model: 'gpt-5.4' } },
      })).not.toThrow();
    });

    it('does not throw for an inherited stage model', () => {
      expect(() => normalizeWfConfig({ ai, stages: { review: { provider: 'openai' } } })).not.toThrow();
    });

    it('rejects implement models.default that mismatches the implement provider', () => {
      expect(() => normalizeWfConfig({
        ai, stages: { implement: { provider: 'anthropic', models: { default: 'gpt-5.4' } } },
      })).toThrow(ValidationError);
    });

    it('rejects implement models.mechanical that mismatches the implement provider', () => {
      expect(() => normalizeWfConfig({
        ai, stages: { implement: { provider: 'anthropic', models: { mechanical: 'gpt-5.4' } } },
      })).toThrow(ValidationError);
    });

    it('rejects planStepVerification model-only mismatch against the implement provider', () => {
      expect(() => normalizeWfConfig({
        ai, stages: { implement: { provider: 'anthropic', planStepVerification: { model: 'gpt-5.4' } } },
      })).toThrow(ValidationError);
    });

    it('rejects planStepVerification explicit provider with a mismatched model', () => {
      expect(() => normalizeWfConfig({
        ai, stages: { implement: { provider: 'anthropic', planStepVerification: { provider: 'openai', model: 'claude-3' } } },
      })).toThrow(ValidationError);
    });

    it('accepts planStepVerification without provider or model', () => {
      expect(() => normalizeWfConfig({
        ai, stages: { implement: { provider: 'anthropic', planStepVerification: { enabled: true } } },
      })).not.toThrow();
    });

    it('accepts planStepVerification model-only matching the implement provider', () => {
      expect(() => normalizeWfConfig({
        ai, stages: { implement: { provider: 'anthropic', planStepVerification: { model: 'claude-3' } } },
      })).not.toThrow();
    });
  });

  describe('initializeWfConfig', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('mutates the same object reference so getLoadedWfConfig reflects the second cwd config', async () => {
      const cwd1 = createProjectRoot();
      fs.writeFileSync(path.join(cwd1, 'wf.config.js'), 'module.exports = {};');
      const first = await initializeWfConfig(cwd1);
      const ref = getLoadedWfConfig();
      expect(ref).toBe(first);

      const cwd2 = createProjectRoot();
      fs.writeFileSync(path.join(cwd2, 'wf.config.js'), "module.exports = { ai: [{ provider: 'openai', default: true }] };");
      await initializeWfConfig(cwd2);

      const afterRef = getLoadedWfConfig();
      expect(afterRef).toBe(ref);
      expect((afterRef as any).ai?.provider).toBe('openai');
    });

    it('updates the tracker primitive on loadedConfig itself after second call', async () => {
      const cwd1 = createProjectRoot();
      fs.writeFileSync(path.join(cwd1, 'wf.config.js'), 'module.exports = {};');
      await initializeWfConfig(cwd1);

      const cwd2 = createProjectRoot();
      fs.writeFileSync(path.join(cwd2, 'wf.config.js'), "module.exports = { tracker: 'github' };");
      await initializeWfConfig(cwd2);

      expect((getLoadedWfConfig() as any).tracker).toBe('github');
    });
  });
});
