import type {
  JWSTransactionDecodedPayload,
  LastTransactionsItem,
  ResponseBodyV2DecodedPayload,
  StatusResponse
} from "@apple/app-store-server-library"
import type * as StoreKitLibrary from "@apple/app-store-server-library"
import { Buffer } from "buffer"
import { resolveStoreKitEntitlementCore } from "./lib/storekit-entitlement-core"

export {
  resolveStoreKitEntitlementCore,
  type StoreKitEntitlementCandidate,
  type StoreKitEntitlementInput,
  type StoreKitEntitlementTransaction
} from "./lib/storekit-entitlement-core"

const STOREKIT_ENVIRONMENT = {
  SANDBOX: "Sandbox",
  PRODUCTION: "Production"
} as const

const STOREKIT_STATUS = {
  ACTIVE: 1,
  EXPIRED: 2,
  BILLING_RETRY: 3,
  BILLING_GRACE_PERIOD: 4,
  REVOKED: 5
} as const

export type StoreKitEnvironment =
  typeof STOREKIT_ENVIRONMENT.SANDBOX | typeof STOREKIT_ENVIRONMENT.PRODUCTION

export interface StoreKitEnv {
  STOREKIT_ALLOWED_ENVIRONMENTS?: string
  STOREKIT_ALLOW_SANDBOX_PRE_RELEASE?: string
  STOREKIT_ALLOWED_PRODUCT_IDS?: string
  STOREKIT_ALLOW_APPLE_LOOKUP_FALLBACK?: string
  STOREKIT_BUNDLE_ID?: string
  APP_STORE_CONNECT_ISSUER_ID?: string
  APP_STORE_CONNECT_KEY_ID?: string
  APP_STORE_CONNECT_PRIVATE_KEY?: string
  APP_STORE_APP_APPLE_ID?: string
  APPLE_ROOT_CERTIFICATES_PEM?: string
}

export interface VerifiedStoreKitTransaction {
  environment: StoreKitEnvironment
  transaction: JWSTransactionDecodedPayload
  statusResponse: StatusResponse
  latestSubscription: LastTransactionsItem | null
  subscriptionTransactions: VerifiedStoreKitSubscriptionTransaction[]
  verificationSource?: "submitted_jws" | "apple_lookup" | undefined
  transactionLookupDiagnostics?: StoreKitVerificationDiagnostics | undefined
  subscriptionStatusLookupDiagnostics?:
    StoreKitVerificationDiagnostics | undefined
}

export interface VerifiedStoreKitSubscriptionTransaction {
  status: number | undefined
  transaction: JWSTransactionDecodedPayload
}

export interface VerifiedStoreKitNotification {
  environment: StoreKitEnvironment
  notification: ResponseBodyV2DecodedPayload
  transaction: JWSTransactionDecodedPayload | null
  latestSubscription: LastTransactionsItem | null
}

export type StoreKitEntitlementStatus =
  | "free"
  | "active_trial"
  | "active_paid"
  | "grace_period"
  | "billing_retry"
  | "expired"
  | "revoked"
  | "refunded"
  | "unknown"

export interface StoreKitEntitlementSnapshot {
  proActive: boolean
  productId: string | null
  expiresAt: string | null
  isTrial: boolean
  status: StoreKitEntitlementStatus
  environment: StoreKitEnvironment
  originalTransactionId: string | null
  latestTransactionId: string | null
  webOrderLineItemId: string | null
  purchaseDate: string | null
  revocationDate: string | null
  appAccountToken: string | null
  source: "posted_jws" | "apple_transaction_lookup" | "app_store_history"
  resolvedAt: string
}

export class StoreKitConfigError extends Error {
  constructor(message = "StoreKit verification is not configured.") {
    super(message)
    this.name = "StoreKitConfigError"
  }
}

