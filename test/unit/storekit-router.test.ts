import { beforeEach, describe, expect, it, vi } from "vitest"
import { MockD1Database } from "../helpers/mock-d1"
import { createStoreKitHandler } from "../../src/router"
import {
  StoreKitOwnershipConflictError,
  StoreKitPersistenceError,
  StoreKitVerificationError
} from "../../src/errors"
import type * as StoreKitService from "../../src/service"

const snapshot = {
  proActive: true,
  productId: "com.example.pro.monthly",
  status: "active_paid",
  environment: "Sandbox",
  originalTransactionId: "original-1",
  latestTransactionId: "transaction-1"
}

const syncStoreKitTransaction = vi.fn()
const processStoreKitNotification = vi.fn()

vi.mock("../../src/service", async (importOriginal) => {
  const actual = await importOriginal<typeof StoreKitService>()
  return {
    ...actual,
    syncStoreKitTransaction: (...args: unknown[]) => syncStoreKitTransaction(...args),
    processStoreKitNotification: (...args: unknown[]) => processStoreKitNotification(...args)
  }
})

function env() {
  return {
    STOREKIT_DB: new MockD1Database() as unknown as D1Database,
    STOREKIT_ALLOWED_ENVIRONMENTS: "Sandbox",
    STOREKIT_BUNDLE_ID: "com.example.app",
    STOREKIT_ALLOWED_PRODUCT_IDS: "com.example.pro.monthly"
  }
}

function handler(overrides: Partial<Parameters<typeof createStoreKitHandler>[0]> = {}) {
  return createStoreKitHandler({
    authenticate: () => ({
      accountId: "account-1",
      appBundleId: "com.example.app"
    }),
    ...overrides
  })
}

const validJws = "a".repeat(64)

