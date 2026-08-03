import {
  Environment,
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload
} from "@apple/app-store-server-library"
import { describe, expect, it, vi } from "vitest"
import {
  verifyStoreKitNotificationWithRuntime,
  verifyStoreKitTransactionWithRuntime,
  type StoreKitRuntime
} from "../../src/storekit"

const baseTransaction: JWSTransactionDecodedPayload = {
  transactionId: "transaction-1",
  originalTransactionId: "original-1",
  bundleId: "com.example.app",
  productId: "com.example.pro.monthly",
  environment: Environment.SANDBOX,
  expiresDate: Date.parse("2099-06-02T12:00:00.000Z")
}

function runtime(
  submittedTransaction: JWSTransactionDecodedPayload = baseTransaction
): StoreKitRuntime {
  return {
    environment: Environment.SANDBOX,
    bundleId: "com.example.app",
    allowedProductIds: new Set(["com.example.pro.monthly"]),
    allowAppleLookupFallback: true,
    client: {
      getTransactionInfo: vi.fn(async () => {
        throw new Error("not available in this test")
      }),
      getAllSubscriptionStatuses: vi.fn(async () => ({
        environment: Environment.SANDBOX,
        bundleId: "com.example.app",
        data: []
      }))
    },
    verifier: {
      verifyAndDecodeTransaction: vi.fn(async () => submittedTransaction),
      verifyAndDecodeNotification: vi.fn(),
      verifyAndDecodeRenewalInfo: vi.fn()
    }
  }
}

