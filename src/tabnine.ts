import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export const PROVIDER_ID = "tabnine"
export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"
export const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible"
export const PATH_CHAT_COMPLETIONS_BASE = "/chat/openai/v1"
export const PATH_MODELS = "/chat/v2/models"
export const PATH_TOKEN_REFRESH = "/auth/token/refresh"
export const PATH_CUSTOM_TOKEN_EXCHANGE = "/auth/sign-in/custom-token"
export const PATH_LOGIN_PAGE = "/app/user/custom-token"
export const PATH_LOGIN_ERROR = "/app/user/custom-token/error"
export const PATH_LOGIN_MANUAL = "/app/user/custom-token/manual"
export const CALLBACK_PATH = "/authcallback"
export const CALLBACK_QUERY_PARAM = "custom_token"
export const DEFAULT_CONTEXT_WINDOW = 180_000
export const DEFAULT_OUTPUT_LIMIT = 8_192

const TABNINE_AGENT_DIR = ".tabnine/agent"
const TABNINE_SETTINGS_FILE = "settings.json"

export type Env = Record<string, string | undefined>
export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type OpenCodeAuth =
  | {
      type: "oauth"
      refresh: string
      access: string
      expires: number
      enterpriseUrl?: string
    }
  | {
      type: "api"
      key: string
      metadata?: Record<string, string>
    }
  | {
      type: "wellknown"
      key: string
      token: string
    }

type TabnineModel = {
  id: string
  name: string
  capabilities?: string[]
  modelProperties?: {
    maxContextLength?: number
  }
}

export type OpenCodeModelConfig = {
  name: string
  reasoning: boolean
  attachment: boolean
  tool_call: boolean
  temperature: boolean
  modalities: {
    input: Array<"text" | "image">
    output: ["text"]
  }
  cost: {
    input: number
    output: number
    cache_read: number
    cache_write: number
  }
  limit: {
    context: number
    output: number
  }
  variants?: Record<string, { reasoningEffort: string }>
}

export const FALLBACK_AGENT_MODELS: Record<string, OpenCodeModelConfig> = {}

export function normalizeHost(input: string | undefined | null) {
  if (!input) return
  try {
    const url = new URL(input)
    if (url.protocol !== "https:") return
    return input.replace(/\/+$/, "")
  } catch {
    return
  }
}

export async function resolveTabnineHost(input: { env?: Env; home?: string; auth?: OpenCodeAuth } = {}) {
  const env = input.env ?? process.env
  const fromEnv = normalizeHost(env.TABNINE_HOST)
  if (fromEnv) return fromEnv

  const fromOAuth = normalizeHost(input.auth?.type === "oauth" ? input.auth.enterpriseUrl : undefined)
  if (fromOAuth) return fromOAuth

  const fromApi = normalizeHost(input.auth?.type === "api" ? input.auth.metadata?.tabnineHost : undefined)
  if (fromApi) return fromApi

  return readTabnineSettingsHost(input.home ?? homedir())
}

export async function readOpenCodeAuth(input: { env?: Env; home?: string } = {}) {
  const env = input.env ?? process.env
  const parsed = env.OPENCODE_AUTH_CONTENT
    ? parseJson<Record<string, OpenCodeAuth>>(env.OPENCODE_AUTH_CONTENT)
    : await readJson<Record<string, OpenCodeAuth>>(join(openCodeDataHome(env, input.home ?? homedir()), "opencode", "auth.json"))
  return parsed?.[PROVIDER_ID]
}

export async function resolveBootstrapCredentials(input: {
  host: string
  env?: Env
  auth?: OpenCodeAuth
  fetch?: Fetcher
  now?: () => number
}): Promise<string | undefined> {
  const env = input.env ?? process.env
  const now = input.now ?? Date.now
  const fetcher = input.fetch ?? fetch

  if (env.TABNINE_TOKEN) {
    return env.TABNINE_TOKEN
  }
  if (env.TABNINE_JWT) {
    return env.TABNINE_JWT
  }
  if (env.TABNINE_REFRESH_TOKEN) {
    return refreshIdToken({
      host: input.host,
      refresh: env.TABNINE_REFRESH_TOKEN,
      fetch: fetcher,
      now,
    }).then((token) => token.access, () => undefined)
  }
  if (input.auth?.type === "oauth") {
    if (input.auth.access && input.auth.expires > now()) {
      return input.auth.access
    }
    if (input.auth.refresh) {
      return refreshIdToken({
        host: input.host,
        refresh: input.auth.refresh,
        fetch: fetcher,
        now,
      }).then((token) => token.access, () => undefined)
    }
  }
  if (input.auth?.type === "api") {
    return input.auth.key
  }
}

export async function refreshIdToken(input: { host: string; refresh: string; fetch?: Fetcher; now?: () => number }) {
  const response = await (input.fetch ?? fetch)(`${input.host}${PATH_TOKEN_REFRESH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: input.refresh }),
  })
  if (!response.ok) throw new Error(`Token refresh failed: ${response.status} ${response.statusText}`)

  const data = (await response.json()) as { idToken?: string; expiresIn?: number }
  if (!data.idToken || typeof data.expiresIn !== "number") {
    throw new Error("Token refresh response missing idToken or expiresIn")
  }
  return {
    access: data.idToken,
    expires: (input.now ?? Date.now)() + data.expiresIn * 1000,
  }
}

export async function exchangeCustomToken(input: { host: string; customToken: string; fetch?: Fetcher }) {
  const response = await (input.fetch ?? fetch)(`${input.host}${PATH_CUSTOM_TOKEN_EXCHANGE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customToken: input.customToken }),
  })
  if (!response.ok) throw new Error(`Custom-token exchange failed: ${response.status} ${response.statusText}`)

  const data = (await response.json()) as { refreshToken?: string }
  if (!data.refreshToken) throw new Error("Custom-token exchange returned no refreshToken")
  return data.refreshToken
}

