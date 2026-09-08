/**
 * The adopter testing recipe from `docs/testing.md`, compiled and run.
 *
 * The guide tells adopters they can exercise the whole stack with plain-JSON fixtures and a verifier
 * that just parses them — no certificates, no signing keys, no App Store Connect credentials. That
 * claim is load-bearing: if it stops being true, someone follows the guide and gets an error they
 * cannot explain.
 *
 * A documented example nothing compiles is how a `runtimes` snippet shipped referencing a variable
 * that does not exist at Worker module scope. This is that lesson applied.
 */
import { describe, expect, it } from "vitest"
import { createStoreKitHandler } from "../../src/router"
import { resolveStoreKitEntitlementCore } from "../../src/entitlement"
import { createSqliteD1 } from "./helpers/sqlite-d1"
import type { StoreKitD1Database } from "../../src/cloudflare"
import type { StoreKitRuntime } from "../../src/verification"

const BUNDLE_ID = "com.example.app"
const PRODUCT_ID = "com.example.pro.monthly"

const transaction = {
  transactionId: "tx-1",
  originalTransactionId: "otx-1",
  bundleId: BUNDLE_ID,
  productId: PRODUCT_ID,
  environment: "Sandbox",
  type: "Auto-Renewable Subscription",
  signedDate: Date.parse("2026-06-01T00:00:00Z"),
  expiresDate: Date.parse("2099-01-01T00:00:00Z")
}

const decode = async (jws: string) => JSON.parse(jws)

/** Exactly the shape documented in docs/testing.md. */
function stubbedAppleRuntime(): StoreKitRuntime {
  return {
    environment: "Sandbox",
    bundleId: BUNDLE_ID,
    allowedProductIds: new Set([PRODUCT_ID]),
    allowAppleLookupFallback: false,
    client: {
      getTransactionInfo: async () => ({ signedTransactionInfo: JSON.stringify(transaction) }),
      getAllSubscriptionStatuses: async () => ({
        environment: "Sandbox",
        bundleId: BUNDLE_ID,
        data: [
          {
            lastTransactions: [
              {
                status: 1,
                originalTransactionId: "otx-1",
                signedTransactionInfo: JSON.stringify(transaction)
              }
            ]
          }
        ]
      })
    },
    verifier: {
      verifyAndDecodeTransaction: decode,
      verifyAndDecodeNotification: decode,
      verifyAndDecodeRenewalInfo: decode
    }
  } as unknown as StoreKitRuntime
}

function workerEnv(d1: StoreKitD1Database) {
  return {
    STOREKIT_ALLOWED_ENVIRONMENTS: "Sandbox",
    STOREKIT_BUNDLE_ID: BUNDLE_ID,
    STOREKIT_ALLOWED_PRODUCT_IDS: PRODUCT_ID,
    // The guide's instruction: off in tests, so an unreachable Apple fails instead of degrading.
    STOREKIT_ALLOW_APPLE_LOOKUP_FALLBACK: "false",
    STOREKIT_DB: d1
  } as never
}

describe("the adopter testing recipe", () => {
  it("runs the whole stack on plain-JSON fixtures, with no crypto or credentials", async () => {
    const { d1 } = createSqliteD1()
    const storekit = createStoreKitHandler({
      authenticate: () => ({ accountId: "user-1", appBundleId: BUNDLE_ID }),
      database: () => d1,
      runtimes: () => [stubbedAppleRuntime()]
    })
    const env = workerEnv(d1)

    const sync = await storekit.fetch(
      new Request("https://worker.example.com/storekit/transactions/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signedTransactionJWS: JSON.stringify(transaction) })
      }),
      env
    )
    const read = await storekit.fetch(
      new Request("https://worker.example.com/storekit/entitlement"),
      env
    )

    expect(sync?.status).toBe(200)
    expect(read?.status).toBe(200)
    expect(await read!.json()).toMatchObject({ proActive: true, productId: PRODUCT_ID })
  })

  it("still answers 401 when the host's authenticate declines", async () => {
    const { d1 } = createSqliteD1()
    const storekit = createStoreKitHandler({
      authenticate: () => null,
      database: () => d1,
      runtimes: () => [stubbedAppleRuntime()]
    })

    const response = await storekit.fetch(
      new Request("https://worker.example.com/storekit/entitlement"),
      workerEnv(d1)
    )

    // The guide says authentication stays yours and stays real under this recipe.
    expect(response?.status).toBe(401)
  })

  it("resolves tier rules through the pure kernel, as the guide's first example does", () => {
    const snapshot = resolveStoreKitEntitlementCore(
      {
        environment: "Sandbox",
        transaction: {
          transactionId: "tx-1",
          originalTransactionId: "otx-1",
          productId: "com.example.pro.annual",
          expiresDate: Date.parse("2099-01-01T00:00:00Z")
        },
        latestSubscriptionStatus: 1,
        subscriptionTransactions: [],
        verificationSource: "posted_jws"
      },
      new Date("2026-06-01T00:00:00Z")
    )

    expect(snapshot).toMatchObject({ proActive: true, status: "active_paid" })
  })
})
