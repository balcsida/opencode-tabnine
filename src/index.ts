import { randomUUID } from "node:crypto"
import { createTabnineAuthHook } from "./auth"
import type { Config, Plugin, PluginInput, PluginOptions } from "./types"
import {
  FALLBACK_AGENT_MODELS,
  Env,
  Fetcher,
  OPENAI_COMPATIBLE_NPM,
  OAUTH_DUMMY_KEY,
  PROVIDER_ID,
  chatBaseUrl,
  fetchAgentModels,
  readOpenCodeAuth,
  resolveBootstrapCredentials,
  resolveTabnineHost,
} from "./tabnine"

type PluginDeps = {
  env?: Env
  home?: string
  fetch?: Fetcher
  now?: () => number
  promptId?: string
}

export function createTabninePlugin(deps: PluginDeps = {}): Plugin {
  const promptId = deps.promptId ?? randomUUID()

  return async (input: PluginInput) => ({
    auth: createTabnineAuthHook({
      ...deps,
      promptId,
      saveAuth: async (auth) => {
        await input.client.auth.set({
          path: { id: PROVIDER_ID },
          body: auth as never,
        })
      },
    }),
    async config(config: Config) {
      const auth = await readOpenCodeAuth({ env: deps.env, home: deps.home }).catch(() => undefined)
      const host = await resolveTabnineHost({ env: deps.env, home: deps.home, auth })
      if (!host) return

      const bootstrap = await resolveBootstrapCredentials({
        host,
        env: deps.env,
        home: deps.home,
        auth,
        fetch: deps.fetch,
        now: deps.now,
      })
      const discovered = bootstrap
        ? await fetchAgentModels({
            host,
            access: bootstrap.access,
            fetch: deps.fetch,
          })
        : {}
      const models = Object.keys(discovered).length ? discovered : FALLBACK_AGENT_MODELS
      const existing = config.provider?.[PROVIDER_ID]
      const existingHeaders =
        existing?.options?.headers && typeof existing.options.headers === "object" && !Array.isArray(existing.options.headers)
          ? (existing.options.headers as Record<string, string>)
          : {}

      config.provider = {
        ...config.provider,
        [PROVIDER_ID]: {
          name: "Tabnine",
          npm: OPENAI_COMPATIBLE_NPM,
          api: chatBaseUrl(host),
          options: {
            ...existing?.options,
            includeUsage: true,
            headers: {
              ...existingHeaders,
              "prompt-id": promptId,
            },
            ...(bootstrap ? { apiKey: bootstrap.access } : {}),
          },
          models: {
            ...models,
            ...existing?.models,
          },
        },
      }
    },
    "chat.params": async (hookInput, output) => {
      if (hookInput.model.providerID !== PROVIDER_ID) return
      if (!hookInput.model.capabilities.reasoning) return
      output.maxOutputTokens = undefined
    },
  })
}

export default {
  id: "opencode-tabnine",
  server: (_input: PluginInput, options?: PluginOptions) => createTabninePlugin(options as PluginDeps | undefined)(_input),
}
