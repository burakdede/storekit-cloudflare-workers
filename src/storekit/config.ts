/**
 * Configuration parsing and validation for the StoreKit module.
 *
 * Everything the module needs arrives as plain Worker variables and secrets. This file is the one
 * place that interprets them, so a host can validate its deployment up front — with
 * `describeStoreKitConfig` at startup or in a health check — instead of discovering a missing
 * secret when a customer's first purchase fails.
 */
import { Buffer } from "buffer"
import { StoreKitConfigError } from "./errors"
import {
  STOREKIT_ENVIRONMENT,
  type StoreKitEnv,
  type StoreKitEnvironment
} from "./types"

const TRUTHY = new Set(["true", "1", "yes", "on"])
const FALSY = new Set(["false", "0", "no", "off"])

function flag(raw: string | undefined, whenUnset: boolean): boolean {
  const value = raw?.trim().toLowerCase()
  if (!value) return whenUnset
  if (TRUTHY.has(value)) return true
  if (FALSY.has(value)) return false
  return whenUnset
}

function commaSeparated(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
}

export function requiredStoreKitValue(
  value: string | undefined,
  name: string
): string {
  const trimmed = value?.trim()
  if (!trimmed) throw new StoreKitConfigError(`${name} is required.`)
  return trimmed
}

/**
 * Parse the Apple root certificate bundle.
 *
 * The module verifies JWS chains offline against these roots, so an empty or malformed bundle
 * means no signature can ever be trusted. Download them from Apple's PKI page and store the
 * concatenated PEM as a secret.
 */
export function parseAppleRootCertificatesPem(
  rawPem: string | undefined
): Buffer[] {
  const trimmed = rawPem?.trim()
  if (!trimmed) return []

  const matches = trimmed.match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g
  )
  if (!matches) return []

  return matches.map((pem) => {
    const base64 = pem
      .replace("-----BEGIN CERTIFICATE-----", "")
      .replace("-----END CERTIFICATE-----", "")
      .replace(/\s+/g, "")
    return Buffer.from(base64, "base64")
  })
}

/** The closed product allow-list. A transaction for any other product is rejected. */
export function storeKitAllowedProductIds(env: StoreKitEnv): Set<string> {
  return new Set(commaSeparated(env.STOREKIT_ALLOWED_PRODUCT_IDS))
}

export function storeKitSandboxPreReleaseEnabled(env: StoreKitEnv): boolean {
  return flag(env.STOREKIT_ALLOW_SANDBOX_PRE_RELEASE, false)
}

/** Whether a verified submitted JWS may be used when an Apple lookup is unavailable. */
export function storeKitAppleLookupFallbackEnabled(env: StoreKitEnv): boolean {
  return flag(env.STOREKIT_ALLOW_APPLE_LOOKUP_FALLBACK, true)
}

/**
 * Whether a billing grace period grants access. Defaults to `true`, which is Apple's intent: the
 * customer is still being served while their payment is retried.
 */
export function storeKitAllowGracePeriodAccess(env: StoreKitEnv): boolean {
  return flag(env.STOREKIT_ALLOW_GRACE_PERIOD_ACCESS, true)
}

/**
 * Whether each notification re-reads Apple's authoritative subscription status instead of
 * projecting the payload alone. Defaults to `true`.
 */
export function storeKitReconcileNotifications(env: StoreKitEnv): boolean {
  return flag(env.STOREKIT_RECONCILE_NOTIFICATIONS, true)
}

/**
 * The environments this deployment accepts, production first.
 *
 * Order matters: a payload is tried against production before sandbox, so a production
 * deployment never mistakes a sandbox-signed transaction for a real purchase.
 */
export function storeKitConfiguredEnvironments(
  env: StoreKitEnv
): StoreKitEnvironment[] {
  const values = new Set(commaSeparated(env.STOREKIT_ALLOWED_ENVIRONMENTS))

  if (values.size === 0) {
    throw new StoreKitConfigError(
      "At least one StoreKit environment must be configured."
    )
  }

  for (const value of values) {
    if (
      value !== STOREKIT_ENVIRONMENT.SANDBOX &&
      value !== STOREKIT_ENVIRONMENT.PRODUCTION
    ) {
      throw new StoreKitConfigError("Unsupported StoreKit environment.")
    }
  }

  const environments: StoreKitEnvironment[] = []
  if (values.has(STOREKIT_ENVIRONMENT.PRODUCTION)) {
    environments.push(STOREKIT_ENVIRONMENT.PRODUCTION)
  }
  if (values.has(STOREKIT_ENVIRONMENT.SANDBOX)) {
    environments.push(STOREKIT_ENVIRONMENT.SANDBOX)
  }
  return environments
}

export function storeKitConfiguredEnvironment(
  env: StoreKitEnv
): StoreKitEnvironment {
  return (
    storeKitConfiguredEnvironments(env)[0] ?? STOREKIT_ENVIRONMENT.PRODUCTION
  )
}

