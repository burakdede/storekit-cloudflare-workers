import { describe, expect, it } from "vitest"
import { MockD1Database } from "../helpers/mock-d1"
import { entitlementSnapshot } from "../helpers/snapshot"
import type { StoreKitEntitlementSnapshot } from "storekit-cloudflare-workers"
import {
  loadStoreKitSubscriptionByInstallation,
  persistStoreKitNotification,
  persistStoreKitSubscriptionForInstallation
} from "storekit-cloudflare-workers"

const snapshot = entitlementSnapshot({ appAccountToken: "account-token-1" })

function env(db = new MockD1Database()): D1Database {
  return db as unknown as D1Database
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

  it("round-trips the Family Sharing ownership type through both projections", async () => {
    const db = new MockD1Database()

    await persistStoreKitSubscriptionForInstallation(
      { ...snapshot, inAppOwnershipType: "FAMILY_SHARED" },
      "installation-1",
      "com.example.app",
      env(db)
    )

    expect(db.getStoreKitSubscriptionRows()[0]).toMatchObject({
      in_app_ownership_type: "FAMILY_SHARED"
    })
    expect(db.getStoreKitTransactionRows()[0]).toMatchObject({
      in_app_ownership_type: "FAMILY_SHARED"
    })
    expect(
      await loadStoreKitSubscriptionByInstallation(
        "installation-1",
        new Date("2026-06-03T12:00:00.000Z"),
        ["Sandbox"],
        env(db)
      )
    ).toMatchObject({ inAppOwnershipType: "FAMILY_SHARED" })
  })

  it("round-trips revocation type and percentage through both projections", async () => {
    const db = new MockD1Database()

    await persistStoreKitSubscriptionForInstallation(
      entitlementSnapshot({
        proActive: false,
        status: "refunded",
        revocationDate: "2026-06-02T12:00:00.000Z",
        revocationType: "REFUND_PRORATED",
        revocationPercentage: 40_000
      }),
      "installation-1",
      "com.example.app",
      env(db)
    )

    expect(db.getStoreKitSubscriptionRows()[0]).toMatchObject({
      revocation_type: "REFUND_PRORATED",
      revocation_percentage: 40_000
    })
    expect(db.getStoreKitTransactionRows()[0]).toMatchObject({
      revocation_type: "REFUND_PRORATED",
      revocation_percentage: 40_000
    })
    expect(
      await loadStoreKitSubscriptionByInstallation(
        "installation-1",
        new Date("2026-06-03T12:00:00.000Z"),
        ["Sandbox"],
        env(db)
      )
    ).toMatchObject({ revocationType: "REFUND_PRORATED", revocationPercentage: 40_000 })
  })

  it("round-trips the upgrade marker through both projections", async () => {
    const db = new MockD1Database()

    await persistStoreKitSubscriptionForInstallation(
      entitlementSnapshot({ proActive: false, status: "upgraded", isUpgraded: true }),
      "installation-1",
      "com.example.app",
      env(db)
    )

    // Kept in the audit trail as well as the projection: the upgrade history is worth having, it
    // just must not be what the entitlement is read from.
    expect(db.getStoreKitSubscriptionRows()[0]).toMatchObject({ is_upgraded: 1 })
    expect(db.getStoreKitTransactionRows()[0]).toMatchObject({ is_upgraded: 1 })
    expect(
      await loadStoreKitSubscriptionByInstallation(
        "installation-1",
        new Date("2026-06-03T12:00:00.000Z"),
        ["Sandbox"],
        env(db)
      )
    ).toMatchObject({ isUpgraded: 1 })
  })

  it("round-trips the subscription group through both projections", async () => {
    const db = new MockD1Database()

    await persistStoreKitSubscriptionForInstallation(
      entitlementSnapshot({ subscriptionGroupIdentifier: "group-pro" }),
      "installation-1",
      "com.example.app",
      env(db)
    )

    expect(db.getStoreKitSubscriptionRows()[0]).toMatchObject({
      subscription_group_identifier: "group-pro"
    })
    expect(db.getStoreKitTransactionRows()[0]).toMatchObject({
      subscription_group_identifier: "group-pro"
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

  describe("out-of-order write guard", () => {
    // Apple retries App Store Server Notifications V2 for days and does not guarantee delivery
    // order, so a late older event must not rewind newer entitlement state.
    const renewed: StoreKitEntitlementSnapshot = {
      ...snapshot,
      status: "active_paid",
      expiresAt: "2099-07-02T12:00:00.000Z",
      accessExpiresAt: "2099-07-02T12:00:00.000Z",
      latestTransactionId: "transaction-2",
      signedDate: "2026-06-10T12:00:00.000Z"
    }
    const staleExpiry: StoreKitEntitlementSnapshot = {
      ...snapshot,
      proActive: false,
      status: "expired",
      expiresAt: "2026-06-02T12:00:00.000Z",
      accessExpiresAt: "2026-06-02T12:00:00.000Z",
      signedDate: "2026-06-01T12:00:00.000Z"
    }

    it("ignores an older notification arriving after a newer one", async () => {
      const db = new MockD1Database()

      await persistStoreKitSubscriptionForInstallation(renewed, "installation-1", "app", env(db))
      await persistStoreKitSubscriptionForInstallation(
        staleExpiry,
        "installation-1",
        "app",
        env(db)
      )

      expect(db.getStoreKitSubscriptionRows()[0]).toMatchObject({
        status: "active_paid",
        latest_transaction_id: "transaction-2"
      })
    })

    it("applies a newer event on top of an older one", async () => {
      const db = new MockD1Database()

      await persistStoreKitSubscriptionForInstallation(
        staleExpiry,
        "installation-1",
        "app",
        env(db)
      )
      await persistStoreKitSubscriptionForInstallation(renewed, "installation-1", "app", env(db))

      expect(db.getStoreKitSubscriptionRows()[0]).toMatchObject({
        status: "active_paid"
      })
    })

    it("always applies a revocation, even one signed earlier than the stored state", async () => {
      const db = new MockD1Database()
      const refund: StoreKitEntitlementSnapshot = {
        ...snapshot,
        proActive: false,
        status: "refunded",
        revocationDate: "2026-06-05T12:00:00.000Z",
        revocationReason: 1,
        signedDate: "2026-06-05T12:00:00.000Z"
      }

      await persistStoreKitSubscriptionForInstallation(renewed, "installation-1", "app", env(db))
      await persistStoreKitSubscriptionForInstallation(refund, "installation-1", "app", env(db))

      expect(db.getStoreKitSubscriptionRows()[0]).toMatchObject({
        status: "refunded",
        revocation_reason: 1
      })
    })

    it("preserves the installation binding when a notification writes with no installation", async () => {
      const db = new MockD1Database()

      await persistStoreKitSubscriptionForInstallation(snapshot, "installation-1", "app", env(db))
      await persistStoreKitNotification(
        {
          uuid: "notification-3",
          type: "DID_RENEW",
          subtype: null,
          environment: "Sandbox",
          originalTransactionId: "original-1",
          transactionId: "transaction-2"
        },
        renewed,
        "app",
        env(db)
      )

      expect(db.getStoreKitSubscriptionRows()[0]).toMatchObject({
        installation_id: "installation-1",
        latest_transaction_id: "transaction-2"
      })
    })
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
})
