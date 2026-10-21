import * as path from 'node:path';
import { ConfigService } from '@nestjs/config';
import { Inject, Injectable, Optional } from '@nestjs/common';
import chalk from 'chalk';
import { AiService, parseJsonResponse } from '../integrations/ai/ai.service';
import { StageAgentService } from '../integrations/ai/stage-agent.service';
import { UiDesignScreenshotsStageService } from '../review/ui-design-screenshots-stage.service';
import { appendToLogFile } from '../common/logger/log-file-writer';
import {
  designConformanceResponseJsonSchema,
  designConformanceResponseSchema,
} from '../common/schemas/design-conformance.schema';
import type { AIRequest } from '../common/types/ai.types';
import type { DesignConformanceFinding } from '../common/types/design-conformance.types';
import type { WfAiProviderName, WfBackendMode, WfImplementStageConfig } from '../common/types/config.types';
import type { UiDesignScreenshot } from '../common/types/ui-design-screenshot';
import { sliceHeadTail } from './plan-step-evidence-budget';

const LOG_CONTEXT = 'design-check';
const MAX_DIFF_CHARS = 80_000;
const CALL_TIMEOUT_IN_MS = 120_000;
const MAX_OUTPUT_TOKENS = 1024;

const taskInstructions = [
  'You are given one design screenshot (attached) and the code diff an engineer wrote to implement it.',
  'Compare the diff to the screenshot and list concrete deviations you can confirm from the diff alone:',
  'missing or extra elements, wrong copy or label casing, wrong component or affordance type,',
  'missing states, and clearly wrong layout structure.',
  'Do NOT guess exact pixel, colour, spacing, or typography values; only report them if the diff states a',
  'value that visibly contradicts the screenshot. Do NOT report style or naming preferences.',
  'Return {"findings":[]} when nothing contradicts the screenshot.',
].join('\n');

const buildPrompt = (diff: string, changedFiles: string[]): string => {
  const files = changedFiles.length > 0 ? changedFiles.map(file => `- ${file}`).join('\n') : '- (none listed)';
  return `## Changed files\n\n${files}\n\n## Diff\n\n${diff}\n\n## Your task\n\n${taskInstructions}`;
};

type DesignConformanceConfig = NonNullable<WfImplementStageConfig['designConformance']>;

type ConformanceTarget = { provider?: WfAiProviderName; model?: string; backend?: WfBackendMode };

type CheckParams = { paths: string[]; diff: string; changedFiles: string[]; repoDir?: string; requested?: boolean };

export const mergeDesignConformanceConfig = (
  cfg: DesignConformanceConfig | undefined, requested?: boolean,
): DesignConformanceConfig | undefined => (requested ? { ...cfg, enabled: true } : cfg);

type CheckRun = { prompt: string; target: ConformanceTarget; repoDir?: string };

const visionProviders: WfAiProviderName[] = ['anthropic', 'openai'];

const stageBackends: WfBackendMode[] = ['agent', 'cli'];

const stageSystemPrompt = 'You compare design screenshots with code diffs and reply only with the requested JSON.';

const structuredOutput = { name: 'design_conformance', schema: designConformanceResponseJsonSchema };

const buildRequest = (screenshot: UiDesignScreenshot, prompt: string, target: ConformanceTarget): AIRequest => ({
  prompt, stage: 'implement', temperature: 0, maxTokens: MAX_OUTPUT_TOKENS,
  ...(target.provider && { provider: target.provider }), ...(target.model && { model: target.model }),
  context: { screenshots: [screenshot] },
  structuredOutput,
});

const isStageBackend = (backend: WfBackendMode | undefined): boolean =>
  Boolean(backend && stageBackends.includes(backend));

const toMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const withTimeout = async <T>(work: Promise<T>, timeoutInMs: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutInMs}ms`)), timeoutInMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

@Injectable()
export class UiDesignScreenshotConformanceService {
  constructor(
    private readonly aiService: AiService,
    private readonly configService: ConfigService,
    private readonly screenshotsStage: UiDesignScreenshotsStageService,
    @Optional() @Inject(StageAgentService) private readonly stageAgentService?: StageAgentService,
  ) {}

  async check(params: CheckParams): Promise<DesignConformanceFinding[]> {
    const { paths, diff, changedFiles, repoDir, requested } = params;
    const cfg = this.loadConfig(requested);
    if (!cfg?.enabled || paths.length === 0) return [];
    const target = this.resolveTarget(cfg);
    const skipReason = this.resolveSkipReason(diff, target);
    if (skipReason) {
      this.warn(`design conformance check skipped: ${skipReason}`);
      return [];
    }
    const screenshots = this.selectScreenshots(paths, cfg.maxScreenshots);
    const prompt = buildPrompt(sliceHeadTail(diff, MAX_DIFF_CHARS), changedFiles);
    return this.checkSequentially(screenshots, { prompt, target, repoDir });
  }

  private loadConfig(requested: boolean | undefined): DesignConformanceConfig | undefined {
    return mergeDesignConformanceConfig(
      this.configService.get<DesignConformanceConfig>('stages.implement.designConformance'), requested,
    );
  }

  private resolveTarget(cfg: DesignConformanceConfig): ConformanceTarget {
    const implementProvider = this.configService.get<WfAiProviderName>('stages.implement.provider');
    const provider = cfg.provider ?? (cfg.model ? implementProvider : undefined);
    const backend = cfg.backend ?? this.configService.get<WfBackendMode>('stages.implement.backend');
    return { provider, model: cfg.model, backend };
  }

  private resolveEffectiveProvider(target: ConformanceTarget): WfAiProviderName {
    return target.provider
      ?? this.configService.get<WfAiProviderName>('stages.implement.provider')
      ?? this.configService.get<WfAiProviderName>('ai.provider')
      ?? 'anthropic';
  }

  private resolveSkipReason(diff: string, target: ConformanceTarget): string | undefined {
    const provider = this.resolveEffectiveProvider(target);
    if (!visionProviders.includes(provider)) {
      return `provider '${provider}' cannot read screenshots; set designConformance.provider to anthropic or openai.`;
    }
    if (target.backend === 'agent' && provider === 'openai') {
      return "the OpenAI agent backend cannot read screenshots; use backend 'cli' or 'standard' with provider 'openai'.";
    }
    if (isStageBackend(target.backend) && !this.stageAgentService) {
      return `the '${target.backend}' backend is unavailable in this context.`;
    }
    return diff.trim() ? undefined : 'the diff is empty.';
  }

  private selectScreenshots(paths: string[], maxScreenshots: number | undefined): UiDesignScreenshot[] {
    const limit = maxScreenshots ?? paths.length;
    const skipped = Math.max(0, paths.length - limit);
    if (skipped > 0) this.info(`maxScreenshots=${limit}: skipped ${skipped} of ${paths.length} screenshot(s).`);
    return this.screenshotsStage.encodeFromPaths(paths.slice(0, limit)).screenshots;
  }

  private async checkSequentially(
    screenshots: UiDesignScreenshot[], run: CheckRun,
  ): Promise<DesignConformanceFinding[]> {
    const findings: DesignConformanceFinding[] = [];
    for (const [index, screenshot] of screenshots.entries()) {
      console.log(chalk.gray(`  [design-check] ${index + 1}/${screenshots.length} ${path.basename(screenshot.path)}`));
      findings.push(...await this.checkOne(screenshot, run));
    }
    return findings;
  }

  private requestReply(screenshot: UiDesignScreenshot, run: CheckRun): Promise<{ content: string }> {
    const { prompt, target, repoDir } = run;
    if (!isStageBackend(target.backend) || !this.stageAgentService) {
      return this.aiService.execute(buildRequest(screenshot, prompt, target));
    }
    const provider = this.resolveEffectiveProvider(target);
    return this.stageAgentService.runScreenshotPrompt({
      prompt, systemPrompt: stageSystemPrompt, screenshots: [screenshot], structuredOutput, repoDir,
      backendOverride: target.backend,
      ...(provider === 'anthropic' || provider === 'openai' ? { providerOverride: provider } : {}),
      ...(target.model && { modelOverride: target.model }),
    });
  }

  private async checkOne(screenshot: UiDesignScreenshot, run: CheckRun): Promise<DesignConformanceFinding[]> {
    try {
      const response = await withTimeout(this.requestReply(screenshot, run), CALL_TIMEOUT_IN_MS);
      const { findings } = designConformanceResponseSchema.parse(parseJsonResponse(response.content));
      return findings.map(finding => ({ screenshot: screenshot.path, ...finding }));
    } catch (error) {
      this.warn(`check failed for ${screenshot.path}: ${toMessage(error)}`);
      return [];
    }
  }

  private info(message: string): void {
    console.log(chalk.gray(`  [design-check] ${message}`));
    appendToLogFile('INFO', message, LOG_CONTEXT);
  }

  private warn(message: string): void {
    console.log(chalk.yellow(`  [design-check] ${message}`));
    appendToLogFile('WARN', message, LOG_CONTEXT);
  }
}
