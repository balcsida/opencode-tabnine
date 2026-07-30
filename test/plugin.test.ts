import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin, { createTabninePlugin } from "../src/index"

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
    ...init,
  })
}

const pluginInput = {
  client: {} as never,
  project: {} as never,
  directory: "",
  worktree: "",
  experimental_workspace: {
    register() {},
  },
  serverUrl: new URL("https://opencode.example.test"),
  $: {} as never,
}

async function tempHome() {
  return mkdtemp(join(tmpdir(), "opencode-tabnine-plugin-"))
}

describe("createTabninePlugin", () => {
  test("exports the npm package plugin id", () => {
    expect(plugin.id).toBe("opencode-provider-tabnine")
  })

  test("injects a tabnine OpenAI-compatible provider with fallback models", async () => {
    const home = await tempHome()
    try {
      const hooks = await createTabninePlugin({
        home,
        env: { TABNINE_HOST: "https://tabnine.example.test" },
        fetch: async () => {
          throw new Error("discovery should not run without credentials")
        },
      })(pluginInput)
      const config: { provider?: Record<string, any> } = {}

      await hooks.config!(config as never)

      expect(config.provider?.tabnine).toMatchObject({
        name: "Tabnine",
        npm: "@ai-sdk/openai-compatible",
        api: "https://tabnine.example.test/chat/openai/v1",
        options: {
          includeUsage: true,
        },
      })
      expect(config.provider?.tabnine.options.apiKey).toBeUndefined()
      expect(config.provider?.tabnine.models).toEqual({})
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("uses discovered Agentic models when bootstrap credentials are available", async () => {
    const hooks = await createTabninePlugin({
      env: {
        TABNINE_HOST: "https://tabnine.example.test",
        TABNINE_TOKEN: "token",
      },
      fetch: async (input, init) => {
        expect(String(input)).toBe("https://tabnine.example.test/chat/v2/models")
        expect(init?.headers).toEqual({ Authorization: "Bearer token", "cloud-sla": "onprem" })
        return jsonResponse({
          models: [
            {
              id: "live-agent",
              name: "Live Agent",
              capabilities: ["agent"],
              modelProperties: { maxContextLength: 111 },
            },
          ],
        })
      },
    })(pluginInput)
    const config: { provider?: Record<string, any> } = {}

    await hooks.config!(config as never)

    expect(Object.keys(config.provider?.tabnine.models ?? {})).toEqual(["live-agent"])
    expect(config.provider?.tabnine.options.apiKey).toBe("token")
    expect(config.provider?.tabnine.options.fetch).toBeFunction()
  })

  test("does not import Tabnine CLI credentials while configuring provider", async () => {
    const home = await tempHome()
    try {
      await mkdir(join(home, ".tabnine", "agent"), { recursive: true })
      await writeFile(
        join(home, ".tabnine", "agent", "settings.json"),
        JSON.stringify({ general: { tabnineHost: "https://tabnine.example.test" } }),
      )
      await writeFile(join(home, ".tabnine", "agent", "tabnine_creds.json"), JSON.stringify({ refreshToken: "cli-r" }))

      const hooks = await createTabninePlugin({
        home,
        env: {},
        fetch: async () => {
          throw new Error("config must not refresh cached CLI credentials")
        },
      })(pluginInput)
      const config: { provider?: Record<string, any> } = {}

      await hooks.config!(config as never)

      expect(config.provider?.tabnine.options.apiKey).toBeUndefined()
      expect(config.provider?.tabnine.models).toEqual({})
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("composes Claude translation with an existing provider fetch", async () => {
    const dependencyCalls: string[] = []
    const customCalls: unknown[] = []
    const hooks = await createTabninePlugin({
      env: { TABNINE_HOST: "https://tabnine.example.test", TABNINE_TOKEN: "token" },
      fetch: async (input) => {
        dependencyCalls.push(String(input))
        return jsonResponse({ models: [] })
      },
    })(pluginInput)
    const config: { provider?: Record<string, any> } = {
      provider: {
        tabnine: {
          options: {
            fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
              customCalls.push(JSON.parse(String(init?.body)))
              return jsonResponse({ choices: [] })
            },
          },
        },
      },
    }
    await hooks.config!(config as never)

    await config.provider?.tabnine.options.fetch("https://tabnine.example.test/chat/openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ reasoning_effort: "claude-adaptive-high" }),
    })

    expect(dependencyCalls).toEqual(["https://tabnine.example.test/chat/v2/models"])
    expect(customCalls).toEqual([
      {
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
      },
    ])
  })

  test("translates Claude requests and responses with environment credentials", async () => {
    const requests: unknown[] = []
    const hooks = await createTabninePlugin({
      env: { TABNINE_HOST: "https://tabnine.example.test", TABNINE_TOKEN: "token" },
      fetch: async (input, init) => {
        if (String(input).endsWith("/chat/v2/models")) return jsonResponse({ models: [] })
        requests.push(JSON.parse(String(init?.body)))
        return jsonResponse({
          choices: [
            {
              message: {
                content: "answer",
                content_blocks: [{ type: "thinking", thinking: "reasoning" }],
              },
            },
          ],
        })
      },
    })(pluginInput)
    const config: { provider?: Record<string, any> } = {}
    await hooks.config!(config as never)

    const response = await config.provider?.tabnine.options.fetch("https://tabnine.example.test/chat/openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ reasoning_effort: "claude-adaptive-high" }),
    })

    expect(requests).toEqual([
      {
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
      },
    ])
    expect(await response.json()).toMatchObject({
      choices: [{ message: { reasoning_content: "reasoning" } }],
    })
  })

  test("keeps Claude variant sentinels until the fetch wrapper translates them", async () => {
    const hooks = await createTabninePlugin({ env: { TABNINE_HOST: "https://tabnine.example.test" } })(pluginInput)
    const base: {
      temperature: number
      topP: number
      topK: number
      maxOutputTokens: number | undefined
      options: Record<string, unknown>
    } = {
      temperature: 0,
      topP: 1,
      topK: 0,
      maxOutputTokens: 8192,
      options: { reasoningEffort: "claude-adaptive-high" },
    }
    const input = {
      sessionID: "s",
      agent: "a",
      provider: {} as never,
      message: {} as never,
      model: {
        providerID: "tabnine",
        api: { id: "model", url: "", npm: "@ai-sdk/openai-compatible" },
        name: "Claude 4.6 Sonnet",
        capabilities: { reasoning: true },
      } as never,
    }

    await hooks["chat.params"]!(input, base)

    expect(base.options).toEqual({
      max_completion_tokens: 8192,
      reasoningEffort: "claude-adaptive-high",
    })

    const haiku: typeof base = {
      ...base,
      maxOutputTokens: 8192,
      options: { reasoningEffort: "claude-thinking-2048" },
    }
    await hooks["chat.params"]!(
      { ...input, model: { ...(input.model as object), name: "Claude 4.5 Haiku" } } as never,
      haiku,
    )
    expect(haiku.options).toEqual({
      max_completion_tokens: 8192,
      reasoningEffort: "claude-thinking-2048",
    })
  })

  test("uses max completion tokens for every Tabnine model", async () => {
    const hooks = await createTabninePlugin({ env: { TABNINE_HOST: "https://tabnine.example.test" } })(pluginInput)
    const out = { temperature: 0, topP: 1, topK: 0, maxOutputTokens: 8192 as number | undefined, options: {} }

    await hooks["chat.params"]!(
      {
        sessionID: "s",
        agent: "a",
        provider: {} as never,
        message: {} as never,
        model: {
          providerID: "tabnine",
          api: { id: "model", url: "", npm: "@ai-sdk/openai-compatible" },
          capabilities: {
            reasoning: false,
            temperature: false,
            attachment: true,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
        } as never,
      },
      out,
    )

    expect(out.maxOutputTokens).toBeUndefined()
    expect(out.options).toEqual({ max_completion_tokens: 8192 })
  })
})
