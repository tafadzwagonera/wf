import { ConfigService } from '@nestjs/config';
import { AiService } from '../integrations/ai/ai.service';
import type { StageAgentService } from '../integrations/ai/stage-agent.service';
import { UiDesignScreenshotsStageService } from '../review/ui-design-screenshots-stage.service';
import {
  UiDesignScreenshotConformanceService,
  buildDesignConformanceFixPrompt,
  diffPendingFindings,
  findingKey,
  mergeDesignConformanceConfig,
} from './ui-design-screenshot-conformance.service';

type MockConfig = {
  enabled?: boolean;
  maxScreenshots?: number;
  omitConfig?: boolean;
  target?: { provider?: string; model?: string; backend?: string };
  implementProvider?: string;
  implementBackend?: string;
  withStageAgent?: boolean;
};

const sampleDiff = 'diff --git a/src/a.vue b/src/a.vue\n+<button class="px-4">Save</button>\n';

const createMockConfigService = (cfg: MockConfig = {}): ConfigService => {
  const values: Record<string, unknown> = {
    'stages.implement.designConformance': cfg.omitConfig
      ? undefined
      : { enabled: cfg.enabled ?? true, maxScreenshots: cfg.maxScreenshots, ...cfg.target },
    'stages.implement.provider': cfg.implementProvider,
    'stages.implement.backend': cfg.implementBackend,
  };
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
};

const createMockAiService = (): { execute: jest.Mock } => ({
  execute: jest.fn().mockResolvedValue({ content: JSON.stringify({ findings: [] }) }),
});

const createMockScreenshotsStage = (): { encodeFromPaths: jest.Mock } => ({
  encodeFromPaths: jest.fn((paths: string[]) => ({
    screenshots: paths.map(p => ({ path: p, mediaType: 'image/png', base64: `b64:${p}` })),
    paths,
  })),
});

const createMockStageAgent = (): { runScreenshotPrompt: jest.Mock } => ({
  runScreenshotPrompt: jest.fn().mockResolvedValue({ content: JSON.stringify({ findings: [] }) }),
});

const createService = (cfg: MockConfig = {}) => {
  const aiService = createMockAiService();
  const screenshotsStage = createMockScreenshotsStage();
  const stageAgent = createMockStageAgent();
  const service = new UiDesignScreenshotConformanceService(
    aiService as unknown as AiService,
    createMockConfigService(cfg),
    screenshotsStage as unknown as UiDesignScreenshotsStageService,
    cfg.withStageAgent === false ? undefined : (stageAgent as unknown as StageAgentService),
  );
  return { service, aiService, screenshotsStage, stageAgent };
};

