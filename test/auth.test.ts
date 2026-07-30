import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTabnineAuthHook } from "../src/auth"

type OAuthMethod = Extract<ReturnType<typeof createTabnineAuthHook>["methods"][number], { type: "oauth" }>

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
    ...init,
  })
}

async function tempHome() {
  return mkdtemp(join(tmpdir(), "opencode-tabnine-auth-"))
}

describe("createTabnineAuthHook", () => {
  test("prompts for host before login method", () => {
    const hook = createTabnineAuthHook()

    expect(hook.methods).toHaveLength(1)
    expect(hook.methods[0]?.prompts?.map((prompt) => prompt.key)).toEqual(["host", "method"])
    expect(hook.methods[0]?.prompts?.[1]).toMatchObject({
      type: "select",
      options: [
        { label: "Browser login", value: "browser" },
        { label: "Manual custom token", value: "manual" },
      ],
    })
  })

  test("browser auth ignores cached CLI credentials and waits for callback", async () => {
    const home = await tempHome()
    const requests: Array<{ url: string; body: unknown }> = []
    const openedUrls: string[] = []

    try {
      await mkdir(join(home, ".tabnine", "agent"), { recursive: true })
      await writeFile(
        join(home, ".tabnine", "agent", "settings.json"),
        JSON.stringify({ general: { tabnineHost: "https://tabnine.example.test" } }),
      )
      await writeFile(join(home, ".tabnine", "agent", "tabnine_creds.json"), JSON.stringify({ refreshToken: "cli-r" }))

      const hook = createTabnineAuthHook({
        home,
        env: {},
        now: () => 1000,
        openUrl: async (url: string) => {
          openedUrls.push(url)
        },
        fetch: async (input, init) => {
          requests.push({ url: String(input), body: JSON.parse(String(init?.body)) })
          if (String(input).endsWith("/auth/sign-in/custom-token")) {
            return jsonResponse({ refreshToken: "browser-r" })
          }
          return jsonResponse({ idToken: "fresh-id", expiresIn: 3600 })
        },
      })

      const authorize = await (hook.methods[0] as OAuthMethod).authorize({ method: "browser" })
      expect(authorize.method).toBe("auto")
      expect(authorize.url).toStartWith("https://tabnine.example.test/app/user/custom-token?")
      expect(openedUrls).toEqual([authorize.url])
      expect(authorize.instructions).toContain("Complete authorization")
      if (authorize.method !== "auto") throw new Error("expected auto auth")

      const loginUrl = new URL(authorize.url)
      const returnUrl = loginUrl.searchParams.get("returnUrl")
      expect(returnUrl).toStartWith("http://localhost:")
      await fetch(`${returnUrl}?custom_token=browser-token`)

      await expect(authorize.callback()).resolves.toEqual({
        type: "success",
        provider: "tabnine",
        refresh: "browser-r",
        access: "fresh-id",
        expires: 3_601_000,
        enterpriseUrl: "https://tabnine.example.test",
      })
      expect(requests).toEqual([
        {
          url: "https://tabnine.example.test/auth/sign-in/custom-token",
          body: { customToken: "browser-token" },
        },
        {
          url: "https://tabnine.example.test/auth/token/refresh",
          body: { refreshToken: "browser-r" },
        },
      ])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("manual auth exchanges a custom token and refreshes an ID token", async () => {
    const requests: Array<{ url: string; body: unknown }> = []
    const hook = createTabnineAuthHook({
      env: { TABNINE_HOST: "https://tabnine.example.test" },
      now: () => 2000,
      fetch: async (input, init) => {
        requests.push({ url: String(input), body: JSON.parse(String(init?.body)) })
        if (String(input).endsWith("/auth/sign-in/custom-token")) {
          return jsonResponse({ refreshToken: "manual-r" })
        }
        return jsonResponse({ idToken: "manual-id", expiresIn: 60 })
      },
    })

    const authorize = await (hook.methods[0] as OAuthMethod).authorize({ method: "manual" })
    expect(authorize).toMatchObject({
      method: "code",
      url: "https://tabnine.example.test/app/user/custom-token/manual",
    })

    await expect(authorize.callback("custom-token")).resolves.toEqual({
      type: "success",
      provider: "tabnine",
      refresh: "manual-r",
      access: "manual-id",
      expires: 62_000,
      enterpriseUrl: "https://tabnine.example.test",
    })
    expect(requests).toEqual([
      {
        url: "https://tabnine.example.test/auth/sign-in/custom-token",
        body: { customToken: "custom-token" },
      },
      {
        url: "https://tabnine.example.test/auth/token/refresh",
        body: { refreshToken: "manual-r" },
      },
    ])
  })

  test("loader refreshes expired OAuth auth and rewrites request headers", async () => {
    const saved: unknown[] = []
    const requests: Array<{ url: string; headers: Record<string, string>; body?: unknown }> = []
    const hook = createTabnineAuthHook({
      env: {},
      now: () => 10_000,
      promptId: "prompt-123",
      fetch: async (input, init) => {
        const request = new Request(input, init)
        if (request.url.endsWith("/auth/token/refresh")) {
          requests.push({ url: request.url, headers: Object.fromEntries(request.headers), body: await request.json() })
          return jsonResponse({ idToken: "new-access", expiresIn: 60 })
        }
        requests.push({ url: request.url, headers: Object.fromEntries(request.headers) })
        return jsonResponse({ ok: true })
      },
      saveAuth: async (auth) => {
        saved.push(auth)
      },
    })

    const options = await hook.loader!(
      async () => ({
        type: "oauth",
        refresh: "refresh-token",
        access: "old-access",
        expires: 1,
        enterpriseUrl: "https://tabnine.example.test",
      }),
      {} as never,
    )

    expect(options.apiKey).toBe("opencode-oauth-dummy-key")
    await options.fetch("https://tabnine.example.test/chat/openai/v1/chat/completions", {
      headers: { Authorization: "Bearer opencode-oauth-dummy-key", Existing: "1" },
    })

    expect(saved).toEqual([
      {
        type: "oauth",
        refresh: "refresh-token",
        access: "new-access",
        expires: 70_000,
        enterpriseUrl: "https://tabnine.example.test",
      },
    ])
    expect(requests).toEqual([
      {
        url: "https://tabnine.example.test/auth/token/refresh",
        headers: { "content-type": "application/json" },
        body: { refreshToken: "refresh-token" },
      },
      {
        url: "https://tabnine.example.test/chat/openai/v1/chat/completions",
        headers: {
          authorization: "Bearer new-access",
          existing: "1",
          "prompt-id": "prompt-123",
        },
      },
    ])
  })
})
