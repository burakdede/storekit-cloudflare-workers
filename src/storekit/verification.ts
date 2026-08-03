/**
 * Apple-side StoreKit 2 verification for Cloudflare Workers.
 *
 * Every claim this module returns has been checked against an Apple signature and pinned to the
 * configured bundle id, environment and product allow-list. Nothing a client asserts is trusted.
 */
import type {
  JWSRenewalInfoDecodedPayload,
  JWSTransactionDecodedPayload,
  LastTransactionsItem,
  ResponseBodyV2DecodedPayload,
  StatusResponse
} from "@apple/app-store-server-library"
import type * as StoreKitLibrary from "@apple/app-store-server-library"
import { Buffer } from "buffer"
import {
  parseAppleRootCertificatesPem,
  requiredStoreKitValue,
  storeKitAllowedProductIds,
  storeKitAppAppleId,
  storeKitAppleLookupFallbackEnabled,
  storeKitConfiguredEnvironments
} from "./config"
import { resolveStoreKitEntitlementCore } from "./entitlement"
import {
  StoreKitConfigError,
  StoreKitVerificationError,
  StoreKitVerificationStageError,
  type StoreKitVerificationDiagnostics
} from "./errors"
import {
  STOREKIT_ENVIRONMENT,
  STOREKIT_STATUS,
  type StoreKitEntitlementSnapshot,
  type StoreKitEnv,
  type StoreKitEnvironment
} from "./types"

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
  renewalInfo?: JWSRenewalInfoDecodedPayload | undefined
}

export interface VerifiedStoreKitNotification {
  environment: StoreKitEnvironment
  notification: ResponseBodyV2DecodedPayload
  transaction: JWSTransactionDecodedPayload | null
  renewalInfo: JWSRenewalInfoDecodedPayload | null
  latestSubscription: LastTransactionsItem | null
}

/* eslint-disable no-unused-vars -- These structural SDK method signatures intentionally name parameters only for typing. */
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
    verifyAndDecodeRenewalInfo: (
      ..._args: [string]
    ) => Promise<JWSRenewalInfoDecodedPayload>
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
/* eslint-enable no-unused-vars */

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
      // Workers `fetch` accepts no Node Buffer, so a body is narrowed by `typeof` rather than by
      // `instanceof Buffer`, which does not narrow reliably across @types/node versions.
      init.body =
        typeof requestBody === "string"
          ? requestBody
          : new Uint8Array(requestBody)
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
      storeKitAppAppleId(env, environment)
    )
  }
}

