import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { AuthHook, AuthOAuthResult } from "./types"
import {
  CALLBACK_PATH,
  CALLBACK_QUERY_PARAM,
  Env,
  Fetcher,
  OAUTH_DUMMY_KEY,
  OpenCodeAuth,
  PATH_LOGIN_ERROR,
  PATH_LOGIN_MANUAL,
  PROVIDER_ID,
  exchangeCustomToken,
  loginBrowserUrl,
  normalizeHost,
  refreshIdToken,
  resolveTabnineHost,
} from "./tabnine"

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const LOGIN_TIMEOUT_MESSAGE =
  "Authentication timed out after 5 minutes. The browser tab may have gotten stuck in a loading state. Please try again or use the manual Tabnine auth method."
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
} as const

type AuthHookOptions = {
  env?: Env
  home?: string
  fetch?: Fetcher
  openUrl?: (url: string) => void | Promise<void>
  now?: () => number
  promptId?: string
  saveAuth?: (auth: OpenCodeAuth) => Promise<void>
}

type CallbackServerResult = {
  url: string
  callback: Promise<string>
}

export function createTabnineAuthHook(options: AuthHookOptions = {}): AuthHook {
  const promptId = options.promptId ?? randomUUID()

  return {
    provider: PROVIDER_ID,
    loader: async (getAuth) => ({
      apiKey: OAUTH_DUMMY_KEY,
      fetch: createAuthenticatedFetch({ ...options, getAuth, promptId }),
    }),
    methods: [
      {
        type: "oauth",
        label: "Tabnine login",
        prompts: loginPrompts(),
        async authorize(inputs) {
          const host = await requireHost(options, inputs)
          if (inputs?.method === "manual") {
            return {
              url: `${host}${PATH_LOGIN_MANUAL}`,
              instructions: "Visit the URL, log in, then paste the custom token.",
              method: "code",
              async callback(code: string) {
                const refresh = await exchangeCustomToken({
                  host,
                  customToken: code.trim(),
                  fetch: options.fetch,
                })
                const token = await refreshIdToken({
                  host,
                  refresh,
                  fetch: options.fetch,
                  now: options.now,
                })
                return success({ refresh, access: token.access, expires: token.expires, host })
              },
            }
          }

          const server = await runCallbackServer({ host, env: options.env, fetch: options.fetch })
          await openBrowserUrl(server.url, options)
          return {
            url: server.url,
            instructions: "Complete authorization in your browser. This window will close automatically.",
            method: "auto",
            async callback() {
              const refresh = await withTimeout(server.callback)
              const token = await refreshIdToken({
                host,
                refresh,
                fetch: options.fetch,
                now: options.now,
              })
              return success({ refresh, access: token.access, expires: token.expires, host })
            },
          }
        },
      },
    ],
  }
}

function createAuthenticatedFetch(options: AuthHookOptions & { getAuth: () => Promise<OpenCodeAuth>; promptId: string }) {
  let refreshPromise: Promise<{ access: string; expires: number; host: string; auth: OpenCodeAuth }> | undefined

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const current = await options.getAuth()
    if (current.type !== "oauth") return (options.fetch ?? fetch)(input, init)

    const host = await requireHost(options, undefined, current)
    const env = options.env ?? process.env
    const envAccess = env.TABNINE_TOKEN ?? env.TABNINE_JWT
    const token = envAccess
      ? { access: envAccess, auth: current as OpenCodeAuth }
      : current.expires > (options.now ?? Date.now)()
        ? { access: current.access, auth: current as OpenCodeAuth }
        : await (refreshPromise ??= refreshOAuth({ ...options, host, auth: current as OpenCodeAuth }).finally(() => {
            refreshPromise = undefined
          }))

    const headers = new Headers(init?.headers)
    headers.delete("authorization")
    headers.set("authorization", `Bearer ${token.access}`)
    headers.set("prompt-id", options.promptId)

    return (options.fetch ?? fetch)(input, {
      ...init,
      headers,
    })
  }
}

async function refreshOAuth(options: AuthHookOptions & { host: string; auth: OpenCodeAuth }) {
  if (options.auth.type !== "oauth" || !options.auth.refresh) {
    throw new Error("Tabnine credentials missing refresh token. Re-run `opencode auth login tabnine`.")
  }
  const token = await refreshIdToken({
    host: options.host,
    refresh: options.auth.refresh,
    fetch: options.fetch,
    now: options.now,
  })
  const auth: OpenCodeAuth = {
    type: "oauth",
    refresh: options.auth.refresh,
    access: token.access,
    expires: token.expires,
    enterpriseUrl: options.host,
  }
  await options.saveAuth?.(auth)
  return { ...token, host: options.host, auth }
}

