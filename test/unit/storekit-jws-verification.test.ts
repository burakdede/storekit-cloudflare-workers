/**
 * Real signature and certificate chain verification.
 *
 * Every other test in this suite either stubs the verifier or runs it under
 * `Environment.LOCAL_TESTING`, which skips signature and chain validation by design. Nothing
 * therefore proved that a forged payload is rejected — the one thing this package exists to do.
 *
 * These tests run Apple's real `SignedDataVerifier` in `SANDBOX` mode against a purpose-built
 * certificate authority, so signature verification and full chain validation both execute.
 */
import {
  Environment,
  SignedDataVerifier,
  VerificationStatus,
  type JWSTransactionDecodedPayload
} from "@apple/app-store-server-library"
import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"
import { createAppleTestCertificateAuthority } from "../helpers/apple-test-ca"
import { parseAppleRootCertificatesPem } from "../../src/config"
import {
  verifyStoreKitNotificationWithRuntime,
  verifyStoreKitTransactionWithRuntime
} from "../../src/verification"
import { StoreKitVerificationError } from "../../src/errors"
import type { StoreKitRuntime } from "../../src/verification"

const BUNDLE_ID = "com.example.app"
const PRODUCT_ID = "com.example.pro.monthly"
const SIGNED_DATE = Date.parse("2026-05-26T12:00:00.000Z")

function transactionPayload(overrides: Record<string, unknown> = {}) {
  return {
    transactionId: "2000000498765432",
    originalTransactionId: "2000000412345678",
    bundleId: BUNDLE_ID,
    productId: PRODUCT_ID,
    environment: Environment.SANDBOX,
    type: "Auto-Renewable Subscription",
    inAppOwnershipType: "PURCHASED",
    signedDate: SIGNED_DATE,
    purchaseDate: Date.parse("2026-05-01T12:00:00.000Z"),
    expiresDate: Date.parse("2099-06-02T12:00:00.000Z"),
    ...overrides
  }
}

/**
 * Build a verifier exactly as the module does: roots parsed out of the PEM secret, online checks
 * off (the Workers runtime has no `Response.buffer()` for OCSP), pinned to bundle and environment.
 */
function verifierFor(rootCertificatePem: string): SignedDataVerifier {
  return new SignedDataVerifier(
    parseAppleRootCertificatesPem(rootCertificatePem) as unknown as Buffer[],
    false,
    Environment.SANDBOX,
    BUNDLE_ID
  )
}

function runtimeFor(
  verifier: SignedDataVerifier,
  signedTransactionInfo: string,
  allowedProductIds = new Set([PRODUCT_ID])
): StoreKitRuntime {
  return {
    environment: "Sandbox",
    bundleId: BUNDLE_ID,
    allowedProductIds,
    allowAppleLookupFallback: true,
    client: {
      getTransactionInfo: async () => ({ signedTransactionInfo }),
      getAllSubscriptionStatuses: async () => ({
        environment: "Sandbox",
        bundleId: BUNDLE_ID,
        data: []
      })
    },
    verifier: {
      verifyAndDecodeTransaction: (jws: string) =>
        verifier.verifyAndDecodeTransaction(jws) as Promise<JWSTransactionDecodedPayload>,
      verifyAndDecodeNotification: (jws: string) => verifier.verifyAndDecodeNotification(jws),
      verifyAndDecodeRenewalInfo: (jws: string) => verifier.verifyAndDecodeRenewalInfo(jws)
    }
  }
}

function notificationPayload(
  signedTransactionInfo: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    notificationType: "DID_RENEW",
    notificationUUID: "6a3f1c5e-6a3f-4c5e-8a3f-1c5e6a3f1c5e",
    version: "2.0",
    signedDate: SIGNED_DATE,
    data: {
      bundleId: BUNDLE_ID,
      environment: Environment.SANDBOX,
      signedTransactionInfo,
      status: 1
    },
    ...overrides
  }
}

/**
 * Assert *why* verification failed, not merely that it did.
 *
 * A bare `rejects.toThrow()` here would pass for a fixture that never parsed, which would make
 * these tests look like they cover forgery while covering a typo.
 */
async function expectRejectedWith(
  verify: Promise<unknown>,
  status: VerificationStatus
): Promise<void> {
  const error = await verify.then(
    () => null,
    (caught: unknown) => caught as { status?: VerificationStatus }
  )
  expect(error, "verification unexpectedly succeeded").not.toBeNull()
  expect(error?.status).toBe(status)
}

