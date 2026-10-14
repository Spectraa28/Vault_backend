import { type BaseLlm, Gemini } from '@google/adk';
import type { Config } from '../config.js';
import { FallbackLlm } from './fallback.js';
import { OpenAICompatLlm } from './openai-compat.js';

/**
 * The model chain, in order of preference. Groq first when a key is present, because its
 * free allowance is the largest; Gemini after it; OpenRouter's free models last, as the smallest
 * allowance. A provider that runs dry hands over to the next.
 */
export function buildModel(cfg: Config): FallbackLlm {
  const chain: BaseLlm[] = [];
  // Groq's free daily allowance is per model, so each extra model is another day's worth of play.
  if (cfg.GROQ_API_KEY) for (const model of cfg.GROQ_MODEL.split(',').map((m) => m.trim()).filter(Boolean)) {
    // Characters answer in a sentence or two; a long private deliberation first only adds seconds.
    const extraBody = /gpt-oss/.test(model) ? { reasoning_effort: 'low' } : /qwen3/.test(model) ? { reasoning_effort: 'none' } : undefined;
    chain.push(new OpenAICompatLlm({ provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: cfg.GROQ_API_KEY, model, extraBody }));
  }
  for (const model of cfg.GEMINI_MODEL.split(',').map((m) => m.trim()).filter(Boolean)) chain.push(new Gemini({ model, apiKey: cfg.GEMINI_API_KEY }));
  if (cfg.OPENROUTER_API_KEY) chain.push(new OpenAICompatLlm({ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: cfg.OPENROUTER_API_KEY, model: cfg.OPENROUTER_MODEL }));
  return new FallbackLlm(chain);
}
