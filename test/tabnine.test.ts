import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  fetchAgentModels,
  exposeClaudeReasoning,
  prepareTabnineRequest,
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
    ).toBe("token-value")

    expect(
      await resolveBootstrapCredentials({
        host: "https://tabnine.example.test",
        env: { TABNINE_JWT: "jwt-value" },
        fetch: fetcher,
        now: () => 1000,
      }),
    ).toBe("jwt-value")

    expect(fetchCalls).toEqual([])
  })

  test("refreshes env refresh tokens", async () => {
    const bodies: unknown[] = []
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return jsonResponse({ idToken: `id-${bodies.length}`, expiresIn: 60 })
    }

    expect(
      await resolveBootstrapCredentials({
        host: "https://tabnine.example.test",
        env: { TABNINE_REFRESH_TOKEN: "env-r" },
        fetch: fetcher,
        now: () => 1000,
      }),
    ).toBe("id-1")

    expect(bodies).toEqual([{ refreshToken: "env-r" }])
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
              id: "sonnet-model",
              name: "Claude 4.6 Sonnet",
              capabilities: ["agent", "vision", "anthropic-thinking"],
              modelProperties: { maxContextLength: 123456 },
            },
            {
              id: "gpt-model",
              name: "GPT-5.5",
              capabilities: ["agent"],
              modelProperties: { maxContextLength: 200000 },
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
      "sonnet-model": {
        name: "Claude 4.6 Sonnet",
        reasoning: true,
        attachment: true,
        tool_call: true,
        temperature: false,
        modalities: { input: ["text", "image"], output: ["text"] },
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        limit: { context: 123456, output: 8192 },
        variants: {
          low: { reasoningEffort: "claude-adaptive-low" },
          medium: { reasoningEffort: "claude-adaptive-medium" },
          high: { reasoningEffort: "claude-adaptive-high" },
          max: { reasoningEffort: "claude-adaptive-max" },
        },
      },
      "gpt-model": {
        name: "GPT-5.5",
        reasoning: true,
        attachment: false,
        tool_call: true,
        temperature: false,
        modalities: { input: ["text"], output: ["text"] },
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        limit: { context: 200000, output: 8192 },
        variants: {
          none: { reasoningEffort: "none" },
          low: { reasoningEffort: "low" },
          medium: { reasoningEffort: "medium" },
          high: { reasoningEffort: "high" },
          xhigh: { reasoningEffort: "xhigh" },
        },
      },
    })
  })

  test("uses fixed thinking budgets for Claude 4.5 Haiku", async () => {
    const models = await fetchAgentModels({
      host: "https://tabnine.example.test",
      access: "id-token",
      fetch: async () =>
        jsonResponse({
          models: [
            {
              id: "haiku-model",
              name: "Claude 4.5 Haiku",
              capabilities: ["agent", "anthropic-thinking"],
            },
          ],
        }),
    })

    expect(models["haiku-model"]?.variants).toEqual({
      "thinking-1024": { reasoningEffort: "claude-thinking-1024" },
      "thinking-2048": { reasoningEffort: "claude-thinking-2048" },
      "thinking-4096": { reasoningEffort: "claude-thinking-4096" },
    })
  })

})

describe("prepareTabnineRequest", () => {
  test("translates Claude variant sentinels to native thinking options", () => {
    expect(
      JSON.parse(String(prepareTabnineRequest({ body: JSON.stringify({ reasoning_effort: "claude-adaptive-high" }) }).body)),
    ).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    })
    expect(
      JSON.parse(String(prepareTabnineRequest({ body: JSON.stringify({ reasoning_effort: "claude-thinking-2048" }) }).body)),
    ).toEqual({ thinking: { type: "enabled", budget_tokens: 2048 } })
  })
})

describe("exposeClaudeReasoning", () => {
  test("maps Claude content blocks to the OpenAI-compatible reasoning field", async () => {
    const response = await exposeClaudeReasoning(
      jsonResponse({
        choices: [
          {
            message: {
              content: "answer",
              content_blocks: [
                { type: "thinking", thinking: "reasoning" },
                { type: "text", text: "answer" },
              ],
            },
          },
        ],
      }),
    )

    expect(await response.json()).toMatchObject({
      choices: [{ message: { content: "answer", reasoning_content: "reasoning" } }],
    })
  })

  test("passes error responses through untouched and logs the request id", async () => {
    const logged: string[] = []
    const original = console.error
    console.error = (msg: string) => logged.push(msg)
    try {
      const response = await exposeClaudeReasoning(
        new Response('{"error":"boom"}', {
          status: 500,
          headers: { "content-type": "application/json", "x-request-id": "req-123" },
        }),
      )
      expect(response.status).toBe(500)
      expect(await response.text()).toBe('{"error":"boom"}')
      expect(logged[0]).toContain("x-request-id=req-123")
      expect(logged[0]).toContain("boom")
    } finally {
      console.error = original
    }
  })

  test("maps streamed Claude thinking deltas without buffering the response", async () => {
    const response = await exposeClaudeReasoning(
      new Response(
        'data: {"choices":[{"delta":{"content_blocks":[{"delta":{"thinking":"reasoning"}}]}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n' +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      ),
    )

    const text = await response.text()
    expect(text).toContain('"reasoning_content":"reasoning"')
    expect(text).toContain('"content":"answer"')
  })
})
