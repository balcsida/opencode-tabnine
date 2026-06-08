import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTabninePlugin } from "../src/index"

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
      expect(Object.keys(config.provider?.tabnine.models ?? {})).toHaveLength(4)
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
      expect(Object.keys(config.provider?.tabnine.models ?? {})).toHaveLength(4)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("omits max output tokens for Tabnine reasoning models", async () => {
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
            reasoning: true,
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
  })
})
