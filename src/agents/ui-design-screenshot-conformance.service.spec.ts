import { ConfigService } from '@nestjs/config';
import { AiService } from '../integrations/ai/ai.service';
import { UiDesignScreenshotsStageService } from '../review/ui-design-screenshots-stage.service';
import { UiDesignScreenshotConformanceService } from './ui-design-screenshot-conformance.service';

type MockConfig = {
  enabled?: boolean;
  maxScreenshots?: number;
  omitConfig?: boolean;
  planStepVerification?: { provider?: string; model?: string };
  implementProvider?: string;
};

const sampleDiff = 'diff --git a/src/a.vue b/src/a.vue\n+<button class="px-4">Save</button>\n';

const createMockConfigService = (cfg: MockConfig = {}): ConfigService => {
  const values: Record<string, unknown> = {
    'stages.implement.designConformance': cfg.omitConfig
      ? undefined
      : { enabled: cfg.enabled ?? true, maxScreenshots: cfg.maxScreenshots },
    'stages.implement.planStepVerification': cfg.planStepVerification,
    'stages.implement.provider': cfg.implementProvider,
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

const createService = (cfg: MockConfig = {}) => {
  const aiService = createMockAiService();
  const screenshotsStage = createMockScreenshotsStage();
  const service = new UiDesignScreenshotConformanceService(
    aiService as unknown as AiService,
    createMockConfigService(cfg),
    screenshotsStage as unknown as UiDesignScreenshotsStageService,
  );
  return { service, aiService, screenshotsStage };
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

    await service.check(['/d/a.png', '/d/b.png'], sampleDiff, ['src/a.vue']);

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

  it('uses planStepVerification provider and model when both are set', async () => {
    const { service, aiService } = createService({
      planStepVerification: { provider: 'openai', model: 'gpt-custom' },
    });

    await service.check(['/d/a.png'], sampleDiff, ['src/a.vue']);

    const request = aiService.execute.mock.calls[0][0];
    expect(request.provider).toBe('openai');
    expect(request.model).toBe('gpt-custom');
  });

  it('uses the implement stage provider when only planStepVerification.model is set', async () => {
    const { service, aiService } = createService({
      planStepVerification: { model: 'claude-custom' }, implementProvider: 'anthropic',
    });

    await service.check(['/d/a.png'], sampleDiff, ['src/a.vue']);

    const request = aiService.execute.mock.calls[0][0];
    expect(request.provider).toBe('anthropic');
    expect(request.model).toBe('claude-custom');
  });

  it('makes no calls and warns when the resolved provider cannot read screenshots', async () => {
    const { service, aiService } = createService({ planStepVerification: { provider: 'google', model: 'g' } });

    const findings = await service.check(['/d/a.png'], sampleDiff, ['src/a.vue']);

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

    await service.check(['/d/a.png', '/d/b.png', '/d/c.png'], sampleDiff, ['src/a.vue']);

    expect(maxInFlight).toBe(1);
    const order = aiService.execute.mock.calls.map(call => call[0].context.screenshots[0].path);
    expect(order).toEqual(['/d/a.png', '/d/b.png', '/d/c.png']);
  });

  it('prints a progress line per screenshot', async () => {
    const { service } = createService();

    await service.check(['/d/a.png', '/d/b.png'], sampleDiff, ['src/a.vue']);

    const lines = (console.log as jest.Mock).mock.calls.map(call => String(call[0]));
    expect(lines.some(line => line.includes('[design-check] 1/2 a.png'))).toBe(true);
    expect(lines.some(line => line.includes('[design-check] 2/2 b.png'))).toBe(true);
  });

  it('returns findings tagged with the screenshot path', async () => {
    const { service, aiService } = createService();
    aiService.execute.mockResolvedValueOnce({
      content: JSON.stringify({ findings: [{ area: 'header', deviation: 'padding differs' }] }),
    });

    const findings = await service.check(['/d/a.png'], sampleDiff, ['src/a.vue']);

    expect(findings).toEqual([{ screenshot: '/d/a.png', area: 'header', deviation: 'padding differs' }]);
  });

  it('turns a failing call into a warning and still checks later screenshots', async () => {
    const { service, aiService } = createService();
    aiService.execute
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce({
        content: JSON.stringify({ findings: [{ area: 'footer', deviation: 'wrong colour' }] }),
      });

    const findings = await service.check(['/d/a.png', '/d/b.png'], sampleDiff, ['src/a.vue']);

    expect(aiService.execute).toHaveBeenCalledTimes(2);
    expect(findings).toEqual([{ screenshot: '/d/b.png', area: 'footer', deviation: 'wrong colour' }]);
    const lines = (console.log as jest.Mock).mock.calls.map(call => String(call[0]));
    expect(lines.some(line => line.includes('rate limited'))).toBe(true);
  });

  it('turns an unparseable response into a warning', async () => {
    const { service, aiService } = createService();
    aiService.execute.mockResolvedValueOnce({ content: 'not json' });

    const findings = await service.check(['/d/a.png'], sampleDiff, ['src/a.vue']);

    expect(findings).toEqual([]);
  });

  it('caps screenshots at maxScreenshots and logs how many were skipped', async () => {
    const { service, aiService } = createService({ maxScreenshots: 2 });

    await service.check(['/d/a.png', '/d/b.png', '/d/c.png', '/d/d.png'], sampleDiff, ['src/a.vue']);

    expect(aiService.execute).toHaveBeenCalledTimes(2);
    const lines = (console.log as jest.Mock).mock.calls.map(call => String(call[0]));
    expect(lines.some(line => line.includes('skipped 2'))).toBe(true);
  });

  it.each([
    ['disabled', { enabled: false }],
    ['unconfigured', { omitConfig: true }],
  ])('makes no calls when %s', async (_name, cfg) => {
    const { service, aiService } = createService(cfg);

    const findings = await service.check(['/d/a.png'], sampleDiff, ['src/a.vue']);

    expect(findings).toEqual([]);
    expect(aiService.execute).not.toHaveBeenCalled();
  });

  it('makes no calls when there are no screenshots', async () => {
    const { service, aiService } = createService();

    const findings = await service.check([], sampleDiff, ['src/a.vue']);

    expect(findings).toEqual([]);
    expect(aiService.execute).not.toHaveBeenCalled();
  });

  it('makes no calls for an empty diff', async () => {
    const { service, aiService } = createService();

    const findings = await service.check(['/d/a.png'], '   \n', []);

    expect(findings).toEqual([]);
    expect(aiService.execute).not.toHaveBeenCalled();
  });

  it('trims an oversize diff once and reuses it for every call', async () => {
    const { service, aiService } = createService();
    const hugeDiff = `diff --git a/src/a.vue b/src/a.vue\n${'+x'.repeat(200_000)}\n`;

    await service.check(['/d/a.png', '/d/b.png'], hugeDiff, ['src/a.vue']);

    const prompts: string[] = aiService.execute.mock.calls.map(call => call[0].prompt);
    expect(prompts).toHaveLength(2);
    expect(prompts[0].length).toBeLessThan(hugeDiff.length);
    expect(prompts[0]).toContain('evidence gap');
    expect(prompts[0]).toBe(prompts[1]);
  });
});
