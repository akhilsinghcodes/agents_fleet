import { getModelPricing } from "./pricing";

// NOTE: These are fallback/default prices used only when we don't have a
// model-specific entry. Prefer computeModelCostUsd.
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

export function computeModelCostUsd(args: {
  model: string;
  inputTokens: number;
  outputTokens: number;
}) {
  const p = getModelPricing(args.model);
  const inputPer1M = p?.inputPer1M ?? DEFAULT_INPUT_COST_PER_1M;
  const outputPer1M = p?.outputPer1M ?? DEFAULT_OUTPUT_COST_PER_1M;
  return (
    (args.inputTokens / 1_000_000) * inputPer1M +
    (args.outputTokens / 1_000_000) * outputPer1M
  );
}
