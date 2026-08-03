import { describe, expect, it } from "vitest"
import { MockD1Database } from "../helpers/mock-d1"
import {
  loadStoreKitSubscriptionByInstallation,
  persistStoreKitNotification,
  persistStoreKitSubscriptionForInstallation,
  storeKitNotificationExists,
  StoreKitPersistenceError
} from "../../src/lib/storekit-d1"
import type { StoreKitEntitlementSnapshot } from "../../src/storekit"
import type { StoreKitD1Env } from "../../src/lib/storekit-d1"

const snapshot: StoreKitEntitlementSnapshot = {
  proActive: true,
  productId: "com.example.pro.monthly",
  expiresAt: "2099-06-02T12:00:00.000Z",
  isTrial: false,
  status: "active_paid",
  environment: "Sandbox",
  originalTransactionId: "original-1",
  latestTransactionId: "transaction-1",
  webOrderLineItemId: "web-order-1",
  purchaseDate: "2026-06-01T12:00:00.000Z",
  revocationDate: null,
  appAccountToken: "account-token-1",
  source: "posted_jws",
  resolvedAt: "2026-06-02T12:00:00.000Z"
}

function env(db = new MockD1Database()): StoreKitD1Env {
  return { STOREKIT_DB: db as unknown as D1Database }
}

describe("StoreKit D1 adapter", () => {
  it("writes transaction and subscription projections atomically as one adapter operation", async () => {
    const db = new MockD1Database()

    await persistStoreKitSubscriptionForInstallation(
      snapshot,
      "installation-1",
      "com.example.app",
      env(db)
    )

    expect(db.getStoreKitTransactionRows()).toHaveLength(1)
    expect(db.getStoreKitSubscriptionRows()).toHaveLength(1)
    expect(db.getStoreKitSubscriptionRows()[0]).toMatchObject({
      installation_id: "installation-1",
      original_transaction_id: "original-1",
      status: "active_paid"
    })
  })

  it("records transaction-less notifications without creating entitlement state", async () => {
    const db = new MockD1Database()

    await persistStoreKitNotification(
      {
        uuid: "notification-1",
        type: "RENEWAL_EXTENSION",
        subtype: "SUMMARY",
        environment: "Sandbox",
        originalTransactionId: null,
        transactionId: null
      },
      null,
      "com.example.app",
      env(db)
    )

    expect(db.getStoreKitNotificationRows()).toHaveLength(1)
    expect(db.getStoreKitTransactionRows()).toHaveLength(0)
    expect(db.getStoreKitSubscriptionRows()).toHaveLength(0)
  })

  it("records a notification and entitlement projection in the same D1 batch", async () => {
    const db = new MockD1Database()

    await persistStoreKitNotification(
      {
        uuid: "notification-2",
        type: "DID_RENEW",
        subtype: null,
        environment: "Sandbox",
        originalTransactionId: "original-1",
        transactionId: "transaction-1"
      },
      snapshot,
      "com.example.app",
      env(db)
    )

    expect(db.getStoreKitNotificationRows()).toHaveLength(1)
    expect(db.getStoreKitTransactionRows()).toHaveLength(1)
    expect(db.getStoreKitSubscriptionRows()).toHaveLength(1)
  })

  it("does not query inaccessible environments", async () => {
    const db = new MockD1Database()

    await expect(
      loadStoreKitSubscriptionByInstallation(
        "installation-1",
        new Date("2026-06-02T12:00:00.000Z"),
        [],
        env(db)
      )
    ).resolves.toBeNull()
  })

  it("fails clearly when the D1 binding is absent or identity is incomplete", async () => {
    await expect(
      storeKitNotificationExists("notification-1", {})
    ).rejects.toBeInstanceOf(StoreKitPersistenceError)
    await expect(
      persistStoreKitSubscriptionForInstallation(
        { ...snapshot, latestTransactionId: null },
        "installation-1",
        "com.example.app",
        env()
      )
    ).rejects.toMatchObject({ operation: "projection_validation" })
  })

  it("treats notification UUID persistence as idempotent", async () => {
    const db = new MockD1Database()
    await persistStoreKitNotification(
      {
        uuid: "notification-duplicate",
        type: "TEST",
        subtype: null,
        environment: "Sandbox",
        originalTransactionId: null,
        transactionId: null
      },
      null,
      "com.example.app",
      env(db)
    )
    expect(
      await storeKitNotificationExists("notification-duplicate", env(db))
    ).toBe(true)
  })
})
