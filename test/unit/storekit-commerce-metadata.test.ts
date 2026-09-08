/**
 * Commerce and renewal metadata.
 *
 * None of this gates access, which is why it was reasonable to leave out. All of it is needed to
 * build the screens and reports around access: what a customer is charged, when they renew, which
 * offer converted them, and whether they are a new or a retained subscriber.
 */
import {
  OfferType,
  TransactionReason,
  type JWSRenewalInfoDecodedPayload,
  type JWSTransactionDecodedPayload
} from "@apple/app-store-server-library"
import { describe, expect, it } from "vitest"
import { MockD1Database } from "../helpers/mock-d1"
import { entitlementSnapshot } from "../helpers/snapshot"
import {
  loadStoreKitSubscriptionByInstallation,
  persistStoreKitSubscriptionForInstallation
} from "storekit-cloudflare-workers"
import {
  resolveStoreKitEntitlementCore,
  type StoreKitEntitlementInput,
  type StoreKitEntitlementRenewalInfo,
  type StoreKitEntitlementTransaction
} from "../../src/entitlement"

const now = new Date("2026-05-26T12:00:00.000Z")
const future = Date.parse("2099-06-02T12:00:00.000Z")

function input(
  transaction: Partial<StoreKitEntitlementTransaction> = {},
  renewalInfo?: StoreKitEntitlementRenewalInfo
): StoreKitEntitlementInput {
  return {
    environment: "Sandbox" as const,
    transaction: {
      transactionId: "transaction-commerce",
      originalTransactionId: "original-commerce",
      productId: "com.example.pro.monthly",
      expiresDate: future,
      ...transaction
    },
    latestSubscriptionStatus: 1,
    latestRenewalInfo: renewalInfo,
    subscriptionTransactions: [],
    verificationSource: "posted_jws" as const
  }
}

describe("StoreKit commerce and renewal metadata", () => {
  it("carries the signed commerce fields onto the snapshot", () => {
    const snapshot = resolveStoreKitEntitlementCore(
      input({
        price: 9990,
        currency: "USD",
        storefront: "USA",
        storefrontId: "143441",
        transactionReason: TransactionReason.RENEWAL,
        quantity: 1,
        offerType: OfferType.WIN_BACK_OFFER,
        offerIdentifier: "winback-2026",
        offerPeriod: "P1M",
        originalPurchaseDate: Date.parse("2026-01-01T12:00:00.000Z"),
        appTransactionId: "app-transaction-1"
      }),
      now
    )

    expect(snapshot).toMatchObject({
      // Milliunits. 9990 is 9.99, and reading it as 9990 is the error this unit invites.
      price: 9990,
      currency: "USD",
      storefront: "USA",
      storefrontId: "143441",
      transactionReason: "RENEWAL",
      quantity: 1,
      offerType: 4,
      offerIdentifier: "winback-2026",
      offerPeriod: "P1M",
      originalPurchaseDate: "2026-01-01T12:00:00.000Z",
      appTransactionId: "app-transaction-1"
    })
  })

  it("reports the renewal date, which expiresAt cannot supply during a grace period", () => {
    const snapshot = resolveStoreKitEntitlementCore(
      input(
        { expiresDate: Date.parse("2026-05-20T12:00:00.000Z") },
        {
          renewalDate: Date.parse("2026-06-20T12:00:00.000Z"),
          recentSubscriptionStartDate: Date.parse("2026-01-01T12:00:00.000Z"),
          gracePeriodExpiresDate: future
        }
      ),
      now
    )

    // `expiresAt` has already passed; "renews on" still has to show something true.
    expect(snapshot.expiresAt).toBe("2026-05-20T12:00:00.000Z")
    expect(snapshot.renewalDate).toBe("2026-06-20T12:00:00.000Z")
    expect(snapshot.recentSubscriptionStartDate).toBe("2026-01-01T12:00:00.000Z")
  })

  it("surfaces win-back offer eligibility", () => {
    const snapshot = resolveStoreKitEntitlementCore(
      input({}, { eligibleWinBackOfferIds: ["winback-a", "winback-b"] }),
      now
    )

    // Without this the feature is unreachable from the server.
    expect(snapshot.eligibleWinBackOfferIds).toEqual(["winback-a", "winback-b"])
  })

  it("prefers the renewal currency and falls back to the transaction's", () => {
    const fromRenewal = resolveStoreKitEntitlementCore(
      input({ currency: "USD" }, { currency: "EUR" }),
      now
    )
    const fromTransaction = resolveStoreKitEntitlementCore(input({ currency: "USD" }), now)

    // Purely additive: what used to resolve to null can now be populated, and nothing that was
    // already set changes.
    expect(fromRenewal.currency).toBe("EUR")
    expect(fromTransaction.currency).toBe("USD")
  })

  it("takes the offer identifier from renewal info when the transaction omits it", () => {
    const snapshot = resolveStoreKitEntitlementCore(
      input({}, { offerIdentifier: "promo-spring" }),
      now
    )

    expect(snapshot.offerIdentifier).toBe("promo-spring")
  })

  it("leaves every field null when Apple sent none of them", () => {
    const snapshot = resolveStoreKitEntitlementCore(input(), now)

    expect(snapshot).toMatchObject({
      price: null,
      storefront: null,
      transactionReason: null,
      offerType: null,
      renewalDate: null,
      eligibleWinBackOfferIds: null
    })
  })

  it("round-trips commerce metadata through D1", async () => {
    const db = new MockD1Database()

    await persistStoreKitSubscriptionForInstallation(
      entitlementSnapshot({
        price: 9990,
        currency: "USD",
        storefront: "USA",
        transactionReason: "RENEWAL",
        offerType: 4,
        offerIdentifier: "winback-2026",
        renewalDate: "2026-06-20T12:00:00.000Z",
        eligibleWinBackOfferIds: ["winback-a"]
      }),
      "installation-1",
      "com.example.app",
      db as unknown as D1Database
    )

    const record = await loadStoreKitSubscriptionByInstallation(
      "installation-1",
      new Date("2026-06-03T12:00:00.000Z"),
      ["Sandbox"],
      db as unknown as D1Database
    )

    expect(record).toMatchObject({
      price: 9990,
      storefront: "USA",
      transactionReason: "RENEWAL",
      offerType: 4,
      renewalDate: "2026-06-20T12:00:00.000Z"
    })
    // Stored as JSON, since D1 has no array type.
    expect(JSON.parse(String(record?.eligibleWinBackOfferIds))).toEqual(["winback-a"])
    expect(db.getStoreKitTransactionRows()[0]).toMatchObject({ price: 9990, storefront: "USA" })
  })

  it("keeps the policy input assignable from Apple's own payload types", () => {
    // A rename in the SDK should fail typecheck here rather than silently produce nulls.
    const transaction: JWSTransactionDecodedPayload = {
      price: 9990,
      currency: "USD",
      storefront: "USA",
      transactionReason: TransactionReason.PURCHASE,
      offerType: OfferType.INTRODUCTORY_OFFER
    }
    const renewalInfo: JWSRenewalInfoDecodedPayload = {
      renewalDate: future,
      eligibleWinBackOfferIds: ["winback-a"]
    }
    const asPolicyTransaction: StoreKitEntitlementTransaction = transaction
    const asPolicyRenewalInfo: StoreKitEntitlementRenewalInfo = renewalInfo

    expect(asPolicyTransaction.price).toBe(9990)
    expect(asPolicyRenewalInfo.renewalDate).toBe(future)
  })
})