describe('UiDesignScreenshotConformanceService', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('makes one call per screenshot with the image attached and no provider or model override', async () => {
    const { service, aiService } = createService();

    await service.check({ paths: ['/d/a.png', '/d/b.png'], diff: sampleDiff, changedFiles: ['src/a.vue'] });

    expect(aiService.execute).toHaveBeenCalledTimes(2);
    const first = aiService.execute.mock.calls[0][0];
    expect(first.stage).toBe('implement');
    expect(first).not.toHaveProperty('provider');
    expect(first).not.toHaveProperty('model');
    expect(first.temperature).toBe(0);
    expect(first.context.screenshots).toEqual([{ path: '/d/a.png', mediaType: 'image/png', base64: 'b64:/d/a.png' }]);
    expect(first.prompt).toContain('src/a.vue');
    expect(first.prompt).toContain('<button class="px-4">Save</button>');
  });

  it('uses designConformance provider and model when both are set', async () => {
    const { service, aiService } = createService({
      target: { provider: 'openai', model: 'gpt-custom' },
    });

    await service.check({ paths: ['/d/a.png'], diff: sampleDiff, changedFiles: ['src/a.vue'] });

    const request = aiService.execute.mock.calls[0][0];
    expect(request.provider).toBe('openai');
    expect(request.model).toBe('gpt-custom');
  });

  it('uses the implement stage provider when only designConformance.model is set', async () => {
    const { service, aiService } = createService({
      target: { model: 'claude-custom' }, implementProvider: 'anthropic',
    });

    await service.check({ paths: ['/d/a.png'], diff: sampleDiff, changedFiles: ['src/a.vue'] });

    const request = aiService.execute.mock.calls[0][0];
    expect(request.provider).toBe('anthropic');
    expect(request.model).toBe('claude-custom');
  });

  it('makes no calls and warns when the resolved provider cannot read screenshots', async () => {
    const { service, aiService } = createService({ target: { provider: 'google', model: 'g' } });

    const findings = await service.check({ paths: ['/d/a.png'], diff: sampleDiff, changedFiles: ['src/a.vue'] });

    expect(findings).toEqual([]);
    expect(aiService.execute).not.toHaveBeenCalled();
    const lines = (console.log as jest.Mock).mock.calls.map(call => String(call[0]));
    expect(lines.some(line => line.includes("provider 'google'"))).toBe(true);
  });

  it('runs calls strictly sequentially in input order', async () => {
    const { service, aiService } = createService();
    let inFlight = 0;
    let maxInFlight = 0;
    aiService.execute.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setImmediate(resolve));
      inFlight -= 1;
      return { content: JSON.stringify({ findings: [] }) };
    });

    await service.check({ paths: ['/d/a.png', '/d/b.png', '/d/c.png'], diff: sampleDiff, changedFiles: ['src/a.vue'] });

    expect(maxInFlight).toBe(1);
    const order = aiService.execute.mock.calls.map(call => call[0].context.screenshots[0].path);
    expect(order).toEqual(['/d/a.png', '/d/b.png', '/d/c.png']);
  });

  it('prints a progress line per screenshot', async () => {
    const { service } = createService();

    await service.check({ paths: ['/d/a.png', '/d/b.png'], diff: sampleDiff, changedFiles: ['src/a.vue'] });

    const lines = (console.log as jest.Mock).mock.calls.map(call => String(call[0]));
    expect(lines.some(line => line.includes('[design-check] 1/2 a.png'))).toBe(true);
    expect(lines.some(line => line.includes('[design-check] 2/2 b.png'))).toBe(true);
  });

  it('returns findings tagged with the screenshot path', async () => {
    const { service, aiService } = createService();
    aiService.execute.mockResolvedValueOnce({
      content: JSON.stringify({ findings: [{ area: 'header', deviation: 'padding differs' }] }),
    });

    const findings = await service.check({ paths: ['/d/a.png'], diff: sampleDiff, changedFiles: ['src/a.vue'] });

    expect(findings).toEqual([{ screenshot: '/d/a.png', area: 'header', deviation: 'padding differs' }]);
  });

  it('turns a failing call into a warning and still checks later screenshots', async () => {
    const { service, aiService } = createService();
    aiService.execute
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce({
        content: JSON.stringify({ findings: [{ area: 'footer', deviation: 'wrong colour' }] }),
      });

    const findings = await service.check({ paths: ['/d/a.png', '/d/b.png'], diff: sampleDiff, changedFiles: ['src/a.vue'] });

    expect(aiService.execute).toHaveBeenCalledTimes(2);
    expect(findings).toEqual([{ screenshot: '/d/b.png', area: 'footer', deviation: 'wrong colour' }]);
    const lines = (console.log as jest.Mock).mock.calls.map(call => String(call[0]));
    expect(lines.some(line => line.includes('rate limited'))).toBe(true);
  });

  it('turns an unparseable response into a warning', async () => {
    const { service, aiService } = createService();
    aiService.execute.mockResolvedValueOnce({ content: 'not json' });

    const findings = await service.check({ paths: ['/d/a.png'], diff: sampleDiff, changedFiles: ['src/a.vue'] });

    expect(findings).toEqual([]);
  });

  it('caps screenshots at maxScreenshots and logs how many were skipped', async () => {
    const { service, aiService } = createService({ maxScreenshots: 2 });

    await service.check({ paths: ['/d/a.png', '/d/b.png', '/d/c.png', '/d/d.png'], diff: sampleDiff, changedFiles: ['src/a.vue'] });

    expect(aiService.execute).toHaveBeenCalledTimes(2);
    const lines = (console.log as jest.Mock).mock.calls.map(call => String(call[0]));
    expect(lines.some(line => line.includes('skipped 2'))).toBe(true);
  });

  it.each([
    ['disabled', { enabled: false }],
    ['unconfigured', { omitConfig: true }],
  ])('makes no calls when %s', async (_name, cfg) => {
    const { service, aiService } = createService(cfg);

    const findings = await service.check({ paths: ['/d/a.png'], diff: sampleDiff, changedFiles: ['src/a.vue'] });

    expect(findings).toEqual([]);
    expect(aiService.execute).not.toHaveBeenCalled();
  });

  it('makes no calls when there are no screenshots', async () => {
    const { service, aiService } = createService();

    const findings = await service.check({ paths: [], diff: sampleDiff, changedFiles: ['src/a.vue'] });

    expect(findings).toEqual([]);
    expect(aiService.execute).not.toHaveBeenCalled();
  });

  describe('requested through issue --ui-design-screenshots', () => {
    const run = (service: UiDesignScreenshotConformanceService, requested?: boolean) =>
      service.check({ paths: ['/d/a.png'], diff: sampleDiff, changedFiles: ['src/a.vue'], repoDir: '/repo', requested });

    it.each([
      ['no config and no request', { omitConfig: true }, undefined, 0],
      ['no config with the request', { omitConfig: true }, true, 1],
      ['enabled: false with the request', { enabled: false }, true, 1],
      ['enabled: false without the request', { enabled: false }, undefined, 0],
      ['enabled: true without the request', { enabled: true }, undefined, 1],
    ])('%s', async (_name, config, requested, expectedCalls) => {
      const { service, aiService } = createService(config);

      await run(service, requested);

      expect(aiService.execute).toHaveBeenCalledTimes(expectedCalls);
    });

    it('falls back to the implement stage backend, provider and model when nothing is configured', async () => {
      const { service, aiService, stageAgent } = createService({
        omitConfig: true, implementBackend: 'cli', implementProvider: 'openai',
      });

      await run(service, true);

      expect(aiService.execute).not.toHaveBeenCalled();
      const call = stageAgent.runScreenshotPrompt.mock.calls[0][0];
      expect(call.backendOverride).toBe('cli');
      expect(call.providerOverride).toBe('openai');
      expect(call).not.toHaveProperty('modelOverride');
    });

    it('uses the raw adapter with no overrides when the implement backend is standard', async () => {
      const { service, aiService, stageAgent } = createService({
        omitConfig: true, implementBackend: 'standard', implementProvider: 'anthropic',
      });

      await run(service, true);

      expect(stageAgent.runScreenshotPrompt).not.toHaveBeenCalled();
      const request = aiService.execute.mock.calls[0][0];
      expect(request).not.toHaveProperty('provider');
      expect(request).not.toHaveProperty('model');
    });

    it('lets designConformance backend, provider and model win over the implement stage', async () => {
      const { service, aiService, stageAgent } = createService({
        omitConfig: false, implementBackend: 'cli', implementProvider: 'anthropic',
        target: { backend: 'standard', provider: 'openai', model: 'gpt-5.6-luna' },
      });

      await run(service, true);

      expect(stageAgent.runScreenshotPrompt).not.toHaveBeenCalled();
      const request = aiService.execute.mock.calls[0][0];
      expect(request.provider).toBe('openai');
      expect(request.model).toBe('gpt-5.6-luna');
    });

    it('fills only the missing fields from the implement stage', async () => {
      const { service, stageAgent } = createService({
        omitConfig: false, implementBackend: 'cli', implementProvider: 'anthropic',
        target: { model: 'claude-haiku-4-5-20251001' },
      });

      await run(service, true);

      const call = stageAgent.runScreenshotPrompt.mock.calls[0][0];
      expect(call.backendOverride).toBe('cli');
      expect(call.providerOverride).toBe('anthropic');
      expect(call.modelOverride).toBe('claude-haiku-4-5-20251001');
    });

    it('merges the config file fields over the enabled flag: maxScreenshots caps the calls', async () => {
      const { service, aiService, screenshotsStage } = createService({ maxScreenshots: 1, enabled: false });

      await service.check({
        paths: ['/d/a.png', '/d/b.png'], diff: sampleDiff, changedFiles: ['src/a.vue'], requested: true,
      });

      expect(screenshotsStage.encodeFromPaths).toHaveBeenCalledWith(['/d/a.png']);
      expect(aiService.execute).toHaveBeenCalledTimes(1);
    });

    it('merges backend, provider and model from the config file when enabled: false is overridden', async () => {
      const { service, aiService, stageAgent } = createService({
        enabled: false, implementBackend: 'standard', implementProvider: 'anthropic',
        target: { backend: 'cli', provider: 'openai', model: 'gpt-5.6-luna' },
      });

      await run(service, true);

      expect(aiService.execute).not.toHaveBeenCalled();
      const call = stageAgent.runScreenshotPrompt.mock.calls[0][0];
      expect(call.backendOverride).toBe('cli');
      expect(call.providerOverride).toBe('openai');
      expect(call.modelOverride).toBe('gpt-5.6-luna');
    });

    it('skips an implement-stage agent backend with openai just like an explicit one', async () => {
      const { service, aiService, stageAgent } = createService({
        omitConfig: true, implementBackend: 'agent', implementProvider: 'openai',
      });

      const findings = await run(service, true);

      expect(findings).toEqual([]);
      expect(aiService.execute).not.toHaveBeenCalled();
      expect(stageAgent.runScreenshotPrompt).not.toHaveBeenCalled();
    });
  });

  describe('mergeDesignConformanceConfig', () => {
    it.each([
      [undefined, undefined, undefined],
      [undefined, true, { enabled: true }],
      [{ enabled: false }, undefined, { enabled: false }],
      [{ enabled: false, model: 'm' }, true, { enabled: true, model: 'm' }],
      [{ maxScreenshots: 2, backend: 'cli' }, true, { maxScreenshots: 2, backend: 'cli', enabled: true }],
      [{ enabled: true, provider: 'openai', model: 'm' }, undefined, { enabled: true, provider: 'openai', model: 'm' }],
    ])('config %j with request %s → %j', (cfg, requested, expected) => {
      expect(mergeDesignConformanceConfig(cfg as never, requested)).toEqual(expected);
    });

    it('does not mutate the loaded config', () => {
      const cfg = { enabled: false, model: 'm' };

      mergeDesignConformanceConfig(cfg, true);

      expect(cfg).toEqual({ enabled: false, model: 'm' });
    });
  });

  describe('stage backends', () => {
    it.each([
      ['cli', 'anthropic', 'claude-haiku-4-5-20251001'],
      ['cli', 'openai', 'gpt-5.6-luna'],
      ['agent', 'anthropic', 'claude-haiku-4-5-20251001'],
    ])('routes backend %s with provider %s through the stage agent with overrides', async (backend, provider, model) => {
      const { service, aiService, stageAgent } = createService({ target: { backend, provider, model } });

      await service.check({
        paths: ['/d/a.png', '/d/b.png'], diff: sampleDiff, changedFiles: ['src/a.vue'], repoDir: '/repo',
      });

      expect(aiService.execute).not.toHaveBeenCalled();
      expect(stageAgent.runScreenshotPrompt).toHaveBeenCalledTimes(2);
      const call = stageAgent.runScreenshotPrompt.mock.calls[0][0];
      expect(call.backendOverride).toBe(backend);
      expect(call.providerOverride).toBe(provider);
      expect(call.modelOverride).toBe(model);
      expect(call.repoDir).toBe('/repo');
      expect(call.screenshots).toEqual([{ path: '/d/a.png', mediaType: 'image/png', base64: 'b64:/d/a.png' }]);
      expect(call.prompt).toContain('<button class="px-4">Save</button>');
    });

    it('omits provider and model overrides when only the backend is set and resolves the implement provider', async () => {
      const { service, stageAgent } = createService({ target: { backend: 'cli' }, implementProvider: 'openai' });

      await service.check({ paths: ['/d/a.png'], diff: sampleDiff, changedFiles: ['src/a.vue'], repoDir: '/repo' });

      const call = stageAgent.runScreenshotPrompt.mock.calls[0][0];
      expect(call.providerOverride).toBe('openai');
      expect(call).not.toHaveProperty('modelOverride');
    });

    it.each(['standard', undefined])('uses the raw adapter for backend %s', async backend => {
      const { service, aiService, stageAgent } = createService({ target: { backend } });

      await service.check({ paths: ['/d/a.png'], diff: sampleDiff, changedFiles: ['src/a.vue'] });

      expect(aiService.execute).toHaveBeenCalledTimes(1);
      expect(stageAgent.runScreenshotPrompt).not.toHaveBeenCalled();
    });

    it('skips the OpenAI agent backend with a named warning', async () => {
      const { service, aiService, stageAgent } = createService({
        target: { backend: 'agent', provider: 'openai', model: 'gpt-5.6-luna' },
      });

      const findings = await service.check({ paths: ['/d/a.png'], diff: sampleDiff, changedFiles: ['src/a.vue'] });

      expect(findings).toEqual([]);
      expect(aiService.execute).not.toHaveBeenCalled();
      expect(stageAgent.runScreenshotPrompt).not.toHaveBeenCalled();
      const lines = (console.log as jest.Mock).mock.calls.map(call => String(call[0]));
      expect(lines.some(line => line.includes('OpenAI agent backend cannot read screenshots'))).toBe(true);
    });

    it('skips a stage backend when no stage agent is available', async () => {
      const { service, aiService } = createService({ target: { backend: 'cli' }, withStageAgent: false });

      const findings = await service.check({ paths: ['/d/a.png'], diff: sampleDiff, changedFiles: ['src/a.vue'] });

      expect(findings).toEqual([]);
      expect(aiService.execute).not.toHaveBeenCalled();
      const lines = (console.log as jest.Mock).mock.calls.map(call => String(call[0]));
      expect(lines.some(line => line.includes("'cli' backend is unavailable"))).toBe(true);
    });

    it('turns a stage agent failure into a warning and keeps checking', async () => {
      const { service, stageAgent } = createService({ target: { backend: 'cli' } });
      stageAgent.runScreenshotPrompt
        .mockRejectedValueOnce(new Error('cli exploded'))
        .mockResolvedValueOnce({ content: JSON.stringify({ findings: [{ area: 'nav', deviation: 'missing' }] }) });

      const findings = await service.check({
        paths: ['/d/a.png', '/d/b.png'], diff: sampleDiff, changedFiles: ['src/a.vue'], repoDir: '/repo',
      });

      expect(findings).toEqual([{ screenshot: '/d/b.png', area: 'nav', deviation: 'missing' }]);
    });
  });

  it('makes no calls for an empty diff', async () => {
    const { service, aiService } = createService();

    const findings = await service.check({ paths: ['/d/a.png'], diff: '   \n', changedFiles: [] });

    expect(findings).toEqual([]);
    expect(aiService.execute).not.toHaveBeenCalled();
  });

  it('trims an oversize diff once and reuses it for every call', async () => {
    const { service, aiService } = createService();
    const hugeDiff = `diff --git a/src/a.vue b/src/a.vue\n${'+x'.repeat(200_000)}\n`;

    await service.check({ paths: ['/d/a.png', '/d/b.png'], diff: hugeDiff, changedFiles: ['src/a.vue'] });

    const prompts: string[] = aiService.execute.mock.calls.map(call => call[0].prompt);
    expect(prompts).toHaveLength(2);
    expect(prompts[0].length).toBeLessThan(hugeDiff.length);
    expect(prompts[0]).toContain('evidence gap');
    expect(prompts[0]).toBe(prompts[1]);
  });
});

