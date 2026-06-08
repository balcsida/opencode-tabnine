export type PluginInput = {
  client: {
    auth: {
      set(input: { path: { id: string }; body: unknown }): Promise<unknown>
    }
  }
}

export type PluginOptions = Record<string, unknown>

export type Config = {
  provider?: Record<
    string,
    {
      name?: string
      npm?: string
      api?: string
      options?: Record<string, unknown>
      models?: Record<string, unknown>
    }
  >
}

export type StoredAuth =
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

export type AuthOAuthResult =
  | ({
      url: string
      instructions: string
    } & (
      | {
          method: "auto"
          callback(): Promise<AuthSuccess | AuthFailed>
        }
      | {
          method: "code"
          callback(code: string): Promise<AuthSuccess | AuthFailed>
        }
    ))

export type AuthSuccess =
  | {
      type: "success"
      provider?: string
      refresh: string
      access: string
      expires: number
      enterpriseUrl?: string
    }
  | {
      type: "success"
      provider?: string
      key: string
      metadata?: Record<string, string>
    }

export type AuthFailed = {
  type: "failed"
}

export type AuthPrompt = {
  type: "text"
  key: string
  message: string
  placeholder?: string
  validate?: (value: string) => string | undefined
}

export type AuthHook = {
  provider: string
  loader?: (
    auth: () => Promise<StoredAuth>,
    provider?: unknown,
  ) => Promise<{
    apiKey?: string
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    [key: string]: unknown
  }>
  methods: Array<{
    type: "oauth"
    label: string
    prompts?: AuthPrompt[]
    authorize(inputs?: Record<string, string>): Promise<AuthOAuthResult>
  }>
}

export type Hooks = {
  auth?: AuthHook
  config?: (input: Config) => Promise<void>
  "chat.params"?: (
    input: {
      [key: string]: unknown
      model: {
        providerID: string
        [key: string]: unknown
        capabilities: {
          reasoning: boolean
          [key: string]: unknown
        }
      }
    },
    output: {
      maxOutputTokens: number | undefined
    },
  ) => Promise<void>
}

export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>
