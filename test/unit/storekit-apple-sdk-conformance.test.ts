/**
 * Conformance against the Apple App Store Server Library.
 *
 * Every other test in this suite stubs the verifier boundary, which is right for exercising policy
 * but means nothing proves our assumptions still match Apple's SDK. This file is the counterweight
 * and it fails on a dependency bump that moves anything underneath us.
 *
 * Two classes of drift are covered:
 *
 * 1. **Value drift.** The policy compares against bare literals ("FREE_TRIAL", "Non-Consumable",
 *    offer type 1, status 1 to 5). TypeScript cannot catch a literal that stops matching Apple's
 *    enum, because both sides are still strings and numbers. Each one is pinned to the SDK's own
 *    exported enum here.
 *
 * 2. **Shape drift.** Our structural types and the real decoder must agree on field names. The
 *    type-level assignments below fail to compile if Apple renames or retypes a field we read, and
 *    the end-to-end test runs a genuine `SignedDataVerifier`.
 */
import {
  AutoRenewStatus,
  Environment,
  ExpirationIntent,
  InAppOwnershipType,
  OfferDiscountType,
  OfferType,
  RevocationReason,
  SignedDataVerifier,
  Status,
  Type,
  type JWSRenewalInfoDecodedPayload,
  type JWSTransactionDecodedPayload
} from "@apple/app-store-server-library"
import { generateKeyPairSync } from "node:crypto"
import jsonwebtoken from "jsonwebtoken"
import { describe, expect, it } from "vitest"
import {
  resolveStoreKitEntitlementCore,
  type StoreKitEntitlementRenewalInfo,
  type StoreKitEntitlementTransaction
} from "../../src/entitlement"
import { verifyStoreKitTransactionWithRuntime } from "../../src/verification"
import { STOREKIT_ENVIRONMENT, STOREKIT_STATUS } from "../../src/types"
import type { StoreKitRuntime } from "../../src/verification"

const BUNDLE_ID = "com.example.app"
const PRODUCT_ID = "com.example.pro.monthly"
const FUTURE = Date.parse("2099-06-02T12:00:00.000Z")

