/**
 * Upgrades.
 *
 * Apple sets `isUpgraded` on the subscription it cancelled to move a customer onto another one.
 * The replacement carries the live entitlement, so a superseded transaction must never be read as
 * the current one — the visible symptom otherwise is "we upgraded them to annual and the server
 * still says monthly", with access working and only the tier wrong.
 */
import { Status } from "@apple/app-store-server-library"
import { describe, expect, it } from "vitest"
import {
  resolveStoreKitEntitlementCore,
  type StoreKitEntitlementCandidate,
  type StoreKitEntitlementInput
} from "../../src/entitlement"

const now = new Date("2026-05-26T12:00:00.000Z")
const laterExpiry = Date.parse("2099-12-31T12:00:00.000Z")
const earlierExpiry = Date.parse("2099-06-02T12:00:00.000Z")

function candidate(
  overrides: Partial<StoreKitEntitlementCandidate["transaction"]> & { transactionId: string }
): StoreKitEntitlementCandidate {
  return {
    status: Status.ACTIVE,
    source: "app_store_history",
    transaction: {
      originalTransactionId: `original-${overrides.transactionId}`,
      productId: "com.example.pro.monthly",
      expiresDate: earlierExpiry,
      ...overrides
    }
  }
}

function input(candidates: StoreKitEntitlementCandidate[]): StoreKitEntitlementInput {
  return {
    environment: "Sandbox" as const,
    transaction: candidates[0]?.transaction ?? { transactionId: "submitted" },
    latestSubscriptionStatus: Status.ACTIVE,
    subscriptionTransactions: candidates,
    verificationSource: "posted_jws" as const
  }
}

describe("StoreKit upgrade handling", () => {
  it("reports the replacement product, not the one the customer upgraded away from", () => {
    const upgradedMonthly = candidate({
      transactionId: "monthly",
      productId: "com.example.pro.monthly",
      isUpgraded: true,
      // Deliberately the *longer* window. Ranking by deadline alone would pick this one, which is
      // exactly the bug: access works and the reported tier is wrong.
      expiresDate: laterExpiry
    })
    const annual = candidate({
      transactionId: "annual",
      productId: "com.example.pro.annual",
      expiresDate: earlierExpiry
    })

    expect(resolveStoreKitEntitlementCore(input([upgradedMonthly, annual]), now)).toMatchObject({
      proActive: true,
      status: "active_paid",
      productId: "com.example.pro.annual",
      isUpgraded: false
    })
  })

  it("does not grant access on a superseded transaction standing alone", () => {
    const upgraded = candidate({ transactionId: "monthly", isUpgraded: true })

    // `upgraded` rather than `expired`: the customer did not churn, this view is just stale, and
    // the status points whoever reads it at the replacement.
    expect(resolveStoreKitEntitlementCore(input([upgraded]), now)).toMatchObject({
      proActive: false,
      status: "upgraded",
      isUpgraded: true
    })
  })

  it("leaves an ordinary active subscription untouched", () => {
    const active = candidate({ transactionId: "monthly" })

    expect(resolveStoreKitEntitlementCore(input([active]), now)).toMatchObject({
      proActive: true,
      status: "active_paid",
      isUpgraded: false
    })
  })

  it("resolves a superseded transaction posted on its own, with no history to compare against", () => {
    // The path that actually reaches this in production: Apple's status lookup was unavailable, so
    // the submitted JWS is the only candidate there is.
    const submitted = input([])
    submitted.transaction = {
      transactionId: "monthly",
      originalTransactionId: "original-monthly",
      productId: "com.example.pro.monthly",
      expiresDate: laterExpiry,
      isUpgraded: true
    }

    expect(resolveStoreKitEntitlementCore(submitted, now)).toMatchObject({
      proActive: false,
      status: "upgraded"
    })
  })

  it("keeps a revocation outranking an upgrade", () => {
    const both = candidate({
      transactionId: "monthly",
      isUpgraded: true,
      revocationDate: Date.parse("2026-05-20T12:00:00.000Z"),
      revocationType: "REFUND_FULL"
    })

    expect(resolveStoreKitEntitlementCore(input([both]), now)).toMatchObject({
      proActive: false,
      status: "refunded"
    })
  })
})