export class StoreKitVerificationError extends Error {
  readonly stage: string
  readonly sdkErrorName: string | undefined
  readonly sdkErrorMessage: string | undefined
  readonly appleHttpStatus: number | undefined
  readonly appleApiError: number | undefined
  readonly appleErrorMessage: string | undefined

  constructor(
    message = "StoreKit transaction could not be verified.",
    stage = "unknown",
    diagnostics: StoreKitVerificationDiagnostics = {}
  ) {
    super(message)
    this.name = "StoreKitVerificationError"
    this.stage = stage
    this.sdkErrorName = diagnostics.sdkErrorName
    this.sdkErrorMessage = diagnostics.sdkErrorMessage
    this.appleHttpStatus = diagnostics.appleHttpStatus
    this.appleApiError = diagnostics.appleApiError
    this.appleErrorMessage = diagnostics.appleErrorMessage
  }
}

export interface StoreKitVerificationDiagnostics {
  sdkErrorName?: string | undefined
  sdkErrorMessage?: string | undefined
  appleHttpStatus?: number | undefined
  appleApiError?: number | undefined
  appleErrorMessage?: string | undefined
}

class StoreKitVerificationStageError extends StoreKitVerificationError {
  constructor(
    stage: string,
    message = "StoreKit transaction could not be verified.",
    diagnostics: StoreKitVerificationDiagnostics = {}
  ) {
    super(message, stage, diagnostics)
  }
}

export interface StoreKitRuntime {
  environment: StoreKitEnvironment
  bundleId: string
  allowedProductIds: Set<string>
  allowAppleLookupFallback: boolean
  client: {
    getTransactionInfo: (
      ..._args: [string]
    ) => Promise<{ signedTransactionInfo?: string }>
    getAllSubscriptionStatuses: (..._args: [string]) => Promise<StatusResponse>
  }
  verifier: {
    verifyAndDecodeTransaction: (
      ..._args: [string]
    ) => Promise<JWSTransactionDecodedPayload>
    verifyAndDecodeNotification: (
      ..._args: [string]
    ) => Promise<ResponseBodyV2DecodedPayload>
  }
}

type AppleFetchRequestArgs = [
  string,
  URLSearchParams,
  string,
  string | Buffer | undefined,
  Record<string, string>
]

type AppleServerApiClient = StoreKitRuntime["client"] & {
  makeFetchRequest?: (...args: AppleFetchRequestArgs) => Promise<Response>
}
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

export function storeKitAllowedProductIds(env: StoreKitEnv): Set<string> {
  const raw = env.STOREKIT_ALLOWED_PRODUCT_IDS?.trim()
  if (!raw) return new Set()
  return new Set(
    raw
      .split(",")
      .map((productId) => productId.trim())
      .filter(Boolean)
  )
}

export function storeKitSandboxPreReleaseEnabled(env: StoreKitEnv): boolean {
  const raw = env.STOREKIT_ALLOW_SANDBOX_PRE_RELEASE?.trim().toLowerCase()
  return raw === "true" || raw === "1" || raw === "yes"
}

/** Return whether a verified submitted JWS may be used when an Apple lookup is unavailable. */
export function storeKitAppleLookupFallbackEnabled(env: StoreKitEnv): boolean {
  const raw = env.STOREKIT_ALLOW_APPLE_LOOKUP_FALLBACK?.trim().toLowerCase()
  return raw !== "false" && raw !== "0" && raw !== "no" && raw !== "off"
}

