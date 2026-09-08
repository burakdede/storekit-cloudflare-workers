/**
 * Family Sharing policy.
 *
 * Apple marks each transaction `PURCHASED` or `FAMILY_SHARED`. A shared purchase is a real
 * entitlement — the organiser bought it so their family could use it — so it grants access by
 * default, and hosts that must exclude it say so rather than post-processing the snapshot.
 */
import { InAppOwnershipType, Status } from "@apple/app-store-server-library"
import { describe, expect, it } from "vitest"
import {
  resolveStoreKitEntitlementCore,
  type StoreKitEntitlementInput,
  type StoreKitEntitlementTransaction
} from "../../src/entitlement"

const now = new Date("2026-05-26T12:00:00.000Z")
const future = Date.parse("2099-06-02T12:00:00.000Z")
const past = Date.parse("2026-05-25T12:00:00.000Z")

function input(
  transaction: Partial<StoreKitEntitlementTransaction> = {},
  status: number | undefined = Status.ACTIVE
): StoreKitEntitlementInput {
  return {
    environment: "Sandbox" as const,
    transaction: {
      transactionId: "transaction-family",
      originalTransactionId: "original-family",
      productId: "com.example.pro.monthly",
      expiresDate: future,
      inAppOwnershipType: InAppOwnershipType.FAMILY_SHARED,
      ...transaction
    },
    latestSubscriptionStatus: status,
    subscriptionTransactions: [],
    verificationSource: "posted_jws" as const
  }
}

describe("StoreKit Family Sharing policy", () => {
  it("grants access to a family-shared subscription by default", () => {
    expect(resolveStoreKitEntitlementCore(input(), now)).toMatchObject({
      proActive: true,
      status: "active_paid",
      inAppOwnershipType: "FAMILY_SHARED"
    })
  })

  it("reports the ownership type on a purchase the customer made themselves", () => {
    const purchased = input({ inAppOwnershipType: InAppOwnershipType.PURCHASED })

    expect(resolveStoreKitEntitlementCore(purchased, now)).toMatchObject({
      proActive: true,
      inAppOwnershipType: "PURCHASED"
    })
  })

  it("treats material signed before Apple added the field as purchased", () => {
    const legacy = input({ inAppOwnershipType: undefined })

    // Defaulting the other way would revoke access for every transaction already in a host's D1.
    expect(
      resolveStoreKitEntitlementCore(legacy, now, { allowFamilySharing: false })
    ).toMatchObject({
      proActive: true,
      status: "active_paid",
      inAppOwnershipType: null
    })
  })

  it("withholds access from a family-shared purchase when the host excludes it", () => {
    expect(
      resolveStoreKitEntitlementCore(input(), now, { allowFamilySharing: false })
    ).toMatchObject({
      proActive: false,
      status: "family_shared",
      inAppOwnershipType: "FAMILY_SHARED"
    })
  })

  it("reports an excluded share as family_shared even mid grace period", () => {
    const inGrace = input({ expiresDate: past }, Status.BILLING_GRACE_PERIOD)
    inGrace.latestRenewalInfo = { gracePeriodExpiresDate: future }

    // Not `grace_period`: that status invites a payment-update prompt, and the family member is
    // not the one paying.
    expect(
      resolveStoreKitEntitlementCore(inGrace, now, { allowFamilySharing: false })
    ).toMatchObject({ proActive: false, status: "family_shared" })
  })

  it("still reports a refunded family-shared purchase as refunded", () => {
    const refunded = input({ revocationDate: past })

    // Revocation is terminal and outranks the ownership question.
    expect(
      resolveStoreKitEntitlementCore(refunded, now, { allowFamilySharing: false })
    ).toMatchObject({ proActive: false, status: "refunded" })
  })

  it("prefers a purchased subscription over an excluded family-shared one", () => {
    const both = input()
    both.subscriptionTransactions = [
      {
        status: Status.ACTIVE,
        source: "app_store_history",
        transaction: { ...both.transaction, inAppOwnershipType: InAppOwnershipType.FAMILY_SHARED }
      },
      {
        status: Status.ACTIVE,
        source: "app_store_history",
        transaction: {
          ...both.transaction,
          transactionId: "transaction-owned",
          originalTransactionId: "original-owned",
          inAppOwnershipType: InAppOwnershipType.PURCHASED,
          // Deliberately the shorter window, so only the ownership rule can make it win.
          expiresDate: Date.parse("2099-06-01T12:00:00.000Z")
        }
      }
    ]

    expect(resolveStoreKitEntitlementCore(both, now, { allowFamilySharing: false })).toMatchObject({
      proActive: true,
      inAppOwnershipType: "PURCHASED",
      originalTransactionId: "original-owned"
    })
  })

  it("accepts the original allowGracePeriodAccess boolean in place of a policy object", () => {
    const inGrace = input({ expiresDate: past }, Status.BILLING_GRACE_PERIOD)
    inGrace.latestRenewalInfo = { gracePeriodExpiresDate: future }

    expect(resolveStoreKitEntitlementCore(inGrace, now, false)).toMatchObject({
      proActive: false,
      status: "grace_period"
    })
    expect(resolveStoreKitEntitlementCore(inGrace, now, true)).toMatchObject({
      proActive: true,
      status: "grace_period"
    })
  })
})
