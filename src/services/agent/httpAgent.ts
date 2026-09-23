import { planOpenAICompatible, type LLMPlan } from './llmClient';

export type HttpPlan = LLMPlan;

/** 三方兼容通道（OpenAI-compatible /chat/completions）。保留旧名供调用方使用。 */
export async function planHttp(
  input: string,
  opts: { baseUrl: string; model: string; apiKey: string },
): Promise<HttpPlan> {
  return planOpenAICompatible(input, { kind: 'custom', ...opts });
}