describe("StoreKit verification runtime boundary", () => {
  it("accepts a signature-verified transaction when Apple lookups are unavailable", async () => {
    const result = await verifyStoreKitTransactionWithRuntime(
      "signed-jws",
      runtime()
    )

    expect(result.transaction).toEqual(baseTransaction)
    expect(result.verificationSource).toBe("submitted_jws")
    expect(result.transactionLookupDiagnostics?.sdkErrorMessage).toBe(
      "not available in this test"
    )
  })

  it("can fail closed when Apple transaction lookup is unavailable", async () => {
    const verificationRuntime = runtime()
    verificationRuntime.allowAppleLookupFallback = false

    await expect(
      verifyStoreKitTransactionWithRuntime("signed-jws", verificationRuntime)
    ).rejects.toMatchObject({ stage: "apple_transaction_lookup" })
  })

  it("rejects a verified transaction with a wrong bundle or product before persistence can occur", async () => {
    await expect(
      verifyStoreKitTransactionWithRuntime(
        "signed-jws",
        runtime({ ...baseTransaction, bundleId: "com.attacker.app" })
      )
    ).rejects.toMatchObject({
      stage: "submitted_jws_claims"
    })
  })

  it("requires Apple lookup identity to match the submitted transaction", async () => {
    const verificationRuntime = runtime()
    verificationRuntime.client.getTransactionInfo = vi.fn(async () => ({
      signedTransactionInfo: "apple-transaction-jws"
    }))
    let decodeCount = 0
    verificationRuntime.verifier.verifyAndDecodeTransaction = vi.fn(
      async () => {
        decodeCount += 1
        return decodeCount === 1
          ? baseTransaction
          : { ...baseTransaction, originalTransactionId: "different-original" }
      }
    )

    await expect(
      verifyStoreKitTransactionWithRuntime("signed-jws", verificationRuntime)
    ).rejects.toMatchObject({
      stage: "apple_transaction_claims"
    })
  })

  it.each([
    {
      name: "a renewal-extension summary",
      payload: {
        version: "2.0",
        notificationUUID: "notification-summary",
        notificationType: "RENEWAL_EXTENSION",
        summary: {
          environment: Environment.SANDBOX,
          bundleId: "com.example.app"
        }
      }
    },
    {
      name: "an external-purchase token",
      payload: {
        version: "2.0",
        notificationUUID: "notification-external",
        notificationType: "EXTERNAL_PURCHASE_TOKEN",
        externalPurchaseToken: { bundleId: "com.example.app" }
      }
    },
    {
      name: "app data",
      payload: {
        version: "2.0",
        notificationUUID: "notification-app-data",
        notificationType: "RESCIND_CONSENT",
        appData: {
          environment: Environment.SANDBOX,
          bundleId: "com.example.app"
        }
      }
    }
  ])(
    "accepts $name notifications without transaction data",
    async ({ payload }) => {
      const verificationRuntime = runtime()
      verificationRuntime.verifier.verifyAndDecodeNotification = vi.fn(
        async () => payload as ResponseBodyV2DecodedPayload
      )

      const result = await verifyStoreKitNotificationWithRuntime(
        "signed-notification",
        verificationRuntime
      )

      expect(result.transaction).toBeNull()
      expect(result.latestSubscription).toBeNull()
      expect(result.notification.notificationUUID).toBe(
        payload.notificationUUID
      )
    }
  )

  describe("renewal info", () => {
    function subscriptionStatusRuntime(): StoreKitRuntime {
      const verificationRuntime = runtime()
      verificationRuntime.client.getAllSubscriptionStatuses = vi.fn(
        async () => ({
          environment: Environment.SANDBOX,
          bundleId: "com.example.app",
          data: [
            {
              subscriptionGroupIdentifier: "group-1",
              lastTransactions: [
                {
                  status: 4,
                  originalTransactionId: "original-1",
                  signedTransactionInfo: "apple-subscription-jws",
                  signedRenewalInfo: "apple-renewal-jws"
                }
              ]
            }
          ]
        })
      )
      return verificationRuntime
    }

    it("verifies renewal info and carries the grace deadline into the result", async () => {
      const verificationRuntime = subscriptionStatusRuntime()
      const gracePeriodExpiresDate = Date.parse("2099-06-09T12:00:00.000Z")
      verificationRuntime.verifier.verifyAndDecodeRenewalInfo = vi.fn(
        async () => ({
          originalTransactionId: "original-1",
          environment: Environment.SANDBOX,
          gracePeriodExpiresDate,
          autoRenewStatus: 1
        })
      )

      const result = await verifyStoreKitTransactionWithRuntime(
        "signed-jws",
        verificationRuntime
      )

      expect(result.subscriptionTransactions[0]?.renewalInfo).toMatchObject({
        gracePeriodExpiresDate,
        autoRenewStatus: 1
      })
    })

    it("rejects renewal info bound to a different original transaction", async () => {
      const verificationRuntime = subscriptionStatusRuntime()
      verificationRuntime.verifier.verifyAndDecodeRenewalInfo = vi.fn(
        async () => ({
          originalTransactionId: "different-original",
          environment: Environment.SANDBOX
        })
      )

      await expect(
        verifyStoreKitTransactionWithRuntime("signed-jws", verificationRuntime)
      ).rejects.toMatchObject({
        stage: "apple_subscription_renewal_info_claims"
      })
    })

    it("rejects renewal info signed for a different environment", async () => {
      const verificationRuntime = subscriptionStatusRuntime()
      verificationRuntime.verifier.verifyAndDecodeRenewalInfo = vi.fn(
        async () => ({
          originalTransactionId: "original-1",
          environment: Environment.PRODUCTION
        })
      )

      await expect(
        verifyStoreKitTransactionWithRuntime("signed-jws", verificationRuntime)
      ).rejects.toMatchObject({
        stage: "apple_subscription_renewal_info_claims"
      })
    })
  })

  it("requires a version 2 notification and allowed app identity", async () => {
    const verificationRuntime = runtime()
    verificationRuntime.verifier.verifyAndDecodeNotification = vi.fn(
      async () => ({
        version: "1.0",
        notificationUUID: "notification-1",
        notificationType: "DID_RENEW",
        data: {
          environment: Environment.SANDBOX,
          bundleId: "com.attacker.app"
        }
      })
    )

    await expect(
      verifyStoreKitNotificationWithRuntime(
        "signed-notification",
        verificationRuntime
      )
    ).rejects.toMatchObject({ stage: "notification_claims" })
  })
})
