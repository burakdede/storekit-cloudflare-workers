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
} from "../../src/storekit"
import { StoreKitVerificationError } from "../../src/storekit"
import type * as StoreKitModule from "../../src/storekit"
import type * as StoreKitVerification from "../../src/storekit/verification"

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

const verifiedNotification = {
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
  renewalInfo: null,
  latestSubscription: null
}

const notificationRuntime = {
  environment: Environment.SANDBOX,
  bundleId: "com.example.app",
  allowedProductIds: new Set(["com.example.pro.monthly"]),
  allowAppleLookupFallback: true
} as unknown as StoreKitModule.StoreKitRuntime

vi.mock("../../src/storekit/verification", async () => {
  const actual = await vi.importActual<typeof StoreKitVerification>(
    "../../src/storekit/verification"
  )
  return {
    ...actual,
    verifyStoreKitTransaction: vi.fn(async () => verifiedTransaction),
    verifyStoreKitNotificationForRuntime: vi.fn(async () => ({
      verified: verifiedNotification,
      runtime: notificationRuntime
    })),
    verifyStoreKitNotification: vi.fn(async () => verifiedNotification)
  }
})

function d1Env(db: MockD1Database) {
  return db as unknown as D1Database
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

  it("treats a replayed notification uuid as already processed", async () => {
    const db = new MockD1Database()

    await processStoreKitNotification("signed-notification", {
      apple: appleConfig,
      d1: d1Env(db)
    })
    const replay = await processStoreKitNotification("signed-notification", {
      apple: appleConfig,
      d1: d1Env(db)
    })

    expect(replay).toMatchObject({ processed: true, replayed: true })
    expect(db.getStoreKitNotificationRows()).toHaveLength(1)
  })

  it("judges a stored grace-period record active past its subscription expiry", async () => {
    const db = new MockD1Database()
    db.seedStoreKitSubscription({
      original_transaction_id: "original-grace",
      environment: "Sandbox",
      installation_id: "installation-1",
      app_account_token: null,
      latest_transaction_id: "transaction-grace",
      app_bundle_id: "com.example.app",
      product_id: "com.example.pro.monthly",
      status: "grace_period",
      expires_at: "2026-05-25T12:00:00.000Z",
      access_expires_at: "2099-06-09T12:00:00.000Z",
      grace_period_expires_at: "2099-06-09T12:00:00.000Z",
      is_trial: 0,
      revocation_date: null,
      last_verified_at: "2026-06-01T12:00:00.000Z",
      created_at: "2026-06-01T12:00:00.000Z",
      updated_at: "2026-06-01T12:00:00.000Z"
    })

    const result = await getStoreKitEntitlement(
      "installation-1",
      ["Sandbox"],
      { d1: d1Env(db) },
      new Date("2026-06-02T12:00:00.000Z")
    )

    expect(result).toMatchObject({
      proActive: true,
      status: "grace_period",
      expiresAt: "2026-05-25T12:00:00.000Z",
      accessExpiresAt: "2099-06-09T12:00:00.000Z"
    })
  })

  it("keeps a perpetual non-consumable record active with no deadline", async () => {
    const db = new MockD1Database()
    db.seedStoreKitSubscription({
      original_transaction_id: "original-lifetime",
      environment: "Sandbox",
      installation_id: "installation-1",
      app_account_token: null,
      latest_transaction_id: "transaction-lifetime",
      app_bundle_id: "com.example.app",
      product_id: "com.example.pro.lifetime",
      status: "active_paid",
      expires_at: null,
      access_expires_at: null,
      perpetual: 1,
      is_trial: 0,
      revocation_date: null,
      last_verified_at: "2026-06-01T12:00:00.000Z",
      created_at: "2026-06-01T12:00:00.000Z",
      updated_at: "2026-06-01T12:00:00.000Z"
    })

    const result = await getStoreKitEntitlement(
      "installation-1",
      ["Sandbox"],
      { d1: d1Env(db) },
      new Date("2099-06-02T12:00:00.000Z")
    )

    expect(result).toMatchObject({
      proActive: true,
      status: "active_paid",
      accessExpiresAt: null
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
