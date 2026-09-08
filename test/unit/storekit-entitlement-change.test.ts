/**
 * The entitlement change hook.
 *
 * Storing the entitlement is only half of an integration. The other half is the host reacting:
 * mirroring the tier onto its own tables, sending the payment-failure push that saves a
 * subscription, releasing resources on a refund.
 */
import {
  Environment,
  Status,
  type JWSTransactionDecodedPayload
} from "@apple/app-store-server-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { MockD1Database } from "../helpers/mock-d1"
import {
  processStoreKitNotification,
  syncStoreKitTransaction,
  type StoreKitEntitlementChange
} from "storekit-cloudflare-workers"
import type * as StoreKitModule from "storekit-cloudflare-workers"
import type * as StoreKitVerification from "../../src/verification"

const transaction: JWSTransactionDecodedPayload = {
  transactionId: "transaction-hook-1",
  originalTransactionId: "original-hook-1",
  bundleId: "com.example.app",
  productId: "com.example.pro.monthly",
  environment: Environment.SANDBOX,
  expiresDate: Date.parse("2099-06-02T12:00:00.000Z")
}

const verifiedTransaction = {
  environment: Environment.SANDBOX,
  transaction,
  statusResponse: { environment: Environment.SANDBOX, bundleId: "com.example.app", data: [] },
  latestSubscription: {
    status: Status.ACTIVE,
    originalTransactionId: transaction.originalTransactionId,
    signedTransactionInfo: "signed-transaction"
  },
  subscriptionTransactions: [],
  verificationSource: "submitted_jws" as const
}

const notificationRuntime = {
  environment: Environment.SANDBOX,
  bundleId: "com.example.app",
  allowedProductIds: new Set(["com.example.pro.monthly"]),
  allowAppleLookupFallback: true
} as unknown as StoreKitModule.StoreKitRuntime

function verifiedNotification(uuid: string, type = "DID_RENEW") {
  return {
    environment: Environment.SANDBOX,
    notification: {
      version: "2.0",
      notificationUUID: uuid,
      notificationType: type,
      subtype: null,
      data: { environment: Environment.SANDBOX, bundleId: "com.example.app" }
    },
    transaction,
    renewalInfo: null,
    latestSubscription: {
      status: Status.ACTIVE,
      originalTransactionId: transaction.originalTransactionId,
      signedTransactionInfo: "signed-transaction"
    }
  }
}

let currentNotification = verifiedNotification("notification-hook-1")

vi.mock("../../src/verification", async () => {
  const actual = await vi.importActual<typeof StoreKitVerification>("../../src/verification")
  return {
    ...actual,
    verifyStoreKitTransaction: vi.fn(async () => verifiedTransaction),
    verifyStoreKitNotificationForRuntime: vi.fn(async () => ({
      verified: currentNotification,
      runtime: notificationRuntime
    }))
  }
})

const appleConfig = {
  STOREKIT_ALLOWED_ENVIRONMENTS: "Sandbox",
  STOREKIT_BUNDLE_ID: "com.example.app",
  STOREKIT_ALLOWED_PRODUCT_IDS: "com.example.pro.monthly"
}

function syncInput(installationId = "account-1") {
  return {
    signedTransactionJWS: "a".repeat(64),
    installationId,
    appBundleId: "com.example.app"
  }
}

function config(db: MockD1Database, overrides: Record<string, unknown> = {}) {
  return {
    apple: appleConfig,
    d1: db as unknown as D1Database,
    // Reconciling would re-read Apple; the payload is enough for these.
    reconcileNotificationsWithApple: false,
    ...overrides
  } as Parameters<typeof syncStoreKitTransaction>[1]
}

