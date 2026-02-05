/**
 * Venice.ai Provider Extension
 *
 * Registers Venice.ai as a model provider with dynamically fetched models.
 * Venice offers privacy-focused AI with open-source and frontier models.
 *
 * ## Usage
 *
 * export VENICE_API_KEY=your-key
 *
 * Then `/model` to select a Venice model (e.g., `venice/zai-org-glm-4.7`).
 *
 * ## Implementation details
 *
 * Models are fetched from Venice's `/models` API and cached locally:
 * - Cache location: ~/.pi/agent/cache/venice-models.json
 * - Cache TTL: 24 hours
 * - Fetch timeout: 2 seconds (to avoid blocking startup)
 *
 * On cache hit, models load instantly and refresh in the background.
 * On cache miss or fetch failure, falls back to hardcoded models.
 *
 * To force refresh: `rm ~/.pi/agent/cache/venice-models.json`
 *
 * ## Filtered Models
 *
 * Only text models with function calling support are included (suitable for coding agents).
 * See https://docs.venice.ai for the full model catalog.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const CACHE_DIR = join(homedir(), ".pi", "agent", "cache")
const CACHE_FILE = join(CACHE_DIR, "venice-models.json")
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours
const FETCH_TIMEOUT_MS = 2000 // 2 seconds

interface VeniceModel {
  id: string
  model_spec: {
    name: string
    pricing: {
      input: { usd: number }
      output: { usd: number }
      cache_input?: { usd: number }
      cache_write?: { usd: number }
    }
    availableContextTokens: number
    capabilities: {
      supportsReasoning: boolean
      supportsVision: boolean
      supportsFunctionCalling: boolean
    }
  }
  type: string
}

interface CachedData {
  timestamp: number
  models: PiModel[]
}

interface PiModel {
  id: string
  name: string
  reasoning: boolean
  input: readonly ["text"] | readonly ["text", "image"]
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextWindow: number
  maxTokens: number
}

function transformModel(m: VeniceModel): PiModel {
  const spec = m.model_spec
  const ctx = spec.availableContextTokens
  const maxTokens = Math.min(Math.floor(ctx * 0.25), 64000)

  return {
    id: m.id,
    name: spec.name,
    reasoning: spec.capabilities.supportsReasoning,
    input: spec.capabilities.supportsVision ? ["text", "image"] : ["text"],
    cost: {
      input: spec.pricing.input.usd,
      output: spec.pricing.output.usd,
      cacheRead: spec.pricing.cache_input?.usd ?? 0,
      cacheWrite: spec.pricing.cache_write?.usd ?? 0,
    },
    contextWindow: ctx,
    maxTokens,
  }
}

function readCache(): PiModel[] | null {
  try {
    if (!existsSync(CACHE_FILE)) return null
    const data: CachedData = JSON.parse(readFileSync(CACHE_FILE, "utf-8"))
    if (Date.now() - data.timestamp > CACHE_MAX_AGE_MS) return null
    return data.models
  } catch {
    return null
  }
}

function writeCache(models: PiModel[]): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    const data: CachedData = { timestamp: Date.now(), models }
    writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2))
  } catch {
    // Ignore cache write errors
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchVeniceModels(): Promise<PiModel[] | null> {
  try {
    const res = await fetchWithTimeout("https://api.venice.ai/api/v1/models", FETCH_TIMEOUT_MS)
    if (!res.ok) return null

    const data = (await res.json()) as { data: VeniceModel[] }
    const models = data.data
      .filter((m) => m.type === "text" && m.model_spec.capabilities.supportsFunctionCalling)
      .map(transformModel)

    writeCache(models)
    return models
  } catch {
    return null
  }
}

// Fallback models (minimal set for when everything fails)
const FALLBACK_MODELS: PiModel[] = [
  {
    id: "zai-org-glm-4.7",
    name: "GLM 4.7",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.55, output: 2.65, cacheRead: 0.11, cacheWrite: 0 },
    contextWindow: 198000,
    maxTokens: 49500,
  },
  {
    id: "qwen3-coder-480b-a35b-instruct",
    name: "Qwen 3 Coder 480B",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.75, output: 3.0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256000,
    maxTokens: 64000,
  },
  {
    id: "claude-sonnet-45",
    name: "Claude Sonnet 4.5",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3.75, output: 18.75, cacheRead: 0.375, cacheWrite: 4.69 },
    contextWindow: 198000,
    maxTokens: 49500,
  },
]

export default async function (pi: ExtensionAPI) {
  // Try cache first (instant)
  let models = readCache()

  // If no cache, fetch with timeout
  if (!models) {
    models = await fetchVeniceModels()
  } else {
    // Cache hit - refresh in background for next time
    fetchVeniceModels()
  }

  // Final fallback
  if (!models || models.length === 0) {
    models = FALLBACK_MODELS
  }

  pi.registerProvider("venice", {
    baseUrl: "https://api.venice.ai/api/v1",
    apiKey: "VENICE_API_KEY",
    api: "openai-completions",
    authHeader: true,
    models,
  })
}
