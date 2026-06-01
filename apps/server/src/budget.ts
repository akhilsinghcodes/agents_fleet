// NOTE: These are fallback/default prices used only when we don't have a
// model-specific entry. Prefer computeModelCostUsd.
export const DEFAULT_INPUT_COST_PER_1M = 3.0;
export const DEFAULT_OUTPUT_COST_PER_1M = 15.0;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export type ModelPricing = {
  inputPer1M: number;
  outputPer1M: number;
};

// Best-effort pricing table. Keep this in sync with your org's model access.
// If a model isn't found, we fall back to DEFAULT_*.
const MODEL_PRICING_USD_PER_1M: Record<string, ModelPricing> = {
  // Claude 3
  "claude-3-haiku-20240307": { inputPer1M: 0.25, outputPer1M: 1.25 },

  // Claude 4 family (placeholder best-effort values; update to your contract/pricing)
  // Using conservative-ish defaults to avoid under-enforcing budgets.
  "claude-haiku-4-5": { inputPer1M: 1.0, outputPer1M: 5.0 },
  "claude-haiku-4-5-20251001": { inputPer1M: 1.0, outputPer1M: 5.0 },

  "claude-sonnet-4-0": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-sonnet-4-20250514": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-sonnet-4-5": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-sonnet-4-5-20250929": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-sonnet-4-6": { inputPer1M: 3.0, outputPer1M: 15.0 },

  "claude-opus-4-0": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-opus-4-1": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-opus-4-1-20250805": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-opus-4-20250514": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-opus-4-5": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-opus-4-5-20251101": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-opus-4-6": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-opus-4-7": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-opus-4-8": { inputPer1M: 15.0, outputPer1M: 75.0 },

  "claude-mythos-preview": { inputPer1M: 3.0, outputPer1M: 15.0 },
};

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
  const p = MODEL_PRICING_USD_PER_1M[args.model];
  const inputPer1M = p?.inputPer1M ?? DEFAULT_INPUT_COST_PER_1M;
  const outputPer1M = p?.outputPer1M ?? DEFAULT_OUTPUT_COST_PER_1M;
  return (
    (args.inputTokens / 1_000_000) * inputPer1M +
    (args.outputTokens / 1_000_000) * outputPer1M
  );
}