async function requireHost(options: AuthHookOptions, inputs?: Record<string, string>, auth?: OpenCodeAuth) {
  const host = await resolveTabnineHost({
    env: options.env,
    home: options.home,
    auth,
  })
  const fromInput = normalizeHost(inputs?.host?.trim())
  const result = fromInput ?? host
  if (!result) throw new Error("Tabnine host is required.")
  return result
}

function loginPrompts(): NonNullable<AuthHook["methods"][number]["prompts"]> {
  return [
    {
      type: "text",
      key: "host",
      message: "Tabnine host",
      placeholder: "https://tabnine.example.com",
      validate(value) {
        if (!value) return undefined
        return normalizeHost(value.trim()) ? undefined : "Must be an https URL"
      },
    },
    {
      type: "select",
      key: "method",
      message: "Login method",
      options: [
        { label: "Browser login", value: "browser" },
        { label: "Manual custom token", value: "manual" },
      ],
    },
  ]
}

function success(input: { refresh: string; access: string; expires: number; host: string }) {
  return {
    type: "success",
    provider: PROVIDER_ID,
    refresh: input.refresh,
    access: input.access,
    expires: input.expires,
    enterpriseUrl: input.host,
  } satisfies Awaited<ReturnType<Extract<AuthOAuthResult, { method: "auto" }>["callback"]>>
}

async function withTimeout<T>(promise: Promise<T>) {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(LOGIN_TIMEOUT_MESSAGE)), LOGIN_TIMEOUT_MS)),
  ])
}

async function runCallbackServer(input: { host: string; env?: Env; fetch?: Fetcher }): Promise<CallbackServerResult> {
  const env = input.env ?? process.env
  const bindHost = env.TABNINE_LOGIN_CALLBACK_HOST || "localhost"
  const port = callbackPort(env)

  let resolveCallback!: (refresh: string) => void
  let rejectCallback!: (err: Error) => void
  const callback = new Promise<string>((resolve, reject) => {
    resolveCallback = resolve
    rejectCallback = reject
  })

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", `http://${bindHost}`)
      if (!url.pathname.endsWith(CALLBACK_PATH)) {
        res.writeHead(301, { Location: `${input.host}${PATH_LOGIN_ERROR}` })
        res.end()
        rejectCallback(new Error(`Auth callback not received. Unexpected request: ${req.url}`))
        return
      }
      if (req.method === "OPTIONS") {
        res.writeHead(200, CORS_HEADERS)
        res.end()
        return
      }
      const customToken = url.searchParams.get(CALLBACK_QUERY_PARAM)
      if (!customToken) {
        res.writeHead(500)
        res.end()
        rejectCallback(new Error("No authenticate token received from Tabnine. Please try authenticating again."))
        return
      }
      const refresh = await exchangeCustomToken({ host: input.host, customToken, fetch: input.fetch })
      res.writeHead(200, CORS_HEADERS)
      res.end()
      resolveCallback(refresh)
    } catch (err) {
      res.writeHead(500)
      res.end()
      rejectCallback(err instanceof Error ? err : new Error(String(err)))
    } finally {
      server.close()
    }
  })

  server.on("error", (err) => rejectCallback(new Error(`OAuth callback server error: ${err.message}`)))

  await new Promise<void>((resolve, reject) => {
    server.listen(port, bindHost, resolve)
    server.once("error", reject)
  })

  const address = server.address() as AddressInfo
  const returnUrl = `http://localhost:${address.port}${CALLBACK_PATH}`
  return {
    url: loginBrowserUrl(input.host, returnUrl),
    callback,
  }
}

async function openBrowserUrl(url: string, options: AuthHookOptions) {
  const env = options.env ?? process.env
  if (env.NO_BROWSER === "true") return

  try {
    await (options.openUrl ?? defaultOpenUrl)(url)
  } catch {
    // OpenCode still displays the URL, so opener failures should not block login.
  }
}

function defaultOpenUrl(url: string) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open"
  const args =
    process.platform === "darwin"
      ? [url]
      : process.platform === "win32"
        ? ["/c", "start", "", url]
        : [url]
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  })
  child.on("error", () => {})
  child.unref()
}

function callbackPort(env: Env = process.env) {
  const raw = env.OAUTH_CALLBACK_PORT
  if (!raw) return 0
  const port = Number.parseInt(raw, 10)
  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid value for OAUTH_CALLBACK_PORT: "${raw}"`)
  }
  return port
}
