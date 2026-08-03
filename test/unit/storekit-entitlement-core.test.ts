import { describe, expect, it } from "vitest"
import {
  resolveStoreKitEntitlementCore,
  type StoreKitEntitlementInput
} from "../../src/lib/storekit-entitlement-core"

const now = new Date("2026-05-26T12:00:00.000Z")
const future = Date.parse("2099-06-02T12:00:00.000Z")

function input(status: number | undefined = 1): StoreKitEntitlementInput {
  const transaction = {
    transactionId: "transaction-core",
    originalTransactionId: "original-core",
    productId: "com.example.pro.monthly",
    expiresDate: future
  }
  return {
    environment: "Sandbox" as const,
    transaction,
    latestSubscriptionStatus: status,
    subscriptionTransactions: [],
    verificationSource: "posted_jws" as const
  }
}

describe("standalone StoreKit entitlement core", () => {
  it("resolves a verified active transaction without importing the Apple SDK", () => {
    expect(resolveStoreKitEntitlementCore(input(), now)).toMatchObject({
      proActive: true,
      status: "active_paid",
      productId: "com.example.pro.monthly"
    })
  })

  it("selects the newest active history candidate over a stale submitted transaction", () => {
    const verified = input()
    verified.transaction.expiresDate = Date.parse("2026-05-25T12:00:00.000Z")
    verified.subscriptionTransactions = [
      {
        status: 1,
        source: "app_store_history",
        transaction: {
          ...verified.transaction,
          transactionId: "transaction-renewal",
          expiresDate: future,
          purchaseDate: now.getTime()
        }
      }
    ]

    expect(resolveStoreKitEntitlementCore(verified, now)).toMatchObject({
      proActive: true,
      latestTransactionId: "transaction-renewal",
      source: "app_store_history"
    })
  })

  it("fails closed for billing retry and configurable grace access", () => {
    expect(resolveStoreKitEntitlementCore(input(3), now).proActive).toBe(false)
    expect(resolveStoreKitEntitlementCore(input(4), now).proActive).toBe(true)
    expect(resolveStoreKitEntitlementCore(input(4), now, false).proActive).toBe(
      false
    )
  })

  it("maps revocation, expiry, and unknown states to inactive snapshots", () => {
    expect(
      resolveStoreKitEntitlementCore(
        {
          ...input(),
          transaction: { ...input().transaction, revocationDate: future }
        },
        now
      )
    ).toMatchObject({ status: "refunded", proActive: false })
    expect(resolveStoreKitEntitlementCore(input(2), now)).toMatchObject({
      status: "expired",
      proActive: false
    })
    expect(resolveStoreKitEntitlementCore(input(99), now)).toMatchObject({
      status: "unknown",
      proActive: false
    })
    expect(
      resolveStoreKitEntitlementCore(
        {
          ...input(),
          transaction: { ...input().transaction, expiresDate: undefined }
        },
        now
      )
    ).toMatchObject({ status: "expired", proActive: false })
  })

  it("rejects incomplete candidates and selects the newest active candidate", () => {
    const verified = input()
    verified.subscriptionTransactions = [
      {
        status: 1,
        source: "app_store_history",
        transaction: {
          ...verified.transaction,
          transactionId: "old",
          expiresDate: future - 1000
        }
      },
      {
        status: 1,
        source: "app_store_history",
        transaction: {
          ...verified.transaction,
          transactionId: "new",
          expiresDate: future,
          purchaseDate: now.getTime()
        }
      },
      {
        status: 1,
        source: "app_store_history",
        transaction: {
          productId: "com.example.pro.monthly",
          transactionId: "invalid",
          expiresDate: future
        }
      }
    ]
    expect(resolveStoreKitEntitlementCore(verified, now)).toMatchObject({
      latestTransactionId: "new",
      source: "app_store_history"
    })
  })
})
