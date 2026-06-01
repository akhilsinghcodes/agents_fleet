import fs from "node:fs";

export type ModelPricing = {
  inputPer1M: number;
  outputPer1M: number;
};

export type PricingConfig = {
  default: ModelPricing;
  models: Record<string, ModelPricing>;
};

// Best-effort defaults. Override via PRICING_JSON or PRICING_JSON_PATH.
export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  default: { inputPer1M: 3.0, outputPer1M: 15.0 },
  models: {
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
  },
};

let cachedPricing: PricingConfig | null = null;

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

type UnknownRecord = Record<string, unknown>;

function isRecord(v: unknown): v is UnknownRecord {
  return typeof v === "object" && v !== null;
}

function readModelPricing(v: unknown): ModelPricing | null {
  if (!isRecord(v)) return null;
  const inputPer1M = v.inputPer1M;
  const outputPer1M = v.outputPer1M;
  if (!isFiniteNumber(inputPer1M) || !isFiniteNumber(outputPer1M)) return null;
  return { inputPer1M, outputPer1M };
}

function normalizePricingConfig(raw: unknown): PricingConfig {
  const obj = isRecord(raw) ? (raw as UnknownRecord) : null;

  const fallback = DEFAULT_PRICING_CONFIG;

  const overrideDefault = readModelPricing(obj?.default);
  const safeDefault: ModelPricing = overrideDefault ?? fallback.default;

  const models: Record<string, ModelPricing> = { ...fallback.models };

  if (isRecord(obj?.models)) {
    for (const [model, p] of Object.entries(obj.models)) {
      const mp = readModelPricing(p);
      if (!mp) continue;
      models[model] = mp;
    }
  }

  return { default: safeDefault, models };
}

export function loadPricingConfig(): PricingConfig {
  if (cachedPricing) return cachedPricing;

  const jsonInline = process.env.PRICING_JSON;
  const jsonPath = process.env.PRICING_JSON_PATH;

  let raw: unknown = null;

  try {
    if (jsonInline && jsonInline.trim().length > 0) {
      raw = JSON.parse(jsonInline);
    } else if (jsonPath && jsonPath.trim().length > 0) {
      const file = fs.readFileSync(jsonPath, "utf8");
      raw = JSON.parse(file);
    }
  } catch {
    // Ignore parse errors and fall back to defaults.
    raw = null;
  }

  cachedPricing = normalizePricingConfig(raw);
  return cachedPricing;
}

export function resetPricingConfigCacheForTests() {
  cachedPricing = null;
}

export function getModelPricing(model: string): ModelPricing {
  const cfg = loadPricingConfig();
  return cfg.models[model] ?? cfg.default;
}
