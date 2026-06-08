import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  FALLBACK_AGENT_MODELS,
  fetchAgentModels,
  resolveBootstrapCredentials,
  resolveTabnineHost,
} from "../src/tabnine"

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
    ...init,
  })
}

async function tempHome() {
  return mkdtemp(join(tmpdir(), "opencode-tabnine-"))
}

afterEach(() => {
  delete process.env.TABNINE_HOST
  delete process.env.TABNINE_TOKEN
  delete process.env.TABNINE_JWT
  delete process.env.TABNINE_REFRESH_TOKEN
  delete process.env.OPENCODE_AUTH_CONTENT
  delete process.env.XDG_DATA_HOME
})

describe("resolveTabnineHost", () => {
  test("prefers env, then OpenCode auth enterpriseUrl, then Tabnine settings", async () => {
    const home = await tempHome()
    try {
      await mkdir(join(home, ".tabnine", "agent"), { recursive: true })
      await writeFile(
        join(home, ".tabnine", "agent", "settings.json"),
        JSON.stringify({ general: { tabnineHost: "https://settings.example.test/" } }),
      )

      expect(
        await resolveTabnineHost({
          home,
          env: { TABNINE_HOST: "https://env.example.test/" },
          auth: { type: "oauth", refresh: "r", access: "a", expires: 1, enterpriseUrl: "https://auth.example.test/" },
        }),
      ).toBe("https://env.example.test")

      expect(
        await resolveTabnineHost({
          home,
          env: {},
          auth: { type: "oauth", refresh: "r", access: "a", expires: 1, enterpriseUrl: "https://auth.example.test/" },
        }),
      ).toBe("https://auth.example.test")

      expect(await resolveTabnineHost({ home, env: {} })).toBe("https://settings.example.test")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("rejects non-https hosts", async () => {
    const home = await tempHome()
    try {
      expect(
        await resolveTabnineHost({ home, env: { TABNINE_HOST: "http://insecure.example.test" } }),
      ).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe("resolveBootstrapCredentials", () => {
  test("uses direct token and JWT without refresh calls", async () => {
    const fetchCalls: string[] = []
    const fetcher = async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input))
      return jsonResponse({})
    }

    expect(
      await resolveBootstrapCredentials({
        host: "https://tabnine.example.test",
        env: { TABNINE_TOKEN: "token-value" },
        fetch: fetcher,
        now: () => 1000,
      }),
    ).toMatchObject({ access: "token-value", refresh: "", source: "env-token" })

    expect(
      await resolveBootstrapCredentials({
        host: "https://tabnine.example.test",
        env: { TABNINE_JWT: "jwt-value" },
        fetch: fetcher,
        now: () => 1000,
      }),
    ).toMatchObject({ access: "jwt-value", refresh: "", source: "env-jwt" })

    expect(fetchCalls).toEqual([])
  })

  test("refreshes env refresh tokens and Tabnine CLI cached credentials", async () => {
    const home = await tempHome()
    const bodies: unknown[] = []
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return jsonResponse({ idToken: `id-${bodies.length}`, expiresIn: 60 })
    }

    try {
      await mkdir(join(home, ".tabnine", "agent"), { recursive: true })
      await writeFile(join(home, ".tabnine", "agent", "tabnine_creds.json"), JSON.stringify({ refreshToken: "cli-r" }))

      expect(
        await resolveBootstrapCredentials({
          host: "https://tabnine.example.test",
          env: { TABNINE_REFRESH_TOKEN: "env-r" },
          fetch: fetcher,
          now: () => 1000,
          home,
        }),
      ).toMatchObject({ access: "id-1", refresh: "env-r", expires: 61_000, source: "env-refresh" })

      expect(
        await resolveBootstrapCredentials({
          host: "https://tabnine.example.test",
          env: {},
          fetch: fetcher,
          now: () => 2000,
          home,
          includeCliCredentials: true,
        }),
      ).toMatchObject({ access: "id-2", refresh: "cli-r", expires: 62_000, source: "creds-file" })

      expect(bodies).toEqual([{ refreshToken: "env-r" }, { refreshToken: "cli-r" }])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe("fetchAgentModels", () => {
  test("filters agent models and maps Tabnine capabilities to OpenCode model config", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const models = await fetchAgentModels({
      host: "https://tabnine.example.test",
      access: "id-token",
      fetch: async (input, init) => {
        seen.push({ url: String(input), headers: init?.headers as Record<string, string> })
        return jsonResponse({
          models: [
            {
              id: "agent-model",
              name: "Agent Model",
              capabilities: ["agent", "vision", "anthropic-thinking"],
              modelProperties: { maxContextLength: 123456 },
            },
            { id: "chat-model", name: "Chat Model", capabilities: ["chat"] },
          ],
        })
      },
    })

    expect(seen).toEqual([
      {
        url: "https://tabnine.example.test/chat/v2/models",
        headers: { Authorization: "Bearer id-token", "cloud-sla": "onprem" },
      },
    ])
    expect(models).toEqual({
      "agent-model": {
        name: "Agent Model",
        reasoning: true,
        attachment: true,
        tool_call: true,
        temperature: false,
        modalities: { input: ["text", "image"], output: ["text"] },
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        limit: { context: 123456, output: 8192 },
      },
    })
  })

  test("static fallback contains the documented Agentic models", () => {
    expect(Object.keys(FALLBACK_AGENT_MODELS)).toEqual([
      "d5ff943b-972a-45e7-9242-a3367c907075",
      "d5ff943b-972a-45e7-9242-a3367c907078",
      "01a524ea-36d3-4ebd-a78a-ff5ed37b1530",
      "01a524ea-36d3-4ebd-a78a-ff5ed37b1533",
    ])
  })
})
