# LiteLLM Models Loading Refactor

## Overview
Changed the model loading logic to **first attempt fetching from `LITELLM_BASE_URL/models`**, falling back to `models.json` if unavailable.

## Changes Made

### 1. **Backend: `apps/server/src/litellm.ts`**

**Added:**
- `fetchAvailableModels()` - Async function that:
  - Attempts to fetch models from `LITELLM_BASE_URL/v1/models` endpoint
  - Includes authorization header if `LITELLM_API_KEY` is set
  - Includes 5-second timeout for API calls
  - Logs successful fetch or fallback to console
  - Returns Set of model IDs from API or falls back to `models.json`

- `getValidModelIds()` - Public async function:
  - Initializes and caches the model list on first call
  - Returns Promise<Set<string>> of valid model IDs
  - Subsequent calls return cached result

- `getValidModelIdsSync()` - Helper function:
  - Synchronously returns cached model IDs
  - Used in `isValidLiteLlmModel()` for request validation
  - Falls back to `models.json` during startup before async initialization

**Modified:**
- `isValidLiteLlmModel()` - Now uses sync cache function

**Type additions:**
- `LiteLlmModelsResponse` - Type for API response from LITELLM_BASE_URL

### 2. **App Initialization: `apps/server/src/app.ts`**

**Added:**
- Import of `getValidModelIds` from litellm module
- Initialization call in `createApp()` to fetch models at startup
- Error handling that logs failures but doesn't block app startup

### 3. **Shared: `packages/shared/src/modelPrices.ts`**

**Added:**
- `fetchLiteLlmModelsFromApi(baseUrl, apiKey?)` - Public async function for fetching models from API
  - Takes optional `apiKey` parameter for authorization
  - Type definition `LiteLlmModelsResponse`
  - Can be used if future model list updates are needed on the frontend

### 4. **Error Messages: `apps/server/src/routes/litellm.ts`**

**Updated:**
- Model validation error now says: `"model is not available in LITELLM_BASE_URL or models.json"`
- Previously: `"model must match apps/server/src/models.json"`

## Flow Diagram

```
BACKEND STARTUP
┌─────────────────────────────────────────────────────┐
│  App Startup (app.ts)                               │
│  - Calls getValidModelIds()                         │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
        ┌──────────────────────────┐
        │ getValidModelIds()       │
        │ (async, cached)          │
        └──────────────────────────┘
                   │
                   ▼
        ┌──────────────────────────────────────┐
        │ fetchAvailableModels()               │
        └──────────────────────────────────────┘
                   │
        ┌──────────┴──────────┐
        │                     │
        ▼                     ▼
┌─────────────────────┐  ┌──────────────┐
│ LITELLM_BASE_URL/   │  │ Timeout/     │
│ v1/models endpoint  │  │ Failure      │
└──────────┬──────────┘  └──────┬───────┘
           │                    │
        SUCCESS              FALLBACK
           │                    │
           ▼                    ▼
      ┌─────────┐          ┌──────────────┐
      │ API     │          │ models.json  │
      │ Models  │          │ (file)       │
      └────┬────┘          └────┬─────────┘
           │                    │
           └──────────┬─────────┘
                      ▼
          ┌─────────────────────────┐
          │ MODEL_IDS Set (cached)  │
          └────────────┬────────────┘
                       │
         ┌─────────────┴───────────────────┐
         │                                 │
         ▼                                 ▼
    ┌──────────────────┐        ┌──────────────────┐
    │ GET /api/        │        │ isValidLiteLlmModel()
    │ litellm/models   │        │ (for validation) │
    └──────────────────┘        └──────────────────┘
         │
         ▼
FRONTEND
┌─────────────────────────────┐
│ LiteLLMChat mounted         │
│ - Calls /api/litellm/models │
└────────────┬────────────────┘
             │
             ▼
    ┌────────────────────┐
    │ availableModels    │
    │ state updated      │
    └────────────────────┘
             │
             ▼
    ┌────────────────────┐
    │ Model dropdown     │
    │ shows 5 models     │
    │ from LiteLLM       │
    └────────────────────┘
```

## Key Features

✅ **Non-blocking:** App startup doesn't wait for API fetch
✅ **Graceful fallback:** Uses `models.json` if API unavailable
✅ **Caching:** Model list cached after first fetch
✅ **Sync validation:** Request handlers use cached sync function
✅ **Logging:** Console output shows fetch success or fallback
✅ **Error handling:** API failures don't crash app, just log warning

## Behavior by Scenario

| Scenario | Behavior |
|----------|----------|
| LITELLM_BASE_URL configured & API responsive | Uses models from API endpoint |
| LITELLM_BASE_URL configured but API down | Logs warning, falls back to models.json |
| LITELLM_BASE_URL not set | Uses models.json directly |
| API returns empty list | Falls back to models.json |
| API timeout (5s) | Falls back to models.json |

## Testing Checklist

- [ ] Start server with `LITELLM_BASE_URL` pointing to live service
  - Verify console shows: `[LiteLLM] Loaded X models from ...`
- [ ] Start server with `LITELLM_BASE_URL` pointing to invalid endpoint
  - Verify console shows warning and fallback message
- [ ] Start server without `LITELLM_BASE_URL` env var
  - Verify it uses models.json without errors
- [ ] Create LiteLLM session with valid model from API
  - Should succeed
- [ ] Create LiteLLM session with model not in API/models.json
  - Should fail with updated error message
- [ ] Verify existing models.json-based flows still work

## Frontend Changes

**File: `apps/web/src/LiteLLMChat.tsx`**

Updated to dynamically fetch models from the backend at component mount:
- Added `availableModels` state (defaults to `LITELLM_CHAT_MODEL_OPTIONS` for fallback)
- Added `useEffect` hook that calls `/api/litellm/models` endpoint
- Updated model dropdown to use `availableModels` instead of static `LITELLM_CHAT_MODEL_OPTIONS`
- Falls back gracefully to static list if fetch fails

**File: `apps/server/src/routes/litellm.ts`**

Added new endpoint:
- `GET /api/litellm/models` - Returns `{ models: string[] }`
- Calls `getValidModelIds()` to get the cached/fetched model list
- Returns sorted array of model IDs

## Migration Notes

- Zero breaking changes
- Fully backward compatible
- Existing deployments work without env var changes
- Optional opt-in to LITELLM_BASE_URL for dynamic model loading
