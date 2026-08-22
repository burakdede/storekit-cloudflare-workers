import {
  Environment,
  OfferType,
  Status,
  type JWSTransactionDecodedPayload
} from "@apple/app-store-server-library"
import { describe, expect, it } from "vitest"
import {
  resolveStoreKitEntitlement,
  type VerifiedStoreKitTransaction
} from "storekit-cloudflare-workers"

const now = new Date("2026-05-26T12:00:00.000Z")
const future = Date.parse("2099-06-02T12:00:00.000Z")
const past = Date.parse("2026-05-25T12:00:00.000Z")

function verified(
  transactionOverrides: Partial<JWSTransactionDecodedPayload>,
  status: Status | undefined
): VerifiedStoreKitTransaction {
  const transaction: JWSTransactionDecodedPayload = {
    transactionId: "transaction-1",
    originalTransactionId: "original-1",
    bundleId: "com.example.app",
    productId: "com.example.app.pro.annual",
    environment: Environment.SANDBOX,
    expiresDate: future,
    signedDate: now.getTime(),
    ...transactionOverrides
  }

  return {
    environment: Environment.SANDBOX,
    transaction,
    statusResponse: {
      environment: Environment.SANDBOX,
      bundleId: "com.example.app",
      data: []
    },
    latestSubscription:
      status === undefined
        ? null
        : {
            originalTransactionId: transaction.originalTransactionId ?? "original-1",
            status,
            signedTransactionInfo: "signed-transaction"
          },
    subscriptionTransactions: []
  }
}

describe("storekit entitlement mapper", () => {
  it("maps active annual introductory trial to Pro trial", () => {
    const entitlement = resolveStoreKitEntitlement(
      verified({ offerType: OfferType.INTRODUCTORY_OFFER }, Status.ACTIVE),
      now
    )

    expect(entitlement).toMatchObject({
      proActive: true,
      status: "active_trial",
      isTrial: true,
      productId: "com.example.app.pro.annual",
      expiresAt: "2099-06-02T12:00:00.000Z"
    })
  })

  it("maps active paid monthly or weekly transactions to Pro paid", () => {
    const entitlement = resolveStoreKitEntitlement(
      verified({ productId: "com.example.app.pro.monthly" }, Status.ACTIVE),
      now
    )

    expect(entitlement).toMatchObject({
      proActive: true,
      status: "active_paid",
      isTrial: false,
      productId: "com.example.app.pro.monthly"
    })
  })

  it("fails closed at the expiry boundary", () => {
    const entitlement = resolveStoreKitEntitlement(
      verified({ expiresDate: now.getTime() }, Status.ACTIVE),
      now
    )

    expect(entitlement.proActive).toBe(false)
    expect(entitlement.status).toBe("expired")
  })

  it("refund and revoke statuses remove Pro immediately", () => {
    expect(
      resolveStoreKitEntitlement(verified({ revocationDate: future }, Status.ACTIVE), now)
    ).toMatchObject({
      proActive: false,
      status: "refunded"
    })
    expect(resolveStoreKitEntitlement(verified({}, Status.REVOKED), now)).toMatchObject({
      proActive: false,
      status: "revoked"
    })
  })

  it("keeps grace period configurable and billing retry inactive", () => {
    expect(
      resolveStoreKitEntitlement(verified({}, Status.BILLING_GRACE_PERIOD), now)
    ).toMatchObject({
      proActive: true,
      status: "grace_period"
    })
    expect(
      resolveStoreKitEntitlement(verified({}, Status.BILLING_GRACE_PERIOD), now, false)
    ).toMatchObject({
      proActive: false,
      status: "grace_period"
    })
    expect(resolveStoreKitEntitlement(verified({}, Status.BILLING_RETRY), now)).toMatchObject({
      proActive: false,
      status: "billing_retry"
    })
  })

  it("fails closed for missing identity or unsupported status", () => {
    expect(
      resolveStoreKitEntitlement(verified({ transactionId: "" }, Status.ACTIVE), now)
    ).toMatchObject({
      proActive: false,
      status: "unknown"
    })
  })

  it("uses a verified future StoreKit transaction when Apple status lookup is unavailable", () => {
    expect(resolveStoreKitEntitlement(verified({}, undefined), now)).toMatchObject({
      proActive: true,
      status: "active_paid"
    })
    expect(
      resolveStoreKitEntitlement(
        verified({ offerType: OfferType.INTRODUCTORY_OFFER }, undefined),
        now
      )
    ).toMatchObject({
      proActive: true,
      status: "active_trial"
    })
    expect(
      resolveStoreKitEntitlement(verified({ expiresDate: past }, undefined), now)
    ).toMatchObject({
      proActive: false,
      status: "expired"
    })
  })

  it("maps explicit expired Apple status to inactive even if expiry is in the future", () => {
    const entitlement = resolveStoreKitEntitlement(
      verified({ expiresDate: future }, Status.EXPIRED),
      now
    )

    expect(entitlement.proActive).toBe(false)
    expect(entitlement.status).toBe("expired")
  })

  it("maps past active transactions to expired", () => {
    const entitlement = resolveStoreKitEntitlement(
      verified({ expiresDate: past }, Status.ACTIVE),
      now
    )

    expect(entitlement.proActive).toBe(false)
    expect(entitlement.status).toBe("expired")
  })

  it("prefers a newer active App Store history transaction over a stale submitted transaction", () => {
    const staleAnnual: JWSTransactionDecodedPayload = {
      transactionId: "transaction-1",
      originalTransactionId: "original-1",
      bundleId: "com.example.app",
      productId: "com.example.app.pro.annual",
      environment: Environment.SANDBOX,
      expiresDate: past,
      purchaseDate: Date.parse("2026-05-01T12:00:00.000Z"),
      signedDate: now.getTime()
    }
    const renewal: JWSTransactionDecodedPayload = {
      ...staleAnnual,
      transactionId: "transaction-2",
      expiresDate: future,
      purchaseDate: Date.parse("2026-05-26T12:00:00.000Z")
    }

    const entitlement = resolveStoreKitEntitlement(
      {
        environment: Environment.SANDBOX,
        transaction: staleAnnual,
        statusResponse: {
          environment: Environment.SANDBOX,
          bundleId: "com.example.app",
          data: []
        },
        latestSubscription: {
          originalTransactionId: "original-1",
          status: Status.ACTIVE,
          signedTransactionInfo: "signed-renewal"
        },
        subscriptionTransactions: [{ status: Status.ACTIVE, transaction: renewal }]
      },
      now
    )

    expect(entitlement).toMatchObject({
      proActive: true,
      status: "active_paid",
      latestTransactionId: "transaction-2",
      source: "app_store_history",
      expiresAt: "2099-06-02T12:00:00.000Z"
    })
  })
})
