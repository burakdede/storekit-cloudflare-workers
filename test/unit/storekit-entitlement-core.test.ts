import { describe, expect, it } from "vitest"
import {
  resolveStoreKitEntitlementCore,
  type StoreKitEntitlementInput
} from "../../src/storekit/entitlement"

const now = new Date("2026-05-26T12:00:00.000Z")
const future = Date.parse("2099-06-02T12:00:00.000Z")
const past = Date.parse("2026-05-25T12:00:00.000Z")

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
    verified.transaction.expiresDate = past
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
    expect(resolveStoreKitEntitlementCore(input(4), now, false).proActive).toBe(false)
  })

  describe("billing grace period", () => {
    // A renewal has already failed by the time Apple reports status 4, so the transaction's own
    // expiresDate is in the past while the customer must keep access until the grace deadline.
    function graceInput(gracePeriodExpiresDate: number | undefined): StoreKitEntitlementInput {
      const verified = input(4)
      verified.transaction.expiresDate = past
      verified.latestRenewalInfo = {
        gracePeriodExpiresDate,
        autoRenewStatus: 1
      }
      return verified
    }

    it("keeps access while the grace period is still running", () => {
      const snapshot = resolveStoreKitEntitlementCore(graceInput(future), now)
      expect(snapshot).toMatchObject({
        proActive: true,
        status: "grace_period",
        expiresAt: new Date(past).toISOString(),
        accessExpiresAt: new Date(future).toISOString(),
        gracePeriodExpiresAt: new Date(future).toISOString()
      })
    })

    it("expires once the grace deadline has passed", () => {
      expect(resolveStoreKitEntitlementCore(graceInput(past), now)).toMatchObject({
        proActive: false,
        status: "expired"
      })
    })

    it("trusts Apple's status when the grace deadline is unavailable", () => {
      expect(resolveStoreKitEntitlementCore(graceInput(undefined), now)).toMatchObject({
        proActive: true,
        status: "grace_period"
      })
    })

    it("still denies access when grace access is disabled", () => {
      expect(resolveStoreKitEntitlementCore(graceInput(future), now, false)).toMatchObject({
        proActive: false,
        status: "grace_period"
      })
    })
  })

  describe("billing retry", () => {
    it("reports billing_retry rather than expired once the period lapses", () => {
      const verified = input(3)
      verified.transaction.expiresDate = past
      verified.latestRenewalInfo = {
        isInBillingRetryPeriod: true,
        expirationIntent: 2
      }

      expect(resolveStoreKitEntitlementCore(verified, now)).toMatchObject({
        proActive: false,
        status: "billing_retry",
        isInBillingRetryPeriod: true,
        expirationIntent: 2
      })
    })
  })

  describe("trial classification", () => {
    it("treats a free trial introductory offer as a trial", () => {
      const verified = input()
      verified.transaction.offerType = 1
      verified.transaction.offerDiscountType = "FREE_TRIAL"

      expect(resolveStoreKitEntitlementCore(verified, now)).toMatchObject({
        status: "active_trial",
        isTrial: true
      })
    })

    it("does not treat a paid introductory offer as a trial", () => {
      const verified = input()
      verified.transaction.offerType = 1
      verified.transaction.offerDiscountType = "PAY_UP_FRONT"

      expect(resolveStoreKitEntitlementCore(verified, now)).toMatchObject({
        status: "active_paid",
        isTrial: false
      })
    })

    it("falls back to offerType when offerDiscountType is absent", () => {
      const verified = input()
      verified.transaction.offerType = 1

      expect(resolveStoreKitEntitlementCore(verified, now)).toMatchObject({
        status: "active_trial",
        isTrial: true
      })
    })
  })

  describe("perpetual purchases", () => {
    it("keeps a non-consumable active even though Apple omits expiresDate", () => {
      const verified = input(undefined)
      verified.transaction.expiresDate = undefined
      verified.transaction.type = "Non-Consumable"

      expect(resolveStoreKitEntitlementCore(verified, now)).toMatchObject({
        proActive: true,
        status: "active_paid",
        perpetual: true,
        expiresAt: null,
        accessExpiresAt: null
      })
    })

    it("revokes a refunded non-consumable", () => {
      const verified = input(undefined)
      verified.transaction.expiresDate = undefined
      verified.transaction.type = "Non-Consumable"
      verified.transaction.revocationDate = past
      verified.transaction.revocationReason = 1

      expect(resolveStoreKitEntitlementCore(verified, now)).toMatchObject({
        proActive: false,
        status: "refunded",
        revocationReason: 1
      })
    })

    it("still expires a subscription that carries no expiry", () => {
      const verified = input(undefined)
      verified.transaction.expiresDate = undefined

      expect(resolveStoreKitEntitlementCore(verified, now)).toMatchObject({
        proActive: false,
        status: "expired"
      })
    })
  })

  describe("candidate selection", () => {
    it("prefers a grace-period candidate over an expired one", () => {
      const verified = input(2)
      verified.transaction.expiresDate = past
      verified.subscriptionTransactions = [
        {
          status: 2,
          source: "app_store_history",
          transaction: {
            ...verified.transaction,
            transactionId: "transaction-expired"
          }
        },
        {
          status: 4,
          source: "app_store_history",
          transaction: {
            ...verified.transaction,
            transactionId: "transaction-grace"
          },
          renewalInfo: { gracePeriodExpiresDate: future }
        }
      ]

      expect(resolveStoreKitEntitlementCore(verified, now)).toMatchObject({
        proActive: true,
        status: "grace_period",
        latestTransactionId: "transaction-grace"
      })
    })

    it("carries renewal metadata onto the resolved snapshot", () => {
      const verified = input()
      verified.subscriptionTransactions = [
        {
          status: 1,
          source: "app_store_history",
          transaction: verified.transaction,
          renewalInfo: {
            autoRenewStatus: 0,
            autoRenewProductId: "com.example.pro.annual",
            priceIncreaseStatus: 1,
            renewalPrice: 9990,
            currency: "USD"
          }
        }
      ]

      expect(resolveStoreKitEntitlementCore(verified, now)).toMatchObject({
        autoRenewStatus: 0,
        autoRenewProductId: "com.example.pro.annual",
        priceIncreaseStatus: 1,
        renewalPrice: 9990,
        currency: "USD"
      })
    })
  })
})