function syncRequest(body: unknown) {
  return new Request("https://example.com/storekit/transactions/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })
}

describe("StoreKit drop-in router", () => {
  beforeEach(() => vi.clearAllMocks())

  it("ignores requests that are not StoreKit routes so it composes with a host router", async () => {
    const response = await handler().fetch(new Request("https://example.com/other"), env())

    expect(response).toBeNull()
  })

  it("rejects an unauthenticated sync without calling Apple", async () => {
    const response = await handler({ authenticate: () => null }).fetch(
      syncRequest({ signedTransactionJWS: validJws }),
      env()
    )

    expect(response?.status).toBe(401)
    expect(syncStoreKitTransaction).not.toHaveBeenCalled()
  })

  it("never authenticates the Apple webhook, which authenticates by JWS signature", async () => {
    const authenticate = vi.fn(() => null)
    processStoreKitNotification.mockResolvedValueOnce({
      processed: true,
      replayed: false,
      reconciled: true,
      snapshot: null,
      verified: { notification: { notificationType: "TEST" } }
    })

    const response = await handler({ authenticate }).fetch(
      new Request("https://example.com/storekit/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signedPayload: validJws })
      }),
      env()
    )

    expect(response?.status).toBe(200)
    expect(authenticate).not.toHaveBeenCalled()
  })

  it("binds the sync to the authenticated account", async () => {
    syncStoreKitTransaction.mockResolvedValueOnce({ snapshot, verified: {} })

    const response = await handler({
      authenticate: () => ({
        accountId: "account-1",
        appBundleId: "com.example.app",
        expectedAppAccountToken: "0198bfd5-3d05-7c6d-9d5a-4b8a2f1c0001"
      })
    }).fetch(syncRequest({ signedTransactionJWS: validJws }), env())

    expect(response?.status).toBe(200)
    expect(syncStoreKitTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: "account-1",
        expectedAppAccountToken: "0198bfd5-3d05-7c6d-9d5a-4b8a2f1c0001"
      }),
      expect.anything()
    )
  })

  it.each([
    { name: "a missing JWS", body: {} },
    {
      name: "a JWS below the minimum length",
      body: { signedTransactionJWS: "short" }
    },
    {
      name: "a malformed app account token",
      body: { signedTransactionJWS: validJws, appAccountToken: "not-a-uuid" }
    }
  ])("rejects $name before reaching verification", async ({ body }) => {
    const response = await handler().fetch(syncRequest(body), env())

    expect(response?.status).toBe(400)
    expect(syncStoreKitTransaction).not.toHaveBeenCalled()
  })

  it("rejects a wrong method rather than treating it as an unknown route", async () => {
    const response = await handler().fetch(
      new Request("https://example.com/storekit/transactions/sync", {
        method: "GET"
      }),
      env()
    )

    expect(response?.status).toBe(405)
  })

  it("does not disclose which verification stage rejected a transaction", async () => {
    syncStoreKitTransaction.mockRejectedValueOnce(
      new StoreKitVerificationError("nope", "submitted_jws_claims")
    )
    const events: Record<string, unknown>[] = []

    const response = await handler({
      onEvent: (event) => events.push(event)
    }).fetch(syncRequest({ signedTransactionJWS: validJws }), env())
    const body = (await response?.json()) as { message: string }

    expect(response?.status).toBe(400)
    expect(body.message).toBe("StoreKit transaction could not be verified.")
    expect(JSON.stringify(body)).not.toContain("submitted_jws_claims")
    // The stage still reaches the operator through the log sink.
    expect(events.at(-1)).toMatchObject({
      verificationStage: "submitted_jws_claims"
    })
  })

  it("answers 409 when the transaction belongs to a different account", async () => {
    syncStoreKitTransaction.mockRejectedValueOnce(
      new StoreKitOwnershipConflictError("original-1", "Sandbox")
    )
    const events: Record<string, unknown>[] = []

    const response = await handler({
      onEvent: (event) => events.push(event)
    }).fetch(syncRequest({ signedTransactionJWS: validJws }), env())
    const body = (await response?.json()) as { code: string; message: string }

    // Unlike a verification failure this one is explained: the caller already holds the
    // transaction, so nothing is disclosed, and a client can only build a recovery flow if it is
    // told the purchase belongs elsewhere rather than that it failed to verify.
    expect(response?.status).toBe(409)
    expect(body.code).toBe("OWNERSHIP_CONFLICT")
    expect(body.message).toBe("This purchase is already associated with a different account.")
    expect(events.at(-1)).toMatchObject({
      event: "storekit_transaction_sync_ownership_conflict",
      originalTransactionId: "original-1"
    })
  })

  it("reports an entitlement change hook failure to the event sink without failing the request", async () => {
    // The service swallows the hook error and reports it; the router turns that into an event.
    syncStoreKitTransaction.mockImplementationOnce(
      async (_input: unknown, config: { onEntitlementChangeError?: (_e: unknown) => void }) => {
        config.onEntitlementChangeError?.(new Error("host database is down"))
        return { snapshot, verified: {} }
      }
    )
    const events: Record<string, unknown>[] = []

    const response = await handler({
      onEntitlementChange: () => {},
      onEvent: (event) => events.push(event)
    }).fetch(syncRequest({ signedTransactionJWS: validJws }), env())

    expect(response?.status).toBe(200)
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "storekit_entitlement_change_hook_failed",
        message: "host database is down"
      })
    )
  })

  it("hands the change hook to waitUntil when asked, so it outlives the response", async () => {
    const pending: Promise<unknown>[] = []
    let deliver: ((_change: unknown) => void | Promise<void>) | undefined
    syncStoreKitTransaction.mockImplementationOnce(
      async (_input: unknown, config: { onEntitlementChange?: (_c: unknown) => void }) => {
        deliver = config.onEntitlementChange
        return { snapshot, verified: {} }
      }
    )
    let hookRan = false

    const response = await handler({
      entitlementChangeMode: "waitUntil",
      onEntitlementChange: async () => {
        hookRan = true
      }
    }).fetch(syncRequest({ signedTransactionJWS: validJws }), env(), {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise)
    })
    deliver?.({})

    expect(response?.status).toBe(200)
    expect(pending).toHaveLength(1)
    await Promise.all(pending)
    expect(hookRan).toBe(true)
  })

  it("serves every entitlement alongside the best one", async () => {
    const db = new MockD1Database()
    const workerEnv = { ...env(), STOREKIT_DB: db as unknown as D1Database }

    const response = await handler().fetch(
      new Request("https://example.com/storekit/entitlement"),
      workerEnv
    )
    const body = (await response?.json()) as { status: string; entitlements: unknown[] }

    // The top-level fields stay exactly as they were, so a one-product client needs no change.
    expect(response?.status).toBe(200)
    expect(body.status).toBe("free")
    expect(body.entitlements).toEqual([])
  })

  it("answers 503 for a retryable storage failure so Apple redelivers", async () => {
    processStoreKitNotification.mockRejectedValueOnce(
      new StoreKitPersistenceError("d1 down", "storekit_notification_insert", true)
    )

    const response = await handler().fetch(
      new Request("https://example.com/storekit/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signedPayload: validJws })
      }),
      env()
    )

    expect(response?.status).toBe(503)
  })

  it("answers 401 for an unverifiable notification so a forged payload is never accepted", async () => {
    processStoreKitNotification.mockRejectedValueOnce(
      new StoreKitVerificationError("bad signature", "notification_jws_decode")
    )

    const response = await handler().fetch(
      new Request("https://example.com/storekit/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signedPayload: validJws })
      }),
      env()
    )

    expect(response?.status).toBe(401)
  })

  it("mounts under a caller-supplied prefix", async () => {
    const mounted = handler({ paths: { sync: "/api/v1/iap/sync" } })
    syncStoreKitTransaction.mockResolvedValueOnce({ snapshot, verified: {} })

    const response = await mounted.fetch(
      new Request("https://example.com/api/v1/iap/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signedTransactionJWS: validJws })
      }),
      env()
    )

    expect(response?.status).toBe(200)
    expect(mounted.paths.notifications).toBe("/storekit/notifications")
  })

  it("serves the stored entitlement projection for the authenticated account", async () => {
    const response = await handler().fetch(
      new Request("https://example.com/storekit/entitlement"),
      env()
    )
    const body = (await response?.json()) as {
      proActive: boolean
      status: string
    }

    expect(response?.status).toBe(200)
    expect(body).toMatchObject({ proActive: false, status: "free" })
  })
})