export async function buildStoreKitRuntimes(
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

function assertVerifiedRenewalInfoAllowed(
  renewalInfo: JWSRenewalInfoDecodedPayload,
  runtime: StoreKitRuntime,
  originalTransactionId: string,
  stage: string
): void {
  if (renewalInfo.originalTransactionId !== originalTransactionId) {
    throw new StoreKitVerificationStageError(
      stage,
      "Apple renewal info identity mismatch."
    )
  }
  if (
    renewalInfo.environment !== undefined &&
    renewalInfo.environment !== runtime.environment
  ) {
    throw new StoreKitVerificationStageError(
      stage,
      "Apple renewal info environment is not allowed."
    )
  }
}

/**
 * Renewal info carries `gracePeriodExpiresDate`, `autoRenewStatus` and `expirationIntent`, none of
 * which exist on the transaction payload. It is verified and identity-checked exactly like a
 * transaction JWS before the policy kernel is allowed to read it.
 */
async function verifyRenewalInfo(
  signedRenewalInfo: string,
  runtime: StoreKitRuntime,
  originalTransactionId: string,
  stage: string
): Promise<JWSRenewalInfoDecodedPayload> {
  let renewalInfo: JWSRenewalInfoDecodedPayload
  try {
    renewalInfo =
      await runtime.verifier.verifyAndDecodeRenewalInfo(signedRenewalInfo)
  } catch (error) {
    throw storeKitVerificationStageError(stage, error)
  }
  assertVerifiedRenewalInfoAllowed(
    renewalInfo,
    runtime,
    originalTransactionId,
    stage
  )
  return renewalInfo
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

export interface StoreKitSubscriptionState {
  statusResponse: StatusResponse
  latestSubscription: LastTransactionsItem | null
  subscriptionTransactions: VerifiedStoreKitSubscriptionTransaction[]
  diagnostics?: StoreKitVerificationDiagnostics | undefined
}

/**
 * Read Apple's authoritative subscription state for an original transaction id.
 *
 * `Get All Subscription Statuses` is the only source that reflects renewals, cancellations,
 * billing retry and grace periods as they stand right now, so both transaction sync and
 * notification processing reconcile against it. Every signed entry it returns is independently
 * verified and pinned to the same original transaction id before the policy kernel sees it.
 *
 * When the lookup fails and `allowAppleLookupFallback` is enabled, the caller is left with an
 * empty status set and resolves the entitlement from already-verified signed claims instead.
 */
export async function lookupStoreKitSubscriptionState(
  originalTransactionId: string,
  runtime: StoreKitRuntime
): Promise<StoreKitSubscriptionState> {
  const subscriptionTransactions: VerifiedStoreKitSubscriptionTransaction[] = []
  try {
    const statusResponse = await runtime.client.getAllSubscriptionStatuses(
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
        subscriptionTransaction.originalTransactionId !== originalTransactionId
      ) {
        throw new StoreKitVerificationStageError(
          "apple_subscription_transaction_claims",
          "Apple subscription transaction identity mismatch."
        )
      }
      const renewalInfo = subscription.signedRenewalInfo
        ? await verifyRenewalInfo(
            subscription.signedRenewalInfo,
            runtime,
            originalTransactionId,
            "apple_subscription_renewal_info_claims"
          )
        : undefined
      subscriptionTransactions.push({
        status: subscription.status,
        transaction: subscriptionTransaction,
        renewalInfo
      })
    }
    return {
      statusResponse,
      latestSubscription: matchingSubscriptions[0] ?? null,
      subscriptionTransactions
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
    return {
      statusResponse: fallbackStatusResponse(runtime),
      latestSubscription: null,
      subscriptionTransactions: [],
      diagnostics: hasStoreKitDiagnostics(diagnostics) ? diagnostics : undefined
    }
  }
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

    const subscriptionState = await lookupStoreKitSubscriptionState(
      originalTransactionId,
      runtime
    )

    return {
      environment: runtime.environment,
      transaction: authoritativeTransaction,
      statusResponse: subscriptionState.statusResponse,
      latestSubscription: subscriptionState.latestSubscription,
      subscriptionTransactions: subscriptionState.subscriptionTransactions,
      verificationSource,
      transactionLookupDiagnostics,
      subscriptionStatusLookupDiagnostics: subscriptionState.diagnostics
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

/**
 * Try each configured environment in turn, keeping the runtime that succeeded.
 *
 * A production-signed and a sandbox-signed JWS are indistinguishable before decoding, so the only
 * way to place a payload is to attempt verification per environment. Only failures that mean
 * "wrong environment" are retried; a claims violation inside the right environment is fatal.
 */
async function verifyAcrossStoreKitRuntimes<T>(
  runtimes: StoreKitRuntime[],
  // eslint-disable-next-line no-unused-vars -- Structural callback signature names its parameter only for typing.
  verify: (_runtime: StoreKitRuntime) => Promise<T>
): Promise<{ value: T; runtime: StoreKitRuntime }> {
  let lastError: StoreKitVerificationError | StoreKitConfigError | undefined

  for (const runtime of runtimes) {
    try {
      return { value: await verify(runtime), runtime }
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

export async function verifyStoreKitTransaction(
  signedTransactionJWS: string,
  env: StoreKitEnv
): Promise<VerifiedStoreKitTransaction> {
  const runtimes = await buildStoreKitRuntimes(env)
  const { value } = await verifyAcrossStoreKitRuntimes(runtimes, (runtime) =>
    verifyStoreKitTransactionWithRuntime(signedTransactionJWS, runtime)
  )
  return value
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
    let renewalInfo: JWSRenewalInfoDecodedPayload | null = null
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
      if (notification.data.signedRenewalInfo) {
        renewalInfo = await verifyRenewalInfo(
          notification.data.signedRenewalInfo,
          runtime,
          transaction.originalTransactionId,
          "notification_renewal_info_claims"
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
      renewalInfo,
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

/**
 * Verify a notification and hand back the runtime that accepted it, so the caller can reconcile
 * against Apple with the same credentials and environment the payload was signed for.
 */
export async function verifyStoreKitNotificationForRuntime(
  signedPayload: string,
  env: StoreKitEnv
): Promise<{
  verified: VerifiedStoreKitNotification
  runtime: StoreKitRuntime
}> {
  const runtimes = await buildStoreKitRuntimes(env)
  const { value, runtime } = await verifyAcrossStoreKitRuntimes(
    runtimes,
    (candidate) =>
      verifyStoreKitNotificationWithRuntime(signedPayload, candidate)
  )
  return { verified: value, runtime }
}

export async function verifyStoreKitNotification(
  signedPayload: string,
  env: StoreKitEnv
): Promise<VerifiedStoreKitNotification> {
  const { verified } = await verifyStoreKitNotificationForRuntime(
    signedPayload,
    env
  )
  return verified
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
  const latestRenewalInfo = verified.subscriptionTransactions.find(
    (candidate) => candidate.renewalInfo
  )?.renewalInfo
  return resolveStoreKitEntitlementCore(
    {
      environment: verified.environment,
      transaction: verified.transaction,
      latestSubscriptionStatus: verified.latestSubscription?.status,
      latestRenewalInfo,
      subscriptionTransactions: verified.subscriptionTransactions.map(
        (candidate) => ({
          status: candidate.status,
          transaction: candidate.transaction,
          renewalInfo: candidate.renewalInfo,
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
