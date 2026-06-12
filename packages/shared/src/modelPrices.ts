import modelsData from "../../../apps/server/src/models.json";
import modelPriceData from "../../../apps/server/src/model_price.json";

type ModelListFile = {
  data?: Array<{
    id?: unknown;
    object?: unknown;
  }>;
};

type LiteLlmModelsResponse = {
  data?: Array<{
    id?: unknown;
  }>;
};

type ModelPriceEntry = {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
};

const modelList = modelsData as ModelListFile;
const modelPriceEntries = modelPriceData as Record<string, ModelPriceEntry>;

/**
 * Fetch models from LITELLM_BASE_URL/v1/models endpoint.
 * This is used during build-time or server initialization.
 */
export async function fetchLiteLlmModelsFromApi(
  baseUrl: string,
  apiKey?: string
): Promise<ModelListFile | null> {
  try {
    const modelsUrl = new URL("/v1/models", baseUrl).toString();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // Add authorization header if API key is provided
    if (apiKey && apiKey.trim().length > 0) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const response = await fetch(modelsUrl, {
      method: "GET",
      headers,
      timeout: 5000,
    });

    if (response.ok) {
      const data = (await response.json()) as LiteLlmModelsResponse;
      if (data.data && data.data.length > 0) {
        return data as ModelListFile;
      }
    }
  } catch (error) {
    console.warn(
      `Failed to fetch models from LITELLM_BASE_URL: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return null;
}

export type ModelPriceLookup = {
  modelId: string;
  priceModelId: string | null;
  inputPer1M: number | null;
  outputPer1M: number | null;
};

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function claudePriceLookupKeys(modelId: string): string[] {
  return [
    modelId,
    `global.${modelId}`,
    `us.${modelId}`,
    `eu.${modelId}`,
    `apac.${modelId}`,
    `global.anthropic.${modelId}`,
    `us.anthropic.${modelId}`,
    `eu.anthropic.${modelId}`,
    `apac.anthropic.${modelId}`,
    `anthropic.${modelId}`,
    `global.anthropic.${modelId}-v1:0`,
    `us.anthropic.${modelId}-v1:0`,
    `eu.anthropic.${modelId}-v1:0`,
    `apac.anthropic.${modelId}-v1:0`,
    `anthropic.${modelId}-v1:0`,
    `${modelId}-v1:0`,
  ];
}

function lookupClaudePriceEntry(modelId: string): {
  priceModelId: string | null;
  inputPer1M: number | null;
  outputPer1M: number | null;
} {
  for (const key of claudePriceLookupKeys(modelId)) {
    const entry = modelPriceEntries[key];
    if (!entry) continue;
    if (
      typeof entry.input_cost_per_token !== "number" ||
      typeof entry.output_cost_per_token !== "number"
    ) {
      return { priceModelId: key, inputPer1M: null, outputPer1M: null };
    }
    return {
      priceModelId: key,
      inputPer1M: entry.input_cost_per_token * 1_000_000,
      outputPer1M: entry.output_cost_per_token * 1_000_000,
    };
  }
  return { priceModelId: null, inputPer1M: null, outputPer1M: null };
}

function toLookup(
  modelId: string,
  priceModelId: string | null,
  entry: ModelPriceEntry | undefined,
): ModelPriceLookup {
  if (
    !entry ||
    typeof entry.input_cost_per_token !== "number" ||
    typeof entry.output_cost_per_token !== "number"
  ) {
    return {
      modelId,
      priceModelId,
      inputPer1M: null,
      outputPer1M: null,
    };
  }

  return {
    modelId,
    priceModelId,
    inputPer1M: entry.input_cost_per_token * 1_000_000,
    outputPer1M: entry.output_cost_per_token * 1_000_000,
  };
}

function lookupLiteLlmPriceEntry(modelId: string): ModelPriceLookup {
  const exact = modelPriceEntries[modelId];
  if (exact) return toLookup(modelId, modelId, exact);

  const suffixMatches = Object.entries(modelPriceEntries)
    .filter(([key]) => key.endsWith(`/${modelId}`))
    .map(([key, entry]) => ({ key, entry }));

  if (suffixMatches.length !== 1) {
    return {
      modelId,
      priceModelId: null,
      inputPer1M: null,
      outputPer1M: null,
    };
  }

  const match = suffixMatches[0];
  return toLookup(modelId, match.key, match.entry);
}

export const CLAUDE_SDK_MODEL_OPTIONS = (modelList.data ?? [])
  .map((item) => item.id)
  .filter(isString)
  .sort((a, b) => a.localeCompare(b));

export const LITELLM_CHAT_MODEL_OPTIONS = (modelList.data ?? [])
  .map((item) => item.id)
  .filter(isString)
  .sort((a, b) => a.localeCompare(b));

export function getClaudeSdkModelPricing(modelId: string): ModelPriceLookup {
  const pricing = lookupClaudePriceEntry(modelId);
  return {
    modelId,
    priceModelId: pricing.priceModelId,
    inputPer1M: pricing.inputPer1M,
    outputPer1M: pricing.outputPer1M,
  };
}

export function getLiteLlmModelPricing(modelId: string): ModelPriceLookup {
  return lookupLiteLlmPriceEntry(modelId);
}

export type ClaudeSdkModelOption = (typeof CLAUDE_SDK_MODEL_OPTIONS)[number];
export type LiteLlmChatModelOption =
  (typeof LITELLM_CHAT_MODEL_OPTIONS)[number];