describe("StoreKit entitlement change hook", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    currentNotification = verifiedNotification("notification-hook-1")
  })

  it("fires on a first purchase, with no previous state", async () => {
    const db = new MockD1Database()
    const changes: StoreKitEntitlementChange[] = []

    await syncStoreKitTransaction(
      syncInput(),
      config(db, {
        onEntitlementChange: (change: StoreKitEntitlementChange) => changes.push(change)
      })
    )

    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      accountId: "account-1",
      previous: null,
      source: "sync"
    })
    expect(changes[0]?.next.status).toBe("active_paid")
  })

  it("does not fire when an identical sync changes nothing", async () => {
    const db = new MockD1Database()
    const changes: StoreKitEntitlementChange[] = []
    const hook = (change: StoreKitEntitlementChange) => changes.push(change)

    await syncStoreKitTransaction(syncInput(), config(db, { onEntitlementChange: hook }))
    await syncStoreKitTransaction(syncInput(), config(db, { onEntitlementChange: hook }))

    // A client re-syncing at every launch must not look like a subscription event.
    expect(changes).toHaveLength(1)
  })

  it("reports which fields changed", async () => {
    const db = new MockD1Database()
    const changes: StoreKitEntitlementChange[] = []
    const hook = (change: StoreKitEntitlementChange) => changes.push(change)

    await syncStoreKitTransaction(syncInput(), config(db, { onEntitlementChange: hook }))
    currentNotification = verifiedNotification("notification-hook-2", "REFUND")
    currentNotification.transaction = {
      ...transaction,
      revocationDate: Date.parse("2026-05-20T12:00:00.000Z"),
      revocationType: "REFUND_FULL"
    } as JWSTransactionDecodedPayload
    await processStoreKitNotification("payload", config(db, { onEntitlementChange: hook }))

    expect(changes).toHaveLength(2)
    expect(changes[1]).toMatchObject({
      source: "notification",
      notification: { type: "REFUND", uuid: "notification-hook-2" }
    })
    expect(changes[1]?.changed).toEqual(
      expect.arrayContaining(["proActive", "status", "revocationType"])
    )
    expect(changes[1]?.previous).toMatchObject({ status: "active_paid" })
    expect(changes[1]?.next.status).toBe("refunded")
  })

  it("does not fire for a replayed notification", async () => {
    const db = new MockD1Database()
    const changes: StoreKitEntitlementChange[] = []
    const hook = (change: StoreKitEntitlementChange) => changes.push(change)

    await processStoreKitNotification("payload", config(db, { onEntitlementChange: hook }))
    const replay = await processStoreKitNotification(
      "payload",
      config(db, { onEntitlementChange: hook })
    )

    expect(replay.replayed).toBe(true)
    expect(changes).toHaveLength(1)
  })

  it("attributes a notification change to the account that owns the entitlement", async () => {
    const db = new MockD1Database()
    const changes: StoreKitEntitlementChange[] = []
    const hook = (change: StoreKitEntitlementChange) => changes.push(change)

    await syncStoreKitTransaction(syncInput("account-7"), config(db, { onEntitlementChange: hook }))
    currentNotification = verifiedNotification("notification-hook-3", "EXPIRED")
    currentNotification.latestSubscription = {
      ...currentNotification.latestSubscription,
      status: Status.EXPIRED
    }
    await processStoreKitNotification("payload", config(db, { onEntitlementChange: hook }))

    // A notification never binds an account, so the hook takes it from the stored row. Without
    // this the host would be told an entitlement changed and not whose.
    expect(changes[1]).toMatchObject({ accountId: "account-7", source: "notification" })
  })

  it("does not let a throwing hook fail the write", async () => {
    const db = new MockD1Database()
    const errors: unknown[] = []

    const result = await syncStoreKitTransaction(
      syncInput(),
      config(db, {
        onEntitlementChange: () => {
          throw new Error("host database is down")
        },
        onEntitlementChangeError: (error: unknown) => errors.push(error)
      })
    )

    // The write committed. Failing here would make Apple redeliver a notification that was in fact
    // processed, or turn a successful purchase into a server error.
    expect(result.snapshot.proActive).toBe(true)
    expect(db.getStoreKitSubscriptionRows()).toHaveLength(1)
    expect(errors).toHaveLength(1)
  })

  it("costs no extra read when no hook is configured", async () => {
    const withoutHook = new MockD1Database()
    const withHook = new MockD1Database()

    await syncStoreKitTransaction(syncInput(), config(withoutHook))
    await syncStoreKitTransaction(syncInput(), config(withHook, { onEntitlementChange: () => {} }))

    // The previous-state read exists only to feed the hook, so nobody else should pay for it.
    expect(withHook.preparedSql.length).toBe(withoutHook.preparedSql.length + 1)
  })
})
