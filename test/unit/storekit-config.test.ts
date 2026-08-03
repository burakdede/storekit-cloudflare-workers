import { describe, expect, it } from "vitest"
import {
  assertStoreKitConfig,
  describeStoreKitConfig,
  parseAppleRootCertificatesPem,
  storeKitAppleLookupFallbackEnabled,
  storeKitAllowedProductIds,
  storeKitConfiguredEnvironment,
  storeKitConfiguredEnvironments,
  storeKitStatusName,
  StoreKitConfigError,
  StoreKitVerificationError,
  type StoreKitEnv
} from "../../src/storekit"

const PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY-----\nMEECAQ==\n-----END PRIVATE KEY-----"
const ROOT_CERT =
  "-----BEGIN CERTIFICATE-----\nAQIDBA==\n-----END CERTIFICATE-----"

function completeConfig(overrides: Partial<StoreKitEnv> = {}): StoreKitEnv {
  return {
    STOREKIT_ALLOWED_ENVIRONMENTS: "Production",
    STOREKIT_BUNDLE_ID: "com.example.app",
    STOREKIT_ALLOWED_PRODUCT_IDS: "com.example.pro.monthly",
    APP_STORE_APP_APPLE_ID: "1234567890",
    APP_STORE_CONNECT_ISSUER_ID: "issuer",
    APP_STORE_CONNECT_KEY_ID: "key",
    APP_STORE_CONNECT_PRIVATE_KEY: PRIVATE_KEY,
    APPLE_ROOT_CERTIFICATES_PEM: ROOT_CERT,
    ...overrides
  }
}

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

  describe("deployment validation", () => {
    it("accepts a fully configured production deployment", () => {
      const report = describeStoreKitConfig(completeConfig())

      expect(report).toMatchObject({
        valid: true,
        problems: [],
        environments: ["Production"],
        bundleId: "com.example.app",
        productIds: ["com.example.pro.monthly"]
      })
      expect(() => assertStoreKitConfig(completeConfig())).not.toThrow()
    })

    it("never reports secret values, only their presence", () => {
      const report = describeStoreKitConfig(completeConfig())

      expect(report.secretsPresent).toEqual({
        APP_STORE_CONNECT_ISSUER_ID: true,
        APP_STORE_CONNECT_KEY_ID: true,
        APP_STORE_CONNECT_PRIVATE_KEY: true,
        APPLE_ROOT_CERTIFICATES_PEM: true
      })
      expect(JSON.stringify(report)).not.toContain("MEECAQ")
      expect(JSON.stringify(report)).not.toContain("issuer")
    })

    it.each([
      {
        name: "a missing bundle id",
        env: { STOREKIT_BUNDLE_ID: "" },
        problem: /BUNDLE_ID/
      },
      {
        name: "an empty product allow-list",
        env: { STOREKIT_ALLOWED_PRODUCT_IDS: "" },
        problem: /PRODUCT_IDS/
      },
      {
        name: "a missing issuer id",
        env: { APP_STORE_CONNECT_ISSUER_ID: "" },
        problem: /ISSUER_ID/
      },
      {
        name: "a private key that is not PEM",
        env: { APP_STORE_CONNECT_PRIVATE_KEY: "not-a-pem-key" },
        problem: /PRIVATE_KEY/
      },
      {
        name: "a root bundle with no certificate block",
        env: { APPLE_ROOT_CERTIFICATES_PEM: "garbage" },
        problem: /ROOT_CERTIFICATES/
      },
      {
        name: "a production deployment with no numeric app id",
        env: { APP_STORE_APP_APPLE_ID: "" },
        problem: /APP_STORE_APP_APPLE_ID/
      },
      {
        name: "a non-numeric app id",
        env: { APP_STORE_APP_APPLE_ID: "not-a-number" },
        problem: /positive integer/
      }
    ])("reports $name", ({ env, problem }) => {
      const report = describeStoreKitConfig(completeConfig(env))

      expect(report.valid).toBe(false)
      expect(report.problems.join(" ")).toMatch(problem)
      expect(() => assertStoreKitConfig(completeConfig(env))).toThrow(
        StoreKitConfigError
      )
    })

    it("does not demand a numeric app id for a sandbox-only deployment", () => {
      const report = describeStoreKitConfig(
        completeConfig({
          STOREKIT_ALLOWED_ENVIRONMENTS: "Sandbox",
          APP_STORE_APP_APPLE_ID: ""
        })
      )

      expect(report.valid).toBe(true)
    })

    it("collects every problem at once rather than failing on the first", () => {
      const report = describeStoreKitConfig({})

      expect(report.valid).toBe(false)
      expect(report.problems.length).toBeGreaterThan(4)
    })
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
