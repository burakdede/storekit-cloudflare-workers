import { describe, expect, it, vi } from "vitest"
import { MockD1Database } from "../helpers/mock-d1"
import { createStoreKitWorker } from "../../src/worker"

function env(overrides: Record<string, unknown> = {}) {
  return {
    STOREKIT_DB: new MockD1Database() as unknown as D1Database,
    STOREKIT_ALLOWED_ENVIRONMENTS: "Sandbox",
    STOREKIT_BUNDLE_ID: "com.example.app",
    STOREKIT_ALLOWED_PRODUCT_IDS: "com.example.pro.monthly",
    APP_STORE_CONNECT_ISSUER_ID: "issuer",
    APP_STORE_CONNECT_KEY_ID: "key",
    APP_STORE_CONNECT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
    APPLE_ROOT_CERTIFICATES_PEM: "-----BEGIN CERTIFICATE-----\nQUFB\n-----END CERTIFICATE-----",
    ...overrides
  }
}

const ctx = { waitUntil: () => undefined }

function worker(overrides: Partial<Parameters<typeof createStoreKitWorker>[0]> = {}) {
  return createStoreKitWorker({
    authenticate: () => ({ accountId: "account-1", appBundleId: "com.example.app" }),
    ...overrides
  })
}

describe("whole-Worker export", () => {
  it("answers 404 for an unrouted path rather than returning null", async () => {
    const response = await worker().fetch(new Request("https://example.com/nope"), env(), ctx)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ code: "NOT_FOUND", message: "Not found." })
  })

  it("hands an unrouted path to the host's own fetch when one is supplied", async () => {
    const fetch = vi.fn(() => new Response("mine", { status: 200 }))

    const response = await worker({ fetch }).fetch(
      new Request("https://example.com/mine"),
      env(),
      ctx
    )

    expect(await response.text()).toBe("mine")
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("routes StoreKit paths itself, without consulting the host's fetch", async () => {
    const fetch = vi.fn(() => null)

    const response = await worker({ fetch }).fetch(
      new Request("https://example.com/storekit/entitlement"),
      env(),
      ctx
    )

    expect(response.status).toBe(200)
    expect(fetch).not.toHaveBeenCalled()
  })

  /** The health route reports presence, never a secret's value. */
  it("serves a configuration report that carries no secret values", async () => {
    const response = await worker().fetch(
      new Request("https://example.com/storekit/health"),
      env(),
      ctx
    )

    expect(response.status).toBe(200)
    const body = JSON.stringify(await response.json())
    expect(body).toContain("APP_STORE_CONNECT_PRIVATE_KEY")
    expect(body).not.toContain("BEGIN PRIVATE KEY")
  })

  it("answers 503 on the health route when the deployment is misconfigured", async () => {
    const response = await worker().fetch(
      new Request("https://example.com/storekit/health"),
      env({ STOREKIT_BUNDLE_ID: "" }),
      ctx
    )

    expect(response.status).toBe(503)
  })

  it("stops serving the health route when it is turned off", async () => {
    const response = await worker({ healthPath: false }).fetch(
      new Request("https://example.com/storekit/health"),
      env(),
      ctx
    )

    expect(response.status).toBe(404)
  })
})
