/**
 * Revocation detail.
 *
 * Apple's subscription status 5 conflates a refund with Family Sharing ending, and
 * `revocationType` is the field that separates them. All three revocation types end access to the
 * transaction, so this is about reporting the right event, not about who has access.
 */
import { RevocationReason, RevocationType, Status } from "@apple/app-store-server-library"
import { describe, expect, it } from "vitest"
import {
  resolveStoreKitEntitlementCore,
  type StoreKitEntitlementInput,
  type StoreKitEntitlementTransaction
} from "../../src/entitlement"

const now = new Date("2026-05-26T12:00:00.000Z")
const future = Date.parse("2099-06-02T12:00:00.000Z")
const revokedAt = Date.parse("2026-05-20T12:00:00.000Z")

function input(
  transaction: Partial<StoreKitEntitlementTransaction> = {}
): StoreKitEntitlementInput {
  return {
    environment: "Sandbox" as const,
    transaction: {
      transactionId: "transaction-revocation",
      originalTransactionId: "original-revocation",
      productId: "com.example.pro.monthly",
      // Deliberately still in the future: only the revocation can end this entitlement.
      expiresDate: future,
      revocationDate: revokedAt,
      ...transaction
    },
    latestSubscriptionStatus: Status.REVOKED,
    subscriptionTransactions: [],
    verificationSource: "posted_jws" as const
  }
}

describe("StoreKit revocation detail", () => {
  it("reports a full refund as refunded", () => {
    const snapshot = resolveStoreKitEntitlementCore(
      input({
        revocationType: RevocationType.REFUND_FULL,
        revocationReason: RevocationReason.REFUNDED_FOR_OTHER_REASON,
        revocationPercentage: 100_000
      }),
      now
    )

    expect(snapshot).toMatchObject({
      proActive: false,
      status: "refunded",
      revocationType: "REFUND_FULL",
      revocationPercentage: 100_000
    })
  })

  it("reports a prorated refund as refunded and keeps the proportion", () => {
    const snapshot = resolveStoreKitEntitlementCore(
      input({ revocationType: RevocationType.REFUND_PRORATED, revocationPercentage: 40_000 }),
      now
    )

    // Milliunits: 40000 is 40%, not 40000%.
    expect(snapshot).toMatchObject({
      proActive: false,
      status: "refunded",
      revocationType: "REFUND_PRORATED",
      revocationPercentage: 40_000
    })
  })

  it("distinguishes Family Sharing ending from a refund", () => {
    const snapshot = resolveStoreKitEntitlementCore(
      input({ revocationType: RevocationType.FAMILY_REVOKE }),
      now
    )

    // Nobody was refunded here: the organiser's subscription is alive and still paid for. Calling
    // it `refunded` puts a refund that never happened into support and revenue reporting.
    expect(snapshot).toMatchObject({
      proActive: false,
      status: "family_revoked",
      revocationType: "FAMILY_REVOKE"
    })
  })

  it("denies access for every revocation type", () => {
    const statuses = [
      RevocationType.REFUND_FULL,
      RevocationType.REFUND_PRORATED,
      RevocationType.FAMILY_REVOKE
    ].map((revocationType) => resolveStoreKitEntitlementCore(input({ revocationType }), now))

    // The split is for reporting. If it ever starts granting access, that is a regression.
    expect(statuses.map((snapshot) => snapshot.proActive)).toEqual([false, false, false])
    expect(statuses.map((snapshot) => snapshot.status)).toEqual([
      "refunded",
      "refunded",
      "family_revoked"
    ])
  })

  it("still reports a revocation Apple sent without a type as refunded", () => {
    const snapshot = resolveStoreKitEntitlementCore(input({ revocationType: undefined }), now)

    // Apple omits the field on older signed material, and rows written before this change have no
    // type either. Both must keep behaving exactly as they did.
    expect(snapshot).toMatchObject({
      proActive: false,
      status: "refunded",
      revocationType: null,
      revocationPercentage: null
    })
  })

  it("reports a revoked status carrying no revocation date as revoked", () => {
    const withoutDate = input({ revocationDate: undefined })

    // Apple said status 5 but gave nothing to attribute it to, so neither refund nor family revoke
    // can be claimed.
    expect(resolveStoreKitEntitlementCore(withoutDate, now)).toMatchObject({
      proActive: false,
      status: "revoked"
    })
  })
})
