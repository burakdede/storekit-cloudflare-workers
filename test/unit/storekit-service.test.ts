import {
  Environment,
  Status,
  type JWSTransactionDecodedPayload
} from "@apple/app-store-server-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { MockD1Database } from "../helpers/mock-d1"
import {
  getStoreKitEntitlement,
  processStoreKitNotification,
  syncStoreKitTransaction
} from "../../src/lib/storekit-service"
import { StoreKitVerificationError } from "../../src/storekit"
import type * as StoreKitModule from "../../src/storekit"

const transaction: JWSTransactionDecodedPayload = {
  transactionId: "transaction-service-1",
  originalTransactionId: "original-service-1",
  bundleId: "com.example.app",
  productId: "com.example.pro.monthly",
  environment: Environment.SANDBOX,
  expiresDate: Date.parse("2099-06-02T12:00:00.000Z")
}

const appleConfig = {
  STOREKIT_ALLOWED_ENVIRONMENTS: "Sandbox",
  STOREKIT_BUNDLE_ID: "com.example.app",
  STOREKIT_ALLOWED_PRODUCT_IDS: "com.example.pro.monthly"
}

const verifiedTransaction = {
  environment: Environment.SANDBOX,
  transaction,
  statusResponse: {
    environment: Environment.SANDBOX,
    bundleId: "com.example.app",
    data: []
  },
  latestSubscription: {
    status: Status.ACTIVE,
    originalTransactionId: transaction.originalTransactionId,
    signedTransactionInfo: "signed-transaction"
  },
  subscriptionTransactions: [],
  verificationSource: "submitted_jws" as const
}

vi.mock("../../src/storekit", async () => {
  const actual =
    await vi.importActual<typeof StoreKitModule>("../../src/storekit")
  return {
    ...actual,
    verifyStoreKitTransaction: vi.fn(async () => verifiedTransaction),
    verifyStoreKitNotification: vi.fn(async () => ({
      environment: Environment.SANDBOX,
      notification: {
        version: "2.0",
        notificationUUID: "notification-service-1",
        notificationType: "TEST",
        data: {
          environment: Environment.SANDBOX,
          bundleId: "com.example.app"
        }
      },
      transaction: null,
      latestSubscription: null
    }))
  }
})

function d1Env(db: MockD1Database) {
  return { STOREKIT_DB: db as unknown as D1Database }
}

describe("StoreKit service orchestration", () => {
  beforeEach(() => vi.clearAllMocks())

  it("syncs a verified transaction without requiring an app-account token", async () => {
    const db = new MockD1Database()

    const result = await syncStoreKitTransaction(
      {
        signedTransactionJWS: "signed-transaction",
        expectedAppAccountToken: "installation-1",
        installationId: "installation-1",
        appBundleId: "com.example.app"
      },
      { apple: appleConfig, d1: d1Env(db) }
    )

    expect(result.snapshot.proActive).toBe(true)
    expect(db.getStoreKitSubscriptionRows()).toHaveLength(1)
  })

  it("rejects a sandbox transaction before D1 persistence when the host policy disallows it", async () => {
    const db = new MockD1Database()

    await expect(
      syncStoreKitTransaction(
        {
          signedTransactionJWS: "signed-transaction",
          installationId: "installation-1",
          appBundleId: "com.example.app"
        },
        { apple: appleConfig, d1: d1Env(db), sandboxAllowed: false }
      )
    ).rejects.toBeInstanceOf(StoreKitVerificationError)
    expect(db.getStoreKitSubscriptionRows()).toHaveLength(0)
  })

  it("rejects a persistence bundle that differs from the verified app configuration", async () => {
    await expect(
      syncStoreKitTransaction(
        {
          signedTransactionJWS: "signed-transaction",
          installationId: "installation-1",
          appBundleId: "com.attacker.app"
        },
        { apple: appleConfig, d1: d1Env(new MockD1Database()) }
      )
    ).rejects.toMatchObject({ stage: "app_bundle_claims" })
  })

  it("processes a notification through the same verified service boundary", async () => {
    const db = new MockD1Database()

    const result = await processStoreKitNotification("signed-notification", {
      apple: appleConfig,
      d1: d1Env(db)
    })

    expect(result).toMatchObject({
      processed: true,
      replayed: false,
      snapshot: null
    })
    expect(db.getStoreKitNotificationRows()).toHaveLength(1)
  })

  it("returns replayed for a duplicate notification UUID", async () => {
    const db = new MockD1Database()
    const config = { apple: appleConfig, d1: d1Env(db) }
    await processStoreKitNotification("signed-notification", config)
    await expect(
      processStoreKitNotification("signed-notification", config)
    ).resolves.toMatchObject({
      processed: true,
      replayed: true,
      snapshot: null
    })
  })

  it("returns a free projection when no installation entitlement exists", async () => {
    const result = await getStoreKitEntitlement(
      "installation-1",
      ["Sandbox"],
      { d1: d1Env(new MockD1Database()) },
      new Date("2026-06-02T12:00:00.000Z")
    )

    expect(result).toMatchObject({
      proActive: false,
      status: "free",
      environment: "Sandbox",
      appAccountToken: null
    })
  })
})
