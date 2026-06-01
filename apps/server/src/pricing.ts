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
let cachedPricingSource: "api" | "json" | "default" | null = null;
let apiCache: {
  cfg: PricingConfig;
  fetchedAtMs: number;
  expiresAtMs: number;
} | null = null;
let apiLastErrorAtMs: number | null = null;

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

function parsePositiveInt(v: string | undefined | null): number | null {
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function parseHeadersJson(
  v: string | undefined | null,
): Record<string, string> | null {
  if (!v || v.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(v) as unknown;
    if (!isRecord(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(parsed)) {
      if (typeof val === "string") out[k] = val;
    }
    return out;
  } catch {
    return null;
  }
}

async function fetchPricingFromApiBestEffort(): Promise<PricingConfig | null> {
  const url = process.env.PRICING_API_URL;
  if (!url || url.trim().length === 0) return null;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("PRICING_API_URL is not a valid URL");
  }

  if (parsedUrl.protocol !== "https:") {
    throw new Error("PRICING_API_URL must be https");
  }

  const ttlMs = parsePositiveInt(process.env.PRICING_API_TTL_MS) ?? 60_000;
  const timeoutMs =
    parsePositiveInt(process.env.PRICING_API_TIMEOUT_MS) ?? 2_000;

  const now = Date.now();
  if (apiCache && now < apiCache.expiresAtMs) return apiCache.cfg;

  // Serve stale cache if we're offline; we'll attempt a refresh but fall back.
  const stale = apiCache?.cfg ?? null;

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  const auth = process.env.PRICING_API_HEADER_AUTH;
  if (auth && auth.trim().length > 0) headers.Authorization = auth;

  const extraHeaders = parseHeadersJson(process.env.PRICING_API_HEADERS_JSON);
  if (extraHeaders) Object.assign(headers, extraHeaders);

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const res = await fetch(parsedUrl.toString(), {
      method: "GET",
      headers,
      signal: ac.signal,
    });

    if (!res.ok) {
      throw new Error(`Pricing API returned ${res.status}`);
    }

    const json = (await res.json()) as unknown;
    const cfg = normalizePricingConfig(json);

    apiCache = {
      cfg,
      fetchedAtMs: now,
      expiresAtMs: now + ttlMs,
    };

    return cfg;
  } catch (e) {
    if (stale) return stale;
    throw e;
  } finally {
    clearTimeout(t);
  }
}

function loadPricingFromJsonEnvBestEffort(): PricingConfig | null {
  const jsonInline = process.env.PRICING_JSON;
  const jsonPath = process.env.PRICING_JSON_PATH;

  let raw: unknown = null;

  try {
    if (jsonInline && jsonInline.trim().length > 0) {
      raw = JSON.parse(jsonInline);
    } else if (jsonPath && jsonPath.trim().length > 0) {
      const file = fs.readFileSync(jsonPath, "utf8");
      raw = JSON.parse(file);
    } else {
      return null;
    }
  } catch {
    return null;
  }

  return normalizePricingConfig(raw);
}

export function loadPricingConfig(): PricingConfig {
  if (cachedPricing) return cachedPricing;

  // We keep this sync for callsites; the API fetch is best-effort and cached
  // once it succeeds.
  cachedPricing = DEFAULT_PRICING_CONFIG;
  cachedPricingSource = "default";

  return cachedPricing;
}

export async function loadPricingConfigAsync(): Promise<PricingConfig> {
  // If we already have cached pricing, only force-refresh if the current source
  // is NOT the API (API has its own TTL-based cache).
  if (cachedPricing && cachedPricingSource === "api") return cachedPricing;

  // 1) Remote API (best-effort)
  try {
    const cfg = await fetchPricingFromApiBestEffort();
    if (cfg) {
      cachedPricing = cfg;
      cachedPricingSource = "api";
      return cfg;
    }
  } catch (e) {
    // Rate-limit noisy logs.
    const now = Date.now();
    const last = apiLastErrorAtMs;
    if (last == null || now - last > 60_000) {
      apiLastErrorAtMs = now;
      console.warn(`[pricing] Failed to load pricing from API: ${String(e)}`);
    }
  }

  // 2) Local JSON env/file override
  const jsonCfg = loadPricingFromJsonEnvBestEffort();
  if (jsonCfg) {
    cachedPricing = jsonCfg;
    cachedPricingSource = "json";
    return jsonCfg;
  }

  // 3) Defaults
  cachedPricing = DEFAULT_PRICING_CONFIG;
  cachedPricingSource = "default";
  return cachedPricing;
}

export function resetPricingConfigCacheForTests() {
  cachedPricing = null;
  cachedPricingSource = null;
  apiCache = null;
  apiLastErrorAtMs = null;
}

export function getModelPricing(model: string): ModelPricing {
  const cfg = loadPricingConfig();
  return cfg.models[model] ?? cfg.default;
}

export async function getModelPricingAsync(
  model: string,
): Promise<ModelPricing> {
  const cfg = await loadPricingConfigAsync();
  return cfg.models[model] ?? cfg.default;
}
