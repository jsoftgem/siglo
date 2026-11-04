import type { AiProvider, TokenPricing } from './types';

/** Baseline text-token USD rates per million, verified 2026-11-04. No discounts/tier adjustments. */
export const TOKEN_PRICES: Readonly<Record<string, Readonly<TokenPricing>>> = Object.freeze({
  'openai:gpt-4o': Object.freeze({ inputPerMillion: 2.5, outputPerMillion: 10 }),
  'openai:gpt-4o-mini': Object.freeze({ inputPerMillion: 0.15, outputPerMillion: 0.6 }),
  'anthropic:claude-sonnet-4-6': Object.freeze({ inputPerMillion: 3, outputPerMillion: 15 }),
  'gemini:gemini-2.5-flash-lite': Object.freeze({ inputPerMillion: 0.1, outputPerMillion: 0.4 })
});
export function estimateTokenCost(provider: AiProvider, model: string, input: number, output: number, override?: TokenPricing): number | undefined {
  const price = override ?? TOKEN_PRICES[`${provider}:${model}`];
  if (!price) return undefined;
  for (const value of [input, output, price.inputPerMillion, price.outputPerMillion]) {
    if (!Number.isFinite(value) || value < 0) throw new TypeError('Token usage and prices must be non-negative finite numbers');
  }
  return (input * price.inputPerMillion + output * price.outputPerMillion) / 1_000_000;
}
