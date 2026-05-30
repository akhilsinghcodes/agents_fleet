export const DEFAULT_INPUT_COST_PER_1M = 3.0;
export const DEFAULT_OUTPUT_COST_PER_1M = 15.0;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function computeCostUsd(inputTokens: number, outputTokens: number) {
  const inputCost = (inputTokens / 1_000_000) * DEFAULT_INPUT_COST_PER_1M;
  const outputCost = (outputTokens / 1_000_000) * DEFAULT_OUTPUT_COST_PER_1M;
  return inputCost + outputCost;
}

