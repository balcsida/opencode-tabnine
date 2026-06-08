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
export const MAX_TOKEN_EXPIRES = Number.MAX_SAFE_INTEGER

const TABNINE_AGENT_DIR = ".tabnine/agent"
const TABNINE_CREDS_FILE = "tabnine_creds.json"
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

export type TabnineCredentials = {
  refresh: string
  access: string
  expires: number
  enterpriseUrl: string
  source: "env-token" | "env-jwt" | "env-refresh" | "opencode-auth" | "opencode-api" | "creds-file"
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
}

export const FALLBACK_AGENT_MODELS: Record<string, OpenCodeModelConfig> = {
  "tenant-model-id-1": modelConfig({
    name: "Claude 4.5 Haiku",
    reasoning: true,
    context: 200_000,
  }),
  "tenant-model-id-2": modelConfig({
    name: "Claude 4.6 Sonnet",
    reasoning: true,
    context: 200_000,
  }),
  "tenant-model-id-3": modelConfig({
    name: "GPT-5.2",
    reasoning: true,
    context: 400_000,
  }),
  "tenant-model-id-4": modelConfig({
    name: "GPT-5.4",
    reasoning: true,
    context: 400_000,
  }),
}

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

export async function readOpenCodeAuth(input: { env?: Env; home?: string; providerID?: string } = {}) {
  const env = input.env ?? process.env
  const providerID = input.providerID ?? PROVIDER_ID
  const parsed = env.OPENCODE_AUTH_CONTENT
    ? parseJson<Record<string, OpenCodeAuth>>(env.OPENCODE_AUTH_CONTENT)
    : await readJson<Record<string, OpenCodeAuth>>(join(openCodeDataHome(env, input.home ?? homedir()), "opencode", "auth.json"))
  return parsed?.[providerID]
}

export async function resolveBootstrapCredentials(input: {
  host: string
  env?: Env
  home?: string
  auth?: OpenCodeAuth
  fetch?: Fetcher
  now?: () => number
  includeCliCredentials?: boolean
}): Promise<TabnineCredentials | undefined> {
  const env = input.env ?? process.env
  const now = input.now ?? Date.now
  const fetcher = input.fetch ?? fetch

  if (env.TABNINE_TOKEN) {
    return directCredentials(input.host, env.TABNINE_TOKEN, "env-token")
  }
  if (env.TABNINE_JWT) {
    return directCredentials(input.host, env.TABNINE_JWT, "env-jwt")
  }
  if (env.TABNINE_REFRESH_TOKEN) {
    return refreshCredentials({
      host: input.host,
      refresh: env.TABNINE_REFRESH_TOKEN,
      source: "env-refresh",
      fetch: fetcher,
      now,
    }).catch(() => undefined)
  }
  if (input.auth?.type === "oauth") {
    if (input.auth.access && input.auth.expires > now()) {
      return {
        refresh: input.auth.refresh,
        access: input.auth.access,
        expires: input.auth.expires,
        enterpriseUrl: input.host,
        source: "opencode-auth",
      }
    }
    if (input.auth.refresh) {
      return refreshCredentials({
        host: input.host,
        refresh: input.auth.refresh,
        source: "opencode-auth",
        fetch: fetcher,
        now,
      }).catch(() => undefined)
    }
  }
  if (input.auth?.type === "api") {
    return directCredentials(input.host, input.auth.key, "opencode-api")
  }

  if (!input.includeCliCredentials) return

  const cliRefresh = await readTabnineCliRefreshToken(input.home ?? homedir())
  if (!cliRefresh) return
  return refreshCredentials({
    host: input.host,
    refresh: cliRefresh,
    source: "creds-file",
    fetch: fetcher,
    now,
  }).catch(() => undefined)
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

export function chatBaseUrl(host: string) {
  return `${host}${PATH_CHAT_COMPLETIONS_BASE}`
}

export function loginManualUrl(host: string) {
  return `${host}${PATH_LOGIN_MANUAL}`
}

export function loginBrowserUrl(host: string, returnUrl: string) {
  return `${host}${PATH_LOGIN_PAGE}?${new URLSearchParams({ returnUrl }).toString()}`
}

export function loginErrorUrl(host: string) {
  return `${host}${PATH_LOGIN_ERROR}`
}

export async function readTabnineCliRefreshToken(home = homedir()) {
  const parsed = await readJson<{ refreshToken?: string }>(join(home, TABNINE_AGENT_DIR, TABNINE_CREDS_FILE))
  return parsed?.refreshToken
}

function modelFromTabnine(model: TabnineModel) {
  return modelConfig({
    name: model.name,
    reasoning: model.capabilities?.includes("anthropic-thinking") ?? false,
    vision: model.capabilities?.includes("vision") ?? false,
    context: model.modelProperties?.maxContextLength ?? DEFAULT_CONTEXT_WINDOW,
  })
}

function modelConfig(input: { name: string; reasoning: boolean; context: number; vision?: boolean }): OpenCodeModelConfig {
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
  }
}

function directCredentials(host: string, access: string, source: TabnineCredentials["source"]): TabnineCredentials {
  return {
    refresh: "",
    access,
    expires: MAX_TOKEN_EXPIRES,
    enterpriseUrl: host,
    source,
  }
}

async function refreshCredentials(input: {
  host: string
  refresh: string
  source: TabnineCredentials["source"]
  fetch: Fetcher
  now: () => number
}): Promise<TabnineCredentials> {
  const token = await refreshIdToken(input)
  return {
    refresh: input.refresh,
    access: token.access,
    expires: token.expires,
    enterpriseUrl: input.host,
    source: input.source,
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
