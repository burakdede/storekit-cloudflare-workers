/**
 * Framework-neutral StoreKit service orchestration.
 *
 * Authentication, HTTP responses, logging, and environment policy belong to the caller. This
 * service combines Apple verification, entitlement policy, and the D1 adapter so a Worker can use
 * the module without importing this repository's mobile-session routes.
 */
import {
  resolveStoreKitEntitlement,
  StoreKitVerificationError,
  verifyStoreKitNotification,
  verifyStoreKitTransaction,
  type StoreKitEnv,
  type StoreKitEntitlementSnapshot,
  type VerifiedStoreKitNotification,
  type VerifiedStoreKitTransaction
} from "../storekit"
import {
  loadStoreKitSubscriptionByInstallation,
  persistStoreKitNotification,
  persistStoreKitSubscriptionForInstallation,
  storeKitNotificationExists,
  type StoreKitD1Env,
  type StoreKitSubscriptionRecord
} from "./storekit-d1"

export interface StoreKitServiceConfig {
  apple: StoreKitEnv
  d1: StoreKitD1Env
  allowGracePeriodAccess?: boolean
  sandboxAllowed?: boolean
  now?: Date
}

export interface StoreKitTransactionSyncInput {
  signedTransactionJWS: string
  appAccountToken?: string | undefined
  expectedAppAccountToken?: string | undefined
  installationId: string | null
  appBundleId: string
}

export interface StoreKitTransactionSyncResult {
  snapshot: StoreKitEntitlementSnapshot
  verified: VerifiedStoreKitTransaction
}

export interface StoreKitNotificationProcessResult {
  processed: boolean
  replayed: boolean
  snapshot: StoreKitEntitlementSnapshot | null
  verified: VerifiedStoreKitNotification
}

export interface StoreKitCurrentEntitlement {
  proActive: boolean
  productId: string | null
  expiresAt: string | null
  isTrial: boolean
  status: string
  environment: string
  appAccountToken: string | null
  resolvedAt: string
}

export async function syncStoreKitTransaction(
  input: StoreKitTransactionSyncInput,
  config: StoreKitServiceConfig
): Promise<StoreKitTransactionSyncResult> {
  if (
    input.appAccountToken &&
    input.expectedAppAccountToken &&
    input.appAccountToken !== input.expectedAppAccountToken
  ) {
    throw new StoreKitVerificationError(
      "StoreKit app account token does not match the authenticated account.",
      "app_account_token_claims"
    )
  }

  const verified = await verifyStoreKitTransaction(
    input.signedTransactionJWS,
    config.apple
  )
  if (input.appBundleId !== config.apple.STOREKIT_BUNDLE_ID) {
    throw new StoreKitVerificationError(
      "StoreKit app bundle does not match the configured bundle.",
      "app_bundle_claims"
    )
  }
  if (verified.environment === "Sandbox" && config.sandboxAllowed === false) {
    throw new StoreKitVerificationError(
      "StoreKit Sandbox transactions are not enabled for this request.",
      "sandbox_pre_release_policy"
    )
  }
  if (
    input.appAccountToken &&
    input.appAccountToken !== verified.transaction.appAccountToken
  ) {
    throw new StoreKitVerificationError(
      "StoreKit transaction app account token is not allowed.",
      "app_account_token_claims"
    )
  }
  if (
    input.expectedAppAccountToken &&
    verified.transaction.appAccountToken &&
    verified.transaction.appAccountToken !== input.expectedAppAccountToken
  ) {
    throw new StoreKitVerificationError(
      "StoreKit transaction app account token is not allowed.",
      "app_account_token_claims"
    )
  }

  const snapshot = resolveStoreKitEntitlement(
    verified,
    config.now,
    config.allowGracePeriodAccess ?? true
  )
  await persistStoreKitSubscriptionForInstallation(
    snapshot,
    input.installationId,
    input.appBundleId,
    config.d1
  )
  return { snapshot, verified }
}

export async function processStoreKitNotification(
  signedPayload: string,
  config: StoreKitServiceConfig
): Promise<StoreKitNotificationProcessResult> {
  const verified = await verifyStoreKitNotification(signedPayload, config.apple)
  if (verified.environment === "Sandbox" && config.sandboxAllowed === false) {
    throw new StoreKitVerificationError(
      "StoreKit Sandbox notifications are not enabled for this request.",
      "sandbox_pre_release_policy"
    )
  }
  const notificationUuid = verified.notification.notificationUUID
  const notificationType = verified.notification.notificationType
  if (!notificationUuid || !notificationType) {
    throw new StoreKitVerificationError(
      "StoreKit notification identity is missing.",
      "notification_claims"
    )
  }

  if (await storeKitNotificationExists(notificationUuid, config.d1)) {
    return { processed: true, replayed: true, snapshot: null, verified }
  }

  const snapshot =
    verified.transaction && verified.latestSubscription
      ? resolveStoreKitEntitlement(
          {
            environment: verified.environment,
            transaction: verified.transaction,
            statusResponse: {
              environment: verified.environment,
              bundleId: verified.transaction.bundleId ?? "",
              data: []
            },
            latestSubscription: verified.latestSubscription,
            subscriptionTransactions: [
              {
                status: verified.latestSubscription.status,
                transaction: verified.transaction
              }
            ]
          },
          config.now,
          config.allowGracePeriodAccess ?? true
        )
      : null

  await persistStoreKitNotification(
    {
      uuid: notificationUuid,
      type: notificationType,
      subtype: verified.notification.subtype ?? null,
      environment: verified.environment,
      originalTransactionId:
        verified.transaction?.originalTransactionId ?? null,
      transactionId: verified.transaction?.transactionId ?? null
    },
    snapshot,
    config.apple.STOREKIT_BUNDLE_ID ?? verified.transaction?.bundleId ?? "",
    config.d1
  )
  return { processed: true, replayed: false, snapshot, verified }
}

export async function readStoreKitEntitlement(
  installationId: string,
  readableEnvironments: string[],
  config: Pick<StoreKitServiceConfig, "d1">,
  resolvedAt = new Date()
): Promise<StoreKitSubscriptionRecord | null> {
  return loadStoreKitSubscriptionByInstallation(
    installationId,
    resolvedAt,
    readableEnvironments,
    config.d1
  )
}

export async function getStoreKitEntitlement(
  installationId: string,
  readableEnvironments: string[],
  config: Pick<StoreKitServiceConfig, "d1">,
  resolvedAt = new Date()
): Promise<StoreKitCurrentEntitlement> {
  const record = await readStoreKitEntitlement(
    installationId,
    readableEnvironments,
    config,
    resolvedAt
  )
  if (!record) {
    return {
      proActive: false,
      productId: null,
      expiresAt: null,
      isTrial: false,
      status: "free",
      environment: readableEnvironments[0] ?? "Sandbox",
      appAccountToken: null,
      resolvedAt: resolvedAt.toISOString()
    }
  }
  const expiresAtMillis = record.expiresAt
    ? Date.parse(record.expiresAt)
    : Number.NaN
  return {
    proActive:
      (record.status === "active_trial" ||
        record.status === "active_paid" ||
        record.status === "grace_period") &&
      Number.isFinite(expiresAtMillis) &&
      expiresAtMillis > resolvedAt.getTime(),
    productId: record.productId,
    expiresAt: record.expiresAt,
    isTrial: record.isTrial === true || record.isTrial === 1,
    status: record.status,
    environment: record.environment,
    appAccountToken: record.appAccountToken,
    resolvedAt: resolvedAt.toISOString()
  }
}