export function storeKitConfiguredEnvironments(
  env: StoreKitEnv
): StoreKitEnvironment[] {
  const values = new Set(
    (env.STOREKIT_ALLOWED_ENVIRONMENTS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  )

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

/* v8 ignore start -- Apple verifier construction requires runtime secrets and real Apple cert material. */
function requiredStoreKitValue(
  value: string | undefined,
  name: string
): string {
  const trimmed = value?.trim()
  if (!trimmed) throw new StoreKitConfigError(`${name} is required.`)
  return trimmed
}

function optionalAppAppleId(
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
/* v8 ignore stop */

/* v8 ignore start -- Apple SDK verifier/client wiring requires Apple-signed JWS fixtures. */
async function loadStoreKitLibrary(): Promise<typeof StoreKitLibrary> {
  return import("@apple/app-store-server-library")
}

async function buildStoreKitRuntime(
  env: StoreKitEnv,
  environment: StoreKitEnvironment
): Promise<StoreKitRuntime> {
  const bundleId = requiredStoreKitValue(
    env.STOREKIT_BUNDLE_ID,
    "STOREKIT_BUNDLE_ID"
  )
  const allowedProductIds = storeKitAllowedProductIds(env)
  if (allowedProductIds.size === 0) {
    throw new StoreKitConfigError("STOREKIT_ALLOWED_PRODUCT_IDS is required.")
  }

  const issuerId = requiredStoreKitValue(
    env.APP_STORE_CONNECT_ISSUER_ID,
    "APP_STORE_CONNECT_ISSUER_ID"
  )
  const keyId = requiredStoreKitValue(
    env.APP_STORE_CONNECT_KEY_ID,
    "APP_STORE_CONNECT_KEY_ID"
  )
  const privateKey = requiredStoreKitValue(
    env.APP_STORE_CONNECT_PRIVATE_KEY,
    "APP_STORE_CONNECT_PRIVATE_KEY"
  )
  const rootCertificates = parseAppleRootCertificatesPem(
    env.APPLE_ROOT_CERTIFICATES_PEM
  )
  if (rootCertificates.length === 0) {
    throw new StoreKitConfigError("APPLE_ROOT_CERTIFICATES_PEM is required.")
  }
  const { AppStoreServerAPIClient, Environment, SignedDataVerifier } =
    await loadStoreKitLibrary()
  const sdkEnvironment =
    environment === STOREKIT_ENVIRONMENT.SANDBOX
      ? Environment.SANDBOX
      : Environment.PRODUCTION
  const client: StoreKitRuntime["client"] = new AppStoreServerAPIClient(
    privateKey,
    keyId,
    issuerId,
    bundleId,
    sdkEnvironment
  )
  const fetchClient = client as AppleServerApiClient
  const urlBase =
    environment === STOREKIT_ENVIRONMENT.SANDBOX
      ? "https://api.storekit-sandbox.apple.com"
      : "https://api.storekit.apple.com"
  fetchClient.makeFetchRequest = async (
    path,
    parsedQueryParameters,
    method,
    requestBody,
    headers
  ) => {
    const init: RequestInit = {
      method,
      headers
    }
    if (requestBody !== undefined) {
      init.body = new TextEncoder().encode(requestBody.toString()).buffer
    }
    return fetch(`${urlBase}${path}?${parsedQueryParameters}`, init)
  }

  return {
    environment,
    bundleId,
    allowedProductIds,
    allowAppleLookupFallback: storeKitAppleLookupFallbackEnabled(env),
    client: fetchClient,
    verifier: new SignedDataVerifier(
      rootCertificates,
      // The Apple Node SDK's online OCSP path calls Response.buffer(), which is not available
      // in the Cloudflare Workers fetch runtime. Offline mode still validates the JWS
      // signature and Apple certificate chain against the transaction signed date.
      false,
      sdkEnvironment,
      bundleId,
      optionalAppAppleId(env, environment)
    )
  }
}

async function buildStoreKitRuntimes(
  env: StoreKitEnv
): Promise<StoreKitRuntime[]> {
  const environments = storeKitConfiguredEnvironments(env)
  return Promise.all(
    environments.map((environment) => buildStoreKitRuntime(env, environment))
  )
}

function assertVerifiedTransactionAllowed(
  transaction: JWSTransactionDecodedPayload,
  runtime: StoreKitRuntime,
  stage: string
): void {
  if (!transaction.transactionId || !transaction.originalTransactionId) {
    throw new StoreKitVerificationStageError(
      stage,
      "StoreKit transaction identity is missing."
    )
  }
  if (transaction.bundleId !== runtime.bundleId) {
    throw new StoreKitVerificationStageError(
      stage,
      "StoreKit transaction bundle is not allowed."
    )
  }
  if (transaction.environment !== runtime.environment) {
    throw new StoreKitVerificationStageError(
      stage,
      "StoreKit transaction environment is not allowed."
    )
  }
  if (
    !transaction.productId ||
    !runtime.allowedProductIds.has(transaction.productId)
  ) {
    throw new StoreKitVerificationStageError(
      stage,
      "StoreKit transaction product is not allowed."
    )
  }
}

function matchingSubscriptionItems(
  statusResponse: StatusResponse,
  originalTransactionId: string
): LastTransactionsItem[] {
  const matches: LastTransactionsItem[] = []
  for (const group of statusResponse.data ?? []) {
    for (const transaction of group.lastTransactions ?? []) {
      if (transaction.originalTransactionId === originalTransactionId) {
        matches.push(transaction)
      }
    }
  }
  return matches
}

function fallbackStatusResponse(runtime: StoreKitRuntime): StatusResponse {
  return {
    environment: runtime.environment,
    bundleId: runtime.bundleId,
    data: []
  }
}

function isAppleStoreKitSdkError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "APIException" || error.name === "VerificationException")
  )
}

