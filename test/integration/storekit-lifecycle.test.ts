/**
 * A customer's whole lifecycle, through the whole stack.
 *
 * Every layer is tested on its own; nothing tested them composed. This drives real HTTP requests
 * through the mounted handler, with real ES256 signatures verified against a real certificate
 * chain, the real entitlement policy, and real SQLite behind real migrations.
 *
 * The only thing stubbed is `buildStoreKitRuntimes`, which is where Apple's credentials and network
 * client come from. Signature verification itself is not stubbed: the runtime it returns carries a
 * genuine `SignedDataVerifier` pinned to the test CA, so a forged payload fails here exactly as it
 * would in production.
 */
import { Environment, SignedDataVerifier, Status } from "@apple/app-store-server-library"
import { Buffer } from "node:buffer"
import { beforeEach, describe, expect, it } from "vitest"
import { createAppleTestCertificateAuthority } from "../helpers/apple-test-ca"
import { createSqliteD1 } from "./helpers/sqlite-d1"
import { parseAppleRootCertificatesPem } from "../../src/config"
import type { StoreKitD1Database } from "../../src/cloudflare"
import type { StoreKitRuntime } from "../../src/verification"

const BUNDLE_ID = "com.example.app"
const PRODUCT_ID = "com.example.pro.monthly"
const ORIGINAL_TRANSACTION_ID = "2000000412345678"
const SIGNED_AT = Date.parse("2026-05-26T12:00:00.000Z")
const EXPIRES_AT = Date.parse("2099-06-02T12:00:00.000Z")

const ca = createAppleTestCertificateAuthority()

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    transactionId: "2000000498765432",
    originalTransactionId: ORIGINAL_TRANSACTION_ID,
    bundleId: BUNDLE_ID,
    productId: PRODUCT_ID,
    environment: Environment.SANDBOX,
    type: "Auto-Renewable Subscription",
    inAppOwnershipType: "PURCHASED",
    subscriptionGroupIdentifier: "21234567",
    signedDate: SIGNED_AT,
    purchaseDate: Date.parse("2026-05-01T12:00:00.000Z"),
    expiresDate: EXPIRES_AT,
    price: 9990,
    currency: "USD",
    ...overrides
  }
}

/** Apple's status response, with every signed part genuinely signed by the test CA. */
let subscriptionStatus = () => ({
  environment: "Sandbox",
  bundleId: BUNDLE_ID,
  data: [
    {
      subscriptionGroupIdentifier: "21234567",
      lastTransactions: [
        {
          status: Status.ACTIVE,
          originalTransactionId: ORIGINAL_TRANSACTION_ID,
          signedTransactionInfo: ca.sign(transaction()),
          signedRenewalInfo: ca.sign({
            originalTransactionId: ORIGINAL_TRANSACTION_ID,
            autoRenewStatus: 1,
            autoRenewProductId: PRODUCT_ID,
            renewalDate: EXPIRES_AT,
            environment: Environment.SANDBOX,
            signedDate: SIGNED_AT
          })
        }
      ]
    }
  ]
})

let latestTransactionInfo = () => ca.sign(transaction())

function runtime(): StoreKitRuntime {
  const verifier = new SignedDataVerifier(
    parseAppleRootCertificatesPem(ca.rootCertificatePem) as unknown as Buffer[],
    false,
    Environment.SANDBOX,
    BUNDLE_ID
  )
  return {
    environment: "Sandbox",
    bundleId: BUNDLE_ID,
    allowedProductIds: new Set([PRODUCT_ID]),
    allowAppleLookupFallback: false,
    client: {
      getTransactionInfo: async () => ({ signedTransactionInfo: latestTransactionInfo() }),
      getAllSubscriptionStatuses: async () => subscriptionStatus() as never
    },
    verifier: {
      verifyAndDecodeTransaction: (jws: string) => verifier.verifyAndDecodeTransaction(jws),
      verifyAndDecodeNotification: (jws: string) => verifier.verifyAndDecodeNotification(jws),
      verifyAndDecodeRenewalInfo: (jws: string) => verifier.verifyAndDecodeRenewalInfo(jws)
    }
  }
}