describe("real JWS signature and certificate chain verification", () => {
  it("accepts a payload signed by a leaf chaining to the configured root", async () => {
    const ca = createAppleTestCertificateAuthority()
    const verifier = verifierFor(ca.rootCertificatePem)

    const decoded = await verifier.verifyAndDecodeTransaction(ca.sign(transactionPayload()))

    expect(decoded).toMatchObject({
      bundleId: BUNDLE_ID,
      productId: PRODUCT_ID,
      originalTransactionId: "2000000412345678"
    })
  })

  it("rejects a payload whose chain does not lead to the configured root", async () => {
    const ours = createAppleTestCertificateAuthority()
    const attacker = createAppleTestCertificateAuthority()
    const verifier = verifierFor(ours.rootCertificatePem)

    // A complete, internally consistent, correctly shaped chain — rooted somewhere else. Anyone
    // can mint one of these, so this is the check that makes the whole scheme mean anything.
    await expectRejectedWith(
      verifier.verifyAndDecodeTransaction(attacker.sign(transactionPayload())),
      VerificationStatus.VERIFICATION_FAILURE
    )
  })

  it("rejects a leaf the intermediate did not actually sign", async () => {
    const ca = createAppleTestCertificateAuthority({ untrustedLeaf: true })
    const verifier = verifierFor(ca.rootCertificatePem)

    // Every issuer and subject name still lines up; only the signature is wrong.
    await expectRejectedWith(
      verifier.verifyAndDecodeTransaction(ca.sign(transactionPayload())),
      VerificationStatus.VERIFICATION_FAILURE
    )
  })

  it("rejects a leaf missing Apple's marker extension", async () => {
    const ca = createAppleTestCertificateAuthority({ omitLeafMarkerOid: true })
    const verifier = verifierFor(ca.rootCertificatePem)

    // Without this, any certificate the root ever issued could sign StoreKit payloads.
    await expectRejectedWith(
      verifier.verifyAndDecodeTransaction(ca.sign(transactionPayload())),
      VerificationStatus.VERIFICATION_FAILURE
    )
  })

  it("rejects a chain that had expired when the payload was signed", async () => {
    const ca = createAppleTestCertificateAuthority({ expiredLeaf: true })
    const verifier = verifierFor(ca.rootCertificatePem)

    // Offline, the effective date is the payload's own signedDate rather than now.
    await expectRejectedWith(
      verifier.verifyAndDecodeTransaction(ca.sign(transactionPayload())),
      VerificationStatus.INVALID_CERTIFICATE
    )
  })

  it("rejects a payload whose body was altered after signing", async () => {
    const ca = createAppleTestCertificateAuthority()
    const verifier = verifierFor(ca.rootCertificatePem)
    const [header, , signature] = ca.sign(transactionPayload()).split(".")

    const tamperedBody = Buffer.from(
      JSON.stringify(transactionPayload({ productId: "com.example.pro.lifetime" }))
    ).toString("base64url")

    await expectRejectedWith(
      verifier.verifyAndDecodeTransaction(`${header}.${tamperedBody}.${signature}`),
      VerificationStatus.VERIFICATION_FAILURE
    )
  })

  it("rejects a payload signed for a different bundle", async () => {
    const ca = createAppleTestCertificateAuthority()
    const verifier = verifierFor(ca.rootCertificatePem)

    await expectRejectedWith(
      verifier.verifyAndDecodeTransaction(
        ca.sign(transactionPayload({ bundleId: "com.evil.app" }))
      ),
      VerificationStatus.INVALID_APP_IDENTIFIER
    )
  })

  it("carries a genuinely verified transaction through the module's own claim checks", async () => {
    const ca = createAppleTestCertificateAuthority()
    const verifier = verifierFor(ca.rootCertificatePem)
    const signed = ca.sign(transactionPayload())

    const runtime = runtimeFor(verifier, signed)

    const verified = await verifyStoreKitTransactionWithRuntime(signed, runtime)

    expect(verified.transaction.productId).toBe(PRODUCT_ID)
    expect(verified.verificationSource).toBe("apple_lookup")
  })

  it("rejects a product outside the allow-list even with a valid signature", async () => {
    const ca = createAppleTestCertificateAuthority()
    const verifier = verifierFor(ca.rootCertificatePem)
    const signed = ca.sign(transactionPayload())

    const runtime = runtimeFor(verifier, signed, new Set(["com.example.something.else"]))

    // A signature proves Apple signed it, not that you sell it.
    await expect(verifyStoreKitTransactionWithRuntime(signed, runtime)).rejects.toBeInstanceOf(
      StoreKitVerificationError
    )
  })

  it("accepts a notification signed by the configured chain", async () => {
    const ca = createAppleTestCertificateAuthority()
    const verifier = verifierFor(ca.rootCertificatePem)
    const signedTransaction = ca.sign(transactionPayload())
    const signedPayload = ca.sign(notificationPayload(signedTransaction))

    const verified = await verifyStoreKitNotificationWithRuntime(
      signedPayload,
      runtimeFor(verifier, signedTransaction)
    )

    expect(verified.notification.notificationType).toBe("DID_RENEW")
    expect(verified.transaction?.productId).toBe(PRODUCT_ID)
    expect(verified.latestSubscription?.status).toBe(1)
  })

  it("rejects a notification forged with an unrelated chain", async () => {
    const ours = createAppleTestCertificateAuthority()
    const attacker = createAppleTestCertificateAuthority()
    const verifier = verifierFor(ours.rootCertificatePem)
    const forged = attacker.sign(notificationPayload(attacker.sign(transactionPayload())))

    // The webhook is unauthenticated at the HTTP layer, so this signature is the only thing
    // standing between an attacker and a granted entitlement.
    await expect(
      verifyStoreKitNotificationWithRuntime(forged, runtimeFor(verifier, forged))
    ).rejects.toBeInstanceOf(StoreKitVerificationError)
  })

  it("rejects a notification whose embedded transaction is for a different bundle", async () => {
    const ca = createAppleTestCertificateAuthority()
    const verifier = verifierFor(ca.rootCertificatePem)
    const signedTransaction = ca.sign(transactionPayload())
    const signedPayload = ca.sign(
      notificationPayload(signedTransaction, {
        data: {
          bundleId: "com.evil.app",
          environment: Environment.SANDBOX,
          signedTransactionInfo: signedTransaction,
          status: 1
        }
      })
    )

    await expect(
      verifyStoreKitNotificationWithRuntime(signedPayload, runtimeFor(verifier, signedTransaction))
    ).rejects.toBeInstanceOf(StoreKitVerificationError)
  })
})