function readRecordValue(
  record: Record<string, unknown>,
  key: string
): unknown {
  return record[key]
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function storeKitErrorDiagnostics(
  error: unknown
): StoreKitVerificationDiagnostics {
  if (!(error instanceof Error)) return {}
  const record = error as Error & Record<string, unknown>
  return {
    sdkErrorName: error.name,
    sdkErrorMessage: error.message || undefined,
    appleHttpStatus: optionalNumber(readRecordValue(record, "httpStatusCode")),
    appleApiError: optionalNumber(readRecordValue(record, "apiError")),
    appleErrorMessage: optionalString(readRecordValue(record, "errorMessage"))
  }
}

function hasStoreKitDiagnostics(
  diagnostics: StoreKitVerificationDiagnostics
): boolean {
  return Object.values(diagnostics).some((value) => value !== undefined)
}

function storeKitVerificationStageError(
  stage: string,
  error: unknown
): StoreKitVerificationError {
  if (error instanceof StoreKitVerificationError) return error
  return new StoreKitVerificationStageError(
    stage,
    "StoreKit transaction could not be verified.",
    storeKitErrorDiagnostics(error)
  )
}

export async function verifyStoreKitTransactionWithRuntime(
  signedTransactionJWS: string,
  runtime: StoreKitRuntime
): Promise<VerifiedStoreKitTransaction> {
  try {
    let submittedTransaction: JWSTransactionDecodedPayload
    try {
      submittedTransaction =
        await runtime.verifier.verifyAndDecodeTransaction(signedTransactionJWS)
    } catch (error) {
      throw storeKitVerificationStageError("submitted_jws_decode", error)
    }
    assertVerifiedTransactionAllowed(
      submittedTransaction,
      runtime,
      "submitted_jws_claims"
    )

    const transactionId = submittedTransaction.transactionId
    if (!transactionId) {
      throw new StoreKitVerificationStageError(
        "submitted_jws_claims",
        "StoreKit transaction id is missing."
      )
    }

    let authoritativeTransaction = submittedTransaction
    let verificationSource: "submitted_jws" | "apple_lookup" = "submitted_jws"
    let transactionInfo: { signedTransactionInfo?: string } | null = null
    let transactionLookupDiagnostics:
      StoreKitVerificationDiagnostics | undefined
    try {
      transactionInfo = await runtime.client.getTransactionInfo(transactionId)
    } catch (error) {
      const diagnostics = storeKitErrorDiagnostics(error)
      if (!runtime.allowAppleLookupFallback) {
        throw new StoreKitVerificationStageError(
          "apple_transaction_lookup",
          "Apple transaction lookup is unavailable.",
          diagnostics
        )
      }
      transactionLookupDiagnostics = hasStoreKitDiagnostics(diagnostics)
        ? diagnostics
        : undefined
      transactionInfo = null
    }
    if (transactionInfo?.signedTransactionInfo) {
      let appleTransaction: JWSTransactionDecodedPayload
      try {
        appleTransaction = await runtime.verifier.verifyAndDecodeTransaction(
          transactionInfo.signedTransactionInfo
        )
      } catch (error) {
        throw storeKitVerificationStageError(
          "apple_transaction_jws_decode",
          error
        )
      }
      assertVerifiedTransactionAllowed(
        appleTransaction,
        runtime,
        "apple_transaction_claims"
      )

      if (
        appleTransaction.originalTransactionId !==
        submittedTransaction.originalTransactionId
      ) {
        throw new StoreKitVerificationStageError(
          "apple_transaction_claims",
          "Apple transaction identity mismatch."
        )
      }
      authoritativeTransaction = appleTransaction
      verificationSource = "apple_lookup"
    }

    const originalTransactionId = authoritativeTransaction.originalTransactionId
    if (!originalTransactionId) {
      throw new StoreKitVerificationStageError(
        "apple_transaction_claims",
        "Apple original transaction id is missing."
      )
    }

    let statusResponse: StatusResponse = fallbackStatusResponse(runtime)
    let latestSubscription: LastTransactionsItem | null = null
    let subscriptionTransactions: VerifiedStoreKitSubscriptionTransaction[] = []
    let subscriptionStatusLookupDiagnostics:
      StoreKitVerificationDiagnostics | undefined
    try {
      statusResponse = await runtime.client.getAllSubscriptionStatuses(
        originalTransactionId
      )
      if (
        statusResponse.environment !== runtime.environment ||
        statusResponse.bundleId !== runtime.bundleId
      ) {
        throw new StoreKitVerificationStageError(
          "apple_subscription_status_claims",
          "Apple subscription status response is not allowed."
        )
      }
      const matchingSubscriptions = matchingSubscriptionItems(
        statusResponse,
        originalTransactionId
      )
      latestSubscription = matchingSubscriptions[0] ?? null
      for (const subscription of matchingSubscriptions) {
        if (!subscription.signedTransactionInfo) continue
        let subscriptionTransaction: JWSTransactionDecodedPayload
        try {
          subscriptionTransaction =
            await runtime.verifier.verifyAndDecodeTransaction(
              subscription.signedTransactionInfo
            )
        } catch (error) {
          throw storeKitVerificationStageError(
            "apple_subscription_transaction_jws_decode",
            error
          )
        }
        assertVerifiedTransactionAllowed(
          subscriptionTransaction,
          runtime,
          "apple_subscription_transaction_claims"
        )
        if (
          subscriptionTransaction.originalTransactionId !==
          originalTransactionId
        ) {
          throw new StoreKitVerificationStageError(
            "apple_subscription_transaction_claims",
            "Apple subscription transaction identity mismatch."
          )
        }
        subscriptionTransactions.push({
          status: subscription.status,
          transaction: subscriptionTransaction
        })
      }
    } catch (error) {
      if (error instanceof StoreKitVerificationError) {
        throw error
      }
      const diagnostics = storeKitErrorDiagnostics(error)
      if (!runtime.allowAppleLookupFallback) {
        throw new StoreKitVerificationStageError(
          "apple_subscription_status_lookup",
          "Apple subscription status lookup is unavailable.",
          diagnostics
        )
      }
      subscriptionStatusLookupDiagnostics = hasStoreKitDiagnostics(diagnostics)
        ? diagnostics
        : undefined
      statusResponse = fallbackStatusResponse(runtime)
      latestSubscription = null
    }

    return {
      environment: runtime.environment,
      transaction: authoritativeTransaction,
      statusResponse,
      latestSubscription,
      subscriptionTransactions,
      verificationSource,
      transactionLookupDiagnostics,
      subscriptionStatusLookupDiagnostics
    }
  } catch (error) {
    if (
      error instanceof StoreKitVerificationError ||
      error instanceof StoreKitConfigError
    ) {
      throw error
    }
    if (isAppleStoreKitSdkError(error)) {
      throw new StoreKitVerificationError(
        "StoreKit transaction could not be verified.",
        "apple_sdk_unclassified",
        storeKitErrorDiagnostics(error)
      )
    }
    throw new StoreKitVerificationError(
      "StoreKit transaction could not be verified.",
      "storekit_unclassified"
    )
  }
}

function isRetryableStoreKitEnvironmentError(error: unknown): boolean {
  return (
    error instanceof StoreKitVerificationError &&
    (error.stage === "submitted_jws_decode" ||
      error.stage === "submitted_jws_claims" ||
      error.stage === "notification_jws_decode" ||
      error.stage === "notification_claims")
  )
}

function storeKitNotificationAppIdentity(
  notification: ResponseBodyV2DecodedPayload
): { bundleId?: string; environment?: string } | null {
  if (notification.data) {
    return notification.data
  }
  if (notification.summary) {
    return notification.summary
  }
  if (notification.externalPurchaseToken) {
    return notification.externalPurchaseToken
  }
  if (notification.appData) {
    return notification.appData
  }
  return null
}

function hasExactlyOneStoreKitNotificationPayloadPart(
  notification: ResponseBodyV2DecodedPayload
): boolean {
  return (
    [
      notification.data,
      notification.appData,
      notification.summary,
      notification.externalPurchaseToken
    ].filter((value) => value !== undefined).length === 1
  )
}

export async function verifyStoreKitTransaction(
  signedTransactionJWS: string,
  env: StoreKitEnv
): Promise<VerifiedStoreKitTransaction> {
  const runtimes = await buildStoreKitRuntimes(env)
  let lastError: StoreKitVerificationError | StoreKitConfigError | undefined

  for (const runtime of runtimes) {
    try {
      return await verifyStoreKitTransactionWithRuntime(
        signedTransactionJWS,
        runtime
      )
    } catch (error) {
      if (
        error instanceof StoreKitVerificationError ||
        error instanceof StoreKitConfigError
      ) {
        lastError = error
      }
      if (!isRetryableStoreKitEnvironmentError(error)) {
        throw error
      }
    }
  }

  throw lastError ?? new StoreKitVerificationError()
}

export async function verifyStoreKitNotificationWithRuntime(
  signedPayload: string,
  runtime: StoreKitRuntime
): Promise<VerifiedStoreKitNotification> {
  try {
    let notification: ResponseBodyV2DecodedPayload
    try {
      notification =
        await runtime.verifier.verifyAndDecodeNotification(signedPayload)
    } catch (error) {
      throw storeKitVerificationStageError("notification_jws_decode", error)
    }
    const appIdentity = storeKitNotificationAppIdentity(notification)
    if (
      notification.version !== "2.0" ||
      !notification.notificationUUID ||
      !notification.notificationType ||
      !hasExactlyOneStoreKitNotificationPayloadPart(notification) ||
      !appIdentity?.bundleId
    ) {
      throw new StoreKitVerificationStageError(
        "notification_claims",
        "StoreKit notification payload is incomplete."
      )
    }
    if (
      (appIdentity.environment !== undefined &&
        appIdentity.environment !== runtime.environment) ||
      appIdentity.bundleId !== runtime.bundleId
    ) {
      throw new StoreKitVerificationStageError(
        "notification_claims",
        "StoreKit notification app identity is not allowed."
      )
    }
    let transaction: JWSTransactionDecodedPayload | null = null
    let latestSubscription: LastTransactionsItem | null = null
    if (notification.data?.signedTransactionInfo) {
      try {
        transaction = await runtime.verifier.verifyAndDecodeTransaction(
          notification.data.signedTransactionInfo
        )
      } catch (error) {
        throw storeKitVerificationStageError(
          "notification_transaction_jws_decode",
          error
        )
      }
      assertVerifiedTransactionAllowed(
        transaction,
        runtime,
        "notification_transaction_claims"
      )
      if (!transaction.originalTransactionId) {
        throw new StoreKitVerificationStageError(
          "notification_transaction_claims",
          "StoreKit notification transaction identity is incomplete."
        )
      }
      if (notification.data.status !== undefined) {
        latestSubscription = {
          status: notification.data.status,
          originalTransactionId: transaction.originalTransactionId,
          signedTransactionInfo: notification.data.signedTransactionInfo
        }
        if (notification.data.signedRenewalInfo) {
          latestSubscription.signedRenewalInfo =
            notification.data.signedRenewalInfo
        }
      }
    }

    return {
      environment: runtime.environment,
      notification,
      transaction,
      latestSubscription
    }
  } catch (error) {
    if (
      error instanceof StoreKitVerificationError ||
      error instanceof StoreKitConfigError
    ) {
      throw error
    }
    if (isAppleStoreKitSdkError(error)) {
      throw new StoreKitVerificationError(
        "StoreKit transaction could not be verified.",
        "apple_notification_sdk_unclassified",
        storeKitErrorDiagnostics(error)
      )
    }
    throw new StoreKitVerificationError(
      "StoreKit transaction could not be verified.",
      "storekit_notification_unclassified"
    )
  }
}

export async function verifyStoreKitNotification(
  signedPayload: string,
  env: StoreKitEnv
): Promise<VerifiedStoreKitNotification> {
  const runtimes = await buildStoreKitRuntimes(env)
  let lastError: StoreKitVerificationError | StoreKitConfigError | undefined

  for (const runtime of runtimes) {
    try {
      return await verifyStoreKitNotificationWithRuntime(signedPayload, runtime)
    } catch (error) {
      if (
        error instanceof StoreKitVerificationError ||
        error instanceof StoreKitConfigError
      ) {
        lastError = error
      }
      if (!isRetryableStoreKitEnvironmentError(error)) {
        throw error
      }
    }
  }

  throw lastError ?? new StoreKitVerificationError()
}
/* v8 ignore stop */

export function storeKitStatusName(status: number | undefined): string {
  switch (status) {
    case STOREKIT_STATUS.ACTIVE:
      return "active"
    case STOREKIT_STATUS.EXPIRED:
      return "expired"
    case STOREKIT_STATUS.BILLING_RETRY:
      return "billing_retry"
    case STOREKIT_STATUS.BILLING_GRACE_PERIOD:
      return "grace_period"
    case STOREKIT_STATUS.REVOKED:
      return "revoked"
    default:
      return "unknown"
  }
}

export function resolveStoreKitEntitlement(
  verified: VerifiedStoreKitTransaction,
  now = new Date(),
  allowGracePeriodAccess = true
): StoreKitEntitlementSnapshot {
  return resolveStoreKitEntitlementCore(
    {
      environment: verified.environment,
      transaction: verified.transaction,
      latestSubscriptionStatus: verified.latestSubscription?.status,
      subscriptionTransactions: verified.subscriptionTransactions.map(
        (candidate) => ({
          status: candidate.status,
          transaction: candidate.transaction,
          source: "app_store_history"
        })
      ),
      verificationSource:
        verified.verificationSource === "apple_lookup"
          ? "apple_transaction_lookup"
          : "posted_jws"
    },
    now,
    allowGracePeriodAccess
  )
}