export async function fetchAgentModels(input: { host: string; access: string; fetch?: Fetcher }) {
  try {
    const response = await (input.fetch ?? fetch)(`${input.host}${PATH_MODELS}`, {
      headers: {
        Authorization: `Bearer ${input.access}`,
        "cloud-sla": "onprem",
      },
    })
    if (!response.ok) return {}

    const data = (await response.json()) as { models?: TabnineModel[] }
    return Object.fromEntries(
      (data.models ?? [])
        .filter((model) => model.capabilities?.includes("agent"))
        .map((model) => [model.id, modelFromTabnine(model)]),
    )
  } catch {
    return {}
  }
}

export function loginBrowserUrl(host: string, returnUrl: string) {
  return `${host}${PATH_LOGIN_PAGE}?${new URLSearchParams({ returnUrl }).toString()}`
}

export function prepareTabnineRequest(init: RequestInit = {}) {
  if (typeof init.body !== "string") return init
  try {
    const body = JSON.parse(init.body)
    const effort = body.reasoning_effort
    if (typeof effort !== "string") return init
    if (effort.startsWith("claude-")) {
      delete body.reasoning_effort
      if (effort.startsWith("claude-adaptive-")) {
        body.thinking = { type: "adaptive", display: "summarized" }
        body.output_config = { effort: effort.replace("claude-adaptive-", "") }
      } else {
        const budget = Number(effort.match(/^claude-thinking-(\d+)$/)?.[1])
        if (budget) body.thinking = { type: "enabled", budget_tokens: budget }
      }
    } else if (body.tools?.some((tool: { type?: string }) => tool.type === "function")) {
      delete body.reasoning_effort
    } else {
      return init
    }
    return { ...init, body: JSON.stringify(body) }
  } catch {
    return init
  }
}

export function exposeClaudeReasoning(response: Response) {
  const type = response.headers.get("content-type") ?? ""
  if (type.includes("text/event-stream")) {
    return new Response(response.body?.pipeThrough(sseReasoningTransform()), response)
  }
  if (!type.includes("application/json")) return response

  return new Response(
    new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(mapClaudeReasoning(await response.json()))))
        controller.close()
      },
    }),
    response,
  )
}

function sseReasoningTransform() {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) controller.enqueue(encoder.encode(mapSseLine(line) + "\n"))
    },
    flush(controller) {
      buffer += decoder.decode()
      if (buffer) controller.enqueue(encoder.encode(mapSseLine(buffer)))
    },
  })
}

function mapSseLine(line: string) {
  if (!line.startsWith("data: ") || line === "data: [DONE]") return line
  try {
    return `data: ${JSON.stringify(mapClaudeReasoning(JSON.parse(line.slice(6))))}`
  } catch {
    return line
  }
}

function mapClaudeReasoning(data: any) {
  for (const choice of data?.choices ?? []) {
    for (const part of [choice.message, choice.delta]) {
      const thinking = part?.content_blocks
        ?.map((block: any) => block.thinking ?? block.delta?.thinking)
        .filter(Boolean)
        .join("")
      if (thinking) part.reasoning_content = thinking
    }
  }
  return data
}

function modelFromTabnine(model: TabnineModel) {
  const variants = reasoningVariants(model.name)
  return modelConfig({
    name: model.name,
    reasoning: Boolean(variants) || (model.capabilities?.includes("anthropic-thinking") ?? false),
    vision: model.capabilities?.includes("vision") ?? false,
    context: model.modelProperties?.maxContextLength ?? DEFAULT_CONTEXT_WINDOW,
    variants,
  })
}

function reasoningVariants(name: string): OpenCodeModelConfig["variants"] {
  const efforts = name === "Claude 4.6 Sonnet"
    ? ["low", "medium", "high", "max"].map((effort) => [effort, `claude-adaptive-${effort}`])
    : name === "Claude 4.5 Haiku"
      ? [1024, 2048, 4096].map((budget) => [`thinking-${budget}`, `claude-thinking-${budget}`])
      : name === "GPT-5.5"
        ? ["none", "low", "medium", "high", "xhigh"].map((effort) => [effort, effort])
        : /^GPT-5\./.test(name)
          ? ["low", "medium", "high", "xhigh"].map((effort) => [effort, effort])
          : undefined
  return efforts && Object.fromEntries(efforts.map(([name, value]) => [name, { reasoningEffort: String(value) }]))
}

function modelConfig(input: {
  name: string
  reasoning: boolean
  context: number
  vision?: boolean
  variants?: OpenCodeModelConfig["variants"]
}): OpenCodeModelConfig {
  return {
    name: input.name,
    reasoning: input.reasoning,
    attachment: input.vision ?? true,
    tool_call: true,
    temperature: false,
    modalities: {
      input: input.vision === false ? ["text"] : ["text", "image"],
      output: ["text"],
    },
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: input.context, output: DEFAULT_OUTPUT_LIMIT },
    ...(input.variants ? { variants: input.variants } : {}),
  }
}

async function readTabnineSettingsHost(home: string) {
  const parsed = await readJson<{ general?: { tabnineHost?: string } }>(join(home, TABNINE_AGENT_DIR, TABNINE_SETTINGS_FILE))
  return normalizeHost(parsed?.general?.tabnineHost)
}

function openCodeDataHome(env: Env, home: string) {
  return env.XDG_DATA_HOME || join(home, ".local", "share")
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return parseJson<T>(await readFile(path, "utf8"))
  } catch {
    return
  }
}

function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch {
    return
  }
}