/**
 * Apple requires the numeric app id to verify production notifications, but has no such concept
 * in sandbox.
 */
export function storeKitAppAppleId(
  env: StoreKitEnv,
  environment: StoreKitEnvironment
): number | undefined {
  if (environment === STOREKIT_ENVIRONMENT.SANDBOX) return undefined
  const raw = requiredStoreKitValue(
    env.APP_STORE_APP_APPLE_ID,
    "APP_STORE_APP_APPLE_ID"
  )
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new StoreKitConfigError(
      "APP_STORE_APP_APPLE_ID must be a positive integer."
    )
  }
  return parsed
}

export interface StoreKitConfigReport {
  valid: boolean
  /** Human-readable problems, safe to log. Never contains secret values. */
  problems: string[]
  environments: StoreKitEnvironment[]
  bundleId: string | null
  productIds: string[]
  allowAppleLookupFallback: boolean
  allowSandboxPreRelease: boolean
  /** Which secrets are present. Values are never reported, only presence. */
  secretsPresent: Record<string, boolean>
}

/**
 * Check a deployment's StoreKit configuration without contacting Apple.
 *
 * Intended for a startup assertion or a health endpoint. It reports secret *presence* only —
 * never a value — so the result is safe to log or expose to an operator dashboard.
 */
export function describeStoreKitConfig(env: StoreKitEnv): StoreKitConfigReport {
  const problems: string[] = []

  let environments: StoreKitEnvironment[] = []
  try {
    environments = storeKitConfiguredEnvironments(env)
  } catch (error) {
    problems.push(
      error instanceof Error
        ? error.message
        : "STOREKIT_ALLOWED_ENVIRONMENTS is invalid."
    )
  }

  const bundleId = env.STOREKIT_BUNDLE_ID?.trim() || null
  if (!bundleId) problems.push("STOREKIT_BUNDLE_ID is required.")

  const productIds = [...storeKitAllowedProductIds(env)]
  if (productIds.length === 0) {
    problems.push(
      "STOREKIT_ALLOWED_PRODUCT_IDS is required and must not be empty."
    )
  }

  const secretsPresent: Record<string, boolean> = {
    APP_STORE_CONNECT_ISSUER_ID: Boolean(
      env.APP_STORE_CONNECT_ISSUER_ID?.trim()
    ),
    APP_STORE_CONNECT_KEY_ID: Boolean(env.APP_STORE_CONNECT_KEY_ID?.trim()),
    APP_STORE_CONNECT_PRIVATE_KEY: Boolean(
      env.APP_STORE_CONNECT_PRIVATE_KEY?.trim()
    ),
    APPLE_ROOT_CERTIFICATES_PEM: Boolean(
      env.APPLE_ROOT_CERTIFICATES_PEM?.trim()
    )
  }
  for (const [name, present] of Object.entries(secretsPresent)) {
    if (!present) problems.push(`${name} is required.`)
  }

  if (secretsPresent.APPLE_ROOT_CERTIFICATES_PEM) {
    const roots = parseAppleRootCertificatesPem(env.APPLE_ROOT_CERTIFICATES_PEM)
    if (roots.length === 0) {
      problems.push(
        "APPLE_ROOT_CERTIFICATES_PEM does not contain any PEM certificate block."
      )
    }
  }

  if (secretsPresent.APP_STORE_CONNECT_PRIVATE_KEY) {
    const key = env.APP_STORE_CONNECT_PRIVATE_KEY?.trim() ?? ""
    if (!key.includes("-----BEGIN PRIVATE KEY-----")) {
      problems.push(
        "APP_STORE_CONNECT_PRIVATE_KEY must be the PEM (.p8) contents, including the BEGIN line."
      )
    }
  }

  if (environments.includes(STOREKIT_ENVIRONMENT.PRODUCTION)) {
    try {
      storeKitAppAppleId(env, STOREKIT_ENVIRONMENT.PRODUCTION)
    } catch (error) {
      problems.push(
        error instanceof Error
          ? error.message
          : "APP_STORE_APP_APPLE_ID is invalid."
      )
    }
  }

  return {
    valid: problems.length === 0,
    problems,
    environments,
    bundleId,
    productIds,
    allowAppleLookupFallback: storeKitAppleLookupFallbackEnabled(env),
    allowSandboxPreRelease: storeKitSandboxPreReleaseEnabled(env),
    secretsPresent
  }
}

/** Throw unless the deployment is fully configured. Use at startup to fail fast. */
export function assertStoreKitConfig(env: StoreKitEnv): void {
  const report = describeStoreKitConfig(env)
  if (!report.valid) {
    throw new StoreKitConfigError(
      `StoreKit is misconfigured: ${report.problems.join(" ")}`
    )
  }
}
