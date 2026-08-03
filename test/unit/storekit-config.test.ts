import { describe, expect, it } from "vitest"
import {
  parseAppleRootCertificatesPem,
  storeKitAppleLookupFallbackEnabled,
  storeKitAllowedProductIds,
  storeKitConfiguredEnvironment,
  storeKitConfiguredEnvironments,
  storeKitStatusName,
  StoreKitConfigError,
  StoreKitVerificationError
} from "../../src/storekit"

describe("storekit configuration", () => {
  it("requires at least one supported configured StoreKit environment", () => {
    expect(() => storeKitConfiguredEnvironment({})).toThrow(StoreKitConfigError)
    expect(
      storeKitConfiguredEnvironments({
        STOREKIT_ALLOWED_ENVIRONMENTS: "Sandbox,Production"
      })
    ).toEqual(["Production", "Sandbox"])
    expect(
      storeKitConfiguredEnvironment({
        STOREKIT_ALLOWED_ENVIRONMENTS: "Sandbox,Production"
      })
    ).toBe("Production")
    expect(
      storeKitConfiguredEnvironment({
        STOREKIT_ALLOWED_ENVIRONMENTS: "Sandbox"
      })
    ).toBe("Sandbox")
    expect(
      storeKitConfiguredEnvironment({
        STOREKIT_ALLOWED_ENVIRONMENTS: "Production"
      })
    ).toBe("Production")
    expect(
      storeKitConfiguredEnvironments({
        STOREKIT_ALLOWED_ENVIRONMENTS: "Production",
        STOREKIT_ALLOW_SANDBOX_PRE_RELEASE: "true"
      })
    ).toEqual(["Production"])
    expect(() =>
      storeKitConfiguredEnvironment({
        STOREKIT_ALLOWED_ENVIRONMENTS: "Local"
      })
    ).toThrow(StoreKitConfigError)
  })

  it("parses allowed product ids as a strict set", () => {
    const productIds = storeKitAllowedProductIds({
      STOREKIT_ALLOWED_PRODUCT_IDS:
        "com.example.app.pro.annual, com.example.app.pro.monthly,,"
    })

    expect(productIds).toEqual(
      new Set([
        "com.example.app.pro.annual",
        "com.example.app.pro.monthly"
      ])
    )
  })

  it("allows operators to choose fail-open or fail-closed Apple lookup behavior", () => {
    expect(storeKitAppleLookupFallbackEnabled({})).toBe(true)
    expect(
      storeKitAppleLookupFallbackEnabled({
        STOREKIT_ALLOW_APPLE_LOOKUP_FALLBACK: "false"
      })
    ).toBe(false)
    expect(
      storeKitAppleLookupFallbackEnabled({
        STOREKIT_ALLOW_APPLE_LOOKUP_FALLBACK: "yes"
      })
    ).toBe(true)
  })

  it("parses PEM certificate blocks into DER buffers", () => {
    const certs = parseAppleRootCertificatesPem(`-----BEGIN CERTIFICATE-----
AQIDBA==
-----END CERTIFICATE-----

-----BEGIN CERTIFICATE-----
BQYHCA==
-----END CERTIFICATE-----`)

    expect(certs.map((cert) => [...cert])).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8]
    ])
  })

  it("maps Apple numeric status codes to stable names", () => {
    expect(storeKitStatusName(1)).toBe("active")
    expect(storeKitStatusName(2)).toBe("expired")
    expect(storeKitStatusName(3)).toBe("billing_retry")
    expect(storeKitStatusName(4)).toBe("grace_period")
    expect(storeKitStatusName(5)).toBe("revoked")
    expect(storeKitStatusName(undefined)).toBe("unknown")
  })

  it("uses stable StoreKit verification error names", () => {
    expect(new StoreKitVerificationError().name).toBe(
      "StoreKitVerificationError"
    )
  })

  it("preserves StoreKit verification diagnostics", () => {
    const error = new StoreKitVerificationError(
      "StoreKit transaction could not be verified.",
      "apple_transaction_lookup",
      {
        sdkErrorName: "APIException",
        appleHttpStatus: 401,
        appleApiError: 4010001,
        appleErrorMessage: "Authentication credentials are missing or invalid."
      }
    )

    expect(error).toMatchObject({
      name: "StoreKitVerificationError",
      stage: "apple_transaction_lookup",
      sdkErrorName: "APIException",
      appleHttpStatus: 401,
      appleApiError: 4010001,
      appleErrorMessage: "Authentication credentials are missing or invalid."
    })
  })
})