import { createStoreKitHandler } from "../../src/router"

const env = {
  STOREKIT_ALLOWED_ENVIRONMENTS: "Sandbox",
  STOREKIT_BUNDLE_ID: BUNDLE_ID,
  STOREKIT_ALLOWED_PRODUCT_IDS: PRODUCT_ID,
  STOREKIT_ALLOW_APPLE_LOOKUP_FALLBACK: "false",
  APPLE_ROOT_CERTIFICATES_PEM: ca.rootCertificatePem,
  APP_STORE_CONNECT_ISSUER_ID: "issuer",
  APP_STORE_CONNECT_KEY_ID: "key",
  APP_STORE_CONNECT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----"
}

let d1: StoreKitD1Database

function handler(account: string | null = "account-1") {
  return createStoreKitHandler({
    authenticate: () => (account ? { accountId: account, appBundleId: BUNDLE_ID } : null),
    database: () => d1,
    // The real seam, not a module mock: only Apple's credentials and network client are supplied
    // here. The verifier inside is genuine and pinned to the test CA.
    runtimes: () => [runtime()]
  })
}

function post(path: string, body: unknown) {
  return new Request(`https://worker.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })
}

async function sync(account: string | null = "account-1", jws = ca.sign(transaction())) {
  const response = await handler(account).fetch(
    post("/storekit/transactions/sync", { signedTransactionJWS: jws }),
    { ...env, STOREKIT_DB: d1 } as never
  )
  return response!
}

async function readEntitlement(account = "account-1") {
  const response = await handler(account).fetch(
    new Request("https://worker.example.com/storekit/entitlement"),
    { ...env, STOREKIT_DB: d1 } as never
  )
  return (await response!.json()) as Record<string, unknown>
}

beforeEach(() => {
  d1 = createSqliteD1().d1
  subscriptionStatus = () => ({
    environment: "Sandbox",
    bundleId: BUNDLE_ID,
    data: [
      {
        subscriptionGroupIdentifier: "21234567",
        lastTransactions: [
          {
            status: Status.ACTIVE,
            originalTransactionId: ORIGINAL_TRANSACTION_ID,
            signedTransactionInfo: ca.sign(transaction()),
            signedRenewalInfo: ca.sign({
              originalTransactionId: ORIGINAL_TRANSACTION_ID,
              autoRenewStatus: 1,
              autoRenewProductId: PRODUCT_ID,
              renewalDate: EXPIRES_AT,
              environment: Environment.SANDBOX,
              signedDate: SIGNED_AT
            })
          }
        ]
      }
    ]
  })
  latestTransactionInfo = () => ca.sign(transaction())
})

describe("customer lifecycle end to end", () => {
  it("turns a signed purchase into a readable entitlement", async () => {
    const response = await sync()

    expect(response.status).toBe(200)
    const snapshot = (await response.json()) as Record<string, unknown>
    expect(snapshot).toMatchObject({
      proActive: true,
      status: "active_paid",
      productId: PRODUCT_ID,
      price: 9990,
      currency: "USD"
    })

    // Read back through the projection, from real SQLite, with expiry re-evaluated at read time.
    expect(await readEntitlement()).toMatchObject({
      proActive: true,
      status: "active_paid",
      productId: PRODUCT_ID,
      autoRenewStatus: 1
    })
  })

  it("rejects a purchase signed by a chain the deployment does not trust", async () => {
    const attacker = createAppleTestCertificateAuthority()

    const response = await sync("account-1", attacker.sign(transaction()))

    // A complete, well-formed, correctly-shaped chain — rooted somewhere else.
    expect(response.status).toBe(400)
    expect(await readEntitlement()).toMatchObject({ proActive: false, status: "free" })
  })

  it("refuses to move an entitlement to a second account", async () => {
    await sync("victim")

    const response = await sync("attacker")

    expect(response.status).toBe(409)
    expect(await readEntitlement("victim")).toMatchObject({ proActive: true })
    expect(await readEntitlement("attacker")).toMatchObject({ proActive: false, status: "free" })
  })

  it("answers 401 before authentication resolves an account", async () => {
    const response = await sync(null)

    expect(response.status).toBe(401)
  })

  it("revokes access when Apple reports a refund", async () => {
    await sync()
    expect(await readEntitlement()).toMatchObject({ proActive: true })

    const revoked = transaction({
      revocationDate: Date.parse("2026-05-27T12:00:00.000Z"),
      revocationType: "REFUND_FULL",
      signedDate: Date.parse("2026-05-27T12:00:00.000Z")
    })
    latestTransactionInfo = () => ca.sign(revoked)
    subscriptionStatus = () => ({
      environment: "Sandbox",
      bundleId: BUNDLE_ID,
      data: [
        {
          subscriptionGroupIdentifier: "21234567",
          lastTransactions: [
            {
              status: Status.REVOKED,
              originalTransactionId: ORIGINAL_TRANSACTION_ID,
              signedTransactionInfo: ca.sign(revoked),
              signedRenewalInfo: ca.sign({
                originalTransactionId: ORIGINAL_TRANSACTION_ID,
                environment: Environment.SANDBOX,
                signedDate: Date.parse("2026-05-27T12:00:00.000Z")
              })
            }
          ]
        }
      ]
    })

    const notification = await handler().fetch(
      post("/storekit/notifications", {
        signedPayload: ca.sign({
          notificationType: "REFUND",
          notificationUUID: "11111111-2222-3333-4444-555555555555",
          version: "2.0",
          signedDate: Date.parse("2026-05-27T12:00:00.000Z"),
          data: {
            bundleId: BUNDLE_ID,
            environment: Environment.SANDBOX,
            signedTransactionInfo: ca.sign(revoked)
          }
        })
      }),
      { ...env, STOREKIT_DB: d1 } as never
    )

    // `REFUND` carries no subscription status; the revocation date on the signed transaction is
    // what has to end access, and it must survive the whole stack to do it.
    expect(notification!.status).toBe(200)
    expect(await readEntitlement()).toMatchObject({ proActive: false, status: "refunded" })
  })

  it("answers a redelivered notification without writing twice", async () => {
    const payload = {
      signedPayload: ca.sign({
        notificationType: "DID_RENEW",
        notificationUUID: "99999999-8888-7777-6666-555555555555",
        version: "2.0",
        signedDate: SIGNED_AT,
        data: {
          bundleId: BUNDLE_ID,
          environment: Environment.SANDBOX,
          signedTransactionInfo: ca.sign(transaction())
        }
      })
    }

    const first = await handler().fetch(post("/storekit/notifications", payload), {
      ...env,
      STOREKIT_DB: d1
    } as never)
    const replay = await handler().fetch(post("/storekit/notifications", payload), {
      ...env,
      STOREKIT_DB: d1
    } as never)

    expect(first!.status).toBe(200)
    expect(replay!.status).toBe(200)
    expect(await replay!.json()).toMatchObject({ processed: true, replayed: true })
  })

  it("rejects a forged notification rather than granting on it", async () => {
    const attacker = createAppleTestCertificateAuthority()

    const response = await handler().fetch(
      post("/storekit/notifications", {
        signedPayload: attacker.sign({
          notificationType: "SUBSCRIBED",
          notificationUUID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          version: "2.0",
          signedDate: SIGNED_AT,
          data: {
            bundleId: BUNDLE_ID,
            environment: Environment.SANDBOX,
            signedTransactionInfo: attacker.sign(transaction())
          }
        })
      }),
      { ...env, STOREKIT_DB: d1 } as never
    )

    // The webhook is unauthenticated at the HTTP layer; the signature is the only control.
    expect(response!.status).toBe(401)
    expect(await readEntitlement()).toMatchObject({ proActive: false, status: "free" })
  })
})
