import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { AIModule } from './ai.module';
import { AnthropicAdapter } from './adapters/anthropic.adapter';
import { OpenAIAdapter } from './adapters/openai.adapter';
import { GeminiAdapter } from './adapters/gemini.adapter';
import { DeepSeekAdapter } from './adapters/deepseek.adapter';

jest.mock('./adapters/load-ai-context-config', () => ({
  loadAiContextConfig: jest.fn().mockResolvedValue(''),
}));

describe('AIModule', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('registers each adapter as a singleton (no duplicate instances)', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [() => ({ ai: { providers: [] } })] }),
        AIModule,
      ],
    }).compile();

    const anthropic1 = module.get(AnthropicAdapter);
    const anthropic2 = module.get(AnthropicAdapter);
    expect(anthropic1).toBe(anthropic2);

    const openai1 = module.get(OpenAIAdapter);
    const openai2 = module.get(OpenAIAdapter);
    expect(openai1).toBe(openai2);

    const gemini1 = module.get(GeminiAdapter);
    const gemini2 = module.get(GeminiAdapter);
    expect(gemini1).toBe(gemini2);

    const deepseek1 = module.get(DeepSeekAdapter);
    const deepseek2 = module.get(DeepSeekAdapter);
    expect(deepseek1).toBe(deepseek2);

    await module.close();
  });
});