describe("Apple SDK conformance", () => {
  describe("value pinning", () => {
    it("matches Apple's subscription status codes", () => {
      expect(STOREKIT_STATUS.ACTIVE).toBe(Status.ACTIVE)
      expect(STOREKIT_STATUS.EXPIRED).toBe(Status.EXPIRED)
      expect(STOREKIT_STATUS.BILLING_RETRY).toBe(Status.BILLING_RETRY)
      expect(STOREKIT_STATUS.BILLING_GRACE_PERIOD).toBe(Status.BILLING_GRACE_PERIOD)
      expect(STOREKIT_STATUS.REVOKED).toBe(Status.REVOKED)
    })

    it("matches Apple's environment names", () => {
      expect(STOREKIT_ENVIRONMENT.SANDBOX).toBe(Environment.SANDBOX)
      expect(STOREKIT_ENVIRONMENT.PRODUCTION).toBe(Environment.PRODUCTION)
    })

    // The policy's trial rule reads offerDiscountType and falls back to offerType. Both literals
    // must keep meaning what they mean, or trials get misclassified as paid and vice versa.
    it("classifies a trial by Apple's own offer enums", () => {
      const freeTrial = resolveStoreKitEntitlementCore(
        entitlementInput({
          offerType: OfferType.INTRODUCTORY_OFFER,
          offerDiscountType: OfferDiscountType.FREE_TRIAL
        })
      )
      const payUpFront = resolveStoreKitEntitlementCore(
        entitlementInput({
          offerType: OfferType.INTRODUCTORY_OFFER,
          offerDiscountType: OfferDiscountType.PAY_UP_FRONT
        })
      )

      expect(freeTrial.status).toBe("active_trial")
      expect(payUpFront.status).toBe("active_paid")
    })

    it("recognises Apple's non-consumable product type as perpetual", () => {
      const snapshot = resolveStoreKitEntitlementCore(
        entitlementInput({ type: Type.NON_CONSUMABLE, expiresDate: undefined })
      )

      expect(snapshot.perpetual).toBe(true)
      expect(snapshot.proActive).toBe(true)
    })

    it("carries Apple's renewal enums through unchanged", () => {
      const snapshot = resolveStoreKitEntitlementCore(
        entitlementInput(
          {},
          {
            autoRenewStatus: AutoRenewStatus.OFF,
            expirationIntent: ExpirationIntent.BILLING_ERROR
          }
        )
      )

      expect(snapshot.autoRenewStatus).toBe(AutoRenewStatus.OFF)
      expect(snapshot.expirationIntent).toBe(ExpirationIntent.BILLING_ERROR)
    })

    // The family-sharing rule compares against the bare literal "FAMILY_SHARED". TypeScript cannot
    // catch it drifting, because both sides stay ordinary strings.
    it("excludes a family-shared purchase by Apple's own ownership enum", () => {
      const shared = resolveStoreKitEntitlementCore(
        entitlementInput({ inAppOwnershipType: InAppOwnershipType.FAMILY_SHARED }),
        undefined,
        { allowFamilySharing: false }
      )
      const purchased = resolveStoreKitEntitlementCore(
        entitlementInput({ inAppOwnershipType: InAppOwnershipType.PURCHASED }),
        undefined,
        { allowFamilySharing: false }
      )

      expect(shared.status).toBe("family_shared")
      expect(purchased.status).toBe("active_paid")
    })

    it("stores Apple's revocation reason as-is", () => {
      const snapshot = resolveStoreKitEntitlementCore(
        entitlementInput({
          revocationDate: Date.parse("2026-05-01T00:00:00.000Z"),
          revocationReason: RevocationReason.REFUNDED_DUE_TO_ISSUE
        })
      )

      expect(snapshot.status).toBe("refunded")
      expect(snapshot.revocationReason).toBe(RevocationReason.REFUNDED_DUE_TO_ISSUE)
    })
  })

  describe("shape pinning", () => {
    /**
     * These assignments are the assertion. If Apple renames or retypes a field the policy reads,
     * this file stops compiling and `npm run typecheck` fails in CI.
     */
    it("accepts Apple's decoded payloads as policy input", () => {
      const appleTransaction: JWSTransactionDecodedPayload = {
        transactionId: "t-1",
        originalTransactionId: "o-1",
        productId: PRODUCT_ID,
        bundleId: BUNDLE_ID,
        environment: Environment.SANDBOX,
        expiresDate: FUTURE,
        purchaseDate: 1,
        revocationDate: undefined,
        revocationReason: RevocationReason.REFUNDED_FOR_OTHER_REASON,
        webOrderLineItemId: "w-1",
        appAccountToken: "0198bfd5-3d05-7c6d-9d5a-4b8a2f1c0001",
        offerType: OfferType.INTRODUCTORY_OFFER,
        offerDiscountType: OfferDiscountType.FREE_TRIAL,
        signedDate: 1,
        type: Type.AUTO_RENEWABLE_SUBSCRIPTION
      }
      const appleRenewalInfo: JWSRenewalInfoDecodedPayload = {
        autoRenewStatus: AutoRenewStatus.ON,
        autoRenewProductId: PRODUCT_ID,
        expirationIntent: ExpirationIntent.BILLING_ERROR,
        isInBillingRetryPeriod: true,
        gracePeriodExpiresDate: FUTURE,
        priceIncreaseStatus: 0,
        renewalPrice: 9990,
        currency: "USD",
        offerDiscountType: OfferDiscountType.FREE_TRIAL,
        signedDate: 1
      }

      const asPolicyTransaction: StoreKitEntitlementTransaction = appleTransaction
      const asPolicyRenewalInfo: StoreKitEntitlementRenewalInfo = appleRenewalInfo

      expect(asPolicyTransaction.productId).toBe(PRODUCT_ID)
      expect(asPolicyRenewalInfo.gracePeriodExpiresDate).toBe(FUTURE)
    })
  })

  describe("against Apple's real verifier", () => {
    /**
     * `Environment.LOCAL_TESTING` is Apple's own escape hatch: the verifier skips signature and
     * certificate-chain checks but still performs its real base64 decoding, schema validation, and
     * bundle and environment claim checks. That is enough to prove our field reads and policy work
     * against genuine SDK output rather than against a hand-written stub.
     *
     * It cannot prove chain validation works, which needs Apple's own certificates and is covered
     * by the SDK's own test suite.
     */
    function realVerifierRuntime(): StoreKitRuntime {
      const verifier = new SignedDataVerifier(
        [],
        false,
        Environment.LOCAL_TESTING,
        BUNDLE_ID,
        undefined
      )
      return {
        environment: Environment.LOCAL_TESTING as unknown as StoreKitRuntime["environment"],
        bundleId: BUNDLE_ID,
        allowedProductIds: new Set([PRODUCT_ID]),
        allowAppleLookupFallback: true,
        client: {
          getTransactionInfo: async () => {
            throw new Error("Apple lookup is intentionally unavailable in this test")
          },
          getAllSubscriptionStatuses: async () => ({
            environment: Environment.LOCAL_TESTING,
            bundleId: BUNDLE_ID,
            data: []
          })
        },
        verifier: {
          verifyAndDecodeTransaction: (jws) => verifier.verifyAndDecodeTransaction(jws),
          verifyAndDecodeNotification: (jws) => verifier.verifyAndDecodeNotification(jws),
          verifyAndDecodeRenewalInfo: (jws) => verifier.verifyAndDecodeRenewalInfo(jws)
        }
      }
    }

    function signJws(payload: Record<string, unknown>): string {
      const { privateKey } = generateKeyPairSync("ec", {
        namedCurve: "prime256v1",
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" }
      })
      return jsonwebtoken.sign(payload, privateKey, { algorithm: "ES256" })
    }

    it("decodes a real JWS and resolves an entitlement from it", async () => {
      const jws = signJws({
        transactionId: "t-real",
        originalTransactionId: "o-real",
        bundleId: BUNDLE_ID,
        productId: PRODUCT_ID,
        environment: Environment.LOCAL_TESTING,
        expiresDate: FUTURE,
        purchaseDate: Date.parse("2026-05-01T00:00:00.000Z"),
        type: Type.AUTO_RENEWABLE_SUBSCRIPTION,
        offerType: OfferType.INTRODUCTORY_OFFER,
        offerDiscountType: OfferDiscountType.FREE_TRIAL,
        signedDate: Date.parse("2026-05-01T00:00:00.000Z")
      })

      const verified = await verifyStoreKitTransactionWithRuntime(jws, realVerifierRuntime())

      expect(verified.transaction.transactionId).toBe("t-real")
      expect(verified.transaction.offerDiscountType).toBe(OfferDiscountType.FREE_TRIAL)
      expect(verified.transaction.type).toBe(Type.AUTO_RENEWABLE_SUBSCRIPTION)
    })

    it("rejects a real JWS whose bundle does not match, using Apple's own check", async () => {
      const jws = signJws({
        transactionId: "t-attacker",
        originalTransactionId: "o-attacker",
        bundleId: "com.attacker.app",
        productId: PRODUCT_ID,
        environment: Environment.LOCAL_TESTING,
        expiresDate: FUTURE,
        signedDate: 1
      })

      await expect(
        verifyStoreKitTransactionWithRuntime(jws, realVerifierRuntime())
      ).rejects.toMatchObject({ stage: "submitted_jws_decode" })
    })

    it("rejects a real JWS for a product outside the allow-list", async () => {
      const jws = signJws({
        transactionId: "t-other",
        originalTransactionId: "o-other",
        bundleId: BUNDLE_ID,
        productId: "com.example.not.allowed",
        environment: Environment.LOCAL_TESTING,
        expiresDate: FUTURE,
        signedDate: 1
      })

      await expect(
        verifyStoreKitTransactionWithRuntime(jws, realVerifierRuntime())
      ).rejects.toMatchObject({ stage: "submitted_jws_claims" })
    })

    it("decodes real renewal info and reads the grace deadline from it", async () => {
      const verifier = new SignedDataVerifier(
        [],
        false,
        Environment.LOCAL_TESTING,
        BUNDLE_ID,
        undefined
      )
      const jws = signJws({
        originalTransactionId: "o-real",
        environment: Environment.LOCAL_TESTING,
        autoRenewStatus: AutoRenewStatus.ON,
        gracePeriodExpiresDate: FUTURE,
        expirationIntent: ExpirationIntent.BILLING_ERROR,
        signedDate: 1
      })

      const renewalInfo = await verifier.verifyAndDecodeRenewalInfo(jws)
      const snapshot = resolveStoreKitEntitlementCore({
        environment: "Sandbox",
        transaction: {
          transactionId: "t-real",
          originalTransactionId: "o-real",
          productId: PRODUCT_ID,
          expiresDate: Date.parse("2026-05-25T12:00:00.000Z")
        },
        latestSubscriptionStatus: Status.BILLING_GRACE_PERIOD,
        latestRenewalInfo: renewalInfo,
        subscriptionTransactions: [],
        verificationSource: "posted_jws"
      })

      // The whole point of the grace-period fix, proved against a genuinely decoded payload.
      expect(snapshot.status).toBe("grace_period")
      expect(snapshot.proActive).toBe(true)
      expect(snapshot.accessExpiresAt).toBe(new Date(FUTURE).toISOString())
    })
  })
})

function entitlementInput(
  transaction: Partial<StoreKitEntitlementTransaction>,
  renewalInfo?: StoreKitEntitlementRenewalInfo
) {
  return {
    environment: "Sandbox" as const,
    transaction: {
      transactionId: "t-1",
      originalTransactionId: "o-1",
      productId: PRODUCT_ID,
      expiresDate: FUTURE,
      ...transaction
    },
    latestSubscriptionStatus: Status.ACTIVE as number | undefined,
    latestRenewalInfo: renewalInfo,
    subscriptionTransactions: [],
    verificationSource: "posted_jws" as const
  }
}