describe('design conformance fix-round helpers', () => {
  const heroFinding = { screenshot: '/d/hero.png', area: 'Hero CTA', deviation: 'Button label is lowercase' };
  const navFinding = { screenshot: '/d/nav.png', area: 'Nav bar', deviation: 'Missing search icon' };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('builds a finding key from screenshot and normalised area', () => {
    expect(findingKey({ ...heroFinding, area: '  Hero CTA ' })).toBe('/d/hero.png::hero cta');
  });

  it('keeps current findings whose key existed in the previous round', () => {
    const reworded = { ...heroFinding, deviation: 'CTA text should be capitalised' };

    const pending = diffPendingFindings([heroFinding, navFinding], [reworded, { ...navFinding, area: 'Footer' }]);

    expect(pending).toEqual([reworded]);
  });

  it('returns no pending findings when the previous round was empty', () => {
    expect(diffPendingFindings([], [heroFinding])).toEqual([]);
  });

  it('builds a fix prompt listing only the pending findings with round and stall window', () => {
    const prompt = buildDesignConformanceFixPrompt({ pending: [heroFinding], round: 2, stallWindow: 3 });

    expect(prompt).toContain('round 2');
    expect(prompt).toContain('stall window: 3');
    expect(prompt).toContain('hero.png');
    expect(prompt).toContain('Hero CTA');
    expect(prompt).toContain('Button label is lowercase');
    expect(prompt).toContain('Fix only the deviations listed');
    expect(prompt).toContain('do not regress');
    expect(prompt).toContain('do not invent exact values');
    expect(prompt).not.toContain(navFinding.deviation);
  });
});
