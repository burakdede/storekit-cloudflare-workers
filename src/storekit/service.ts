/**
 * Framework-neutral StoreKit service orchestration.
 *
 * Authentication, HTTP responses, logging, and environment policy belong to the caller. This
 * service combines Apple verification, entitlement policy, and the D1 adapter so a Worker can use
 * the module through one call per operation.
 */
import { resolveStoreKitEntitlementCore } from "./entitlement"
import { StoreKitVerificationError } from "./errors"
import type { StoreKitEntitlementSnapshot, StoreKitEnv } from "./types"
import {
  lookupStoreKitSubscriptionState,
  resolveStoreKitEntitlement,
  verifyStoreKitNotificationForRuntime,
  verifyStoreKitTransaction,
  type StoreKitRuntime,
  type VerifiedStoreKitNotification,
  type VerifiedStoreKitTransaction
} from "./verification"
import {
  loadStoreKitSubscriptionByInstallation,
  persistStoreKitNotification,
  persistStoreKitSubscriptionForInstallation,
  storeKitNotificationExists,
  type StoreKitDatabase,
  type StoreKitSubscriptionRecord
} from "./storage"

export interface StoreKitServiceConfig {
  apple: StoreKitEnv
  /** The D1 binding to persist into, e.g. `env.STOREKIT_DB`. */
  d1: StoreKitDatabase
  allowGracePeriodAccess?: boolean
  sandboxAllowed?: boolean
  /**
   * Re-read `Get All Subscription Statuses` when a notification arrives instead of projecting the
   * notification payload alone. Defaults to `true`; see `processStoreKitNotification`.
   */
  reconcileNotificationsWithApple?: boolean
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
  /** Whether the snapshot came from a fresh Apple status lookup rather than the payload alone. */
  reconciled: boolean
  verified: VerifiedStoreKitNotification
}

export interface StoreKitCurrentEntitlement {
  proActive: boolean
  productId: string | null
  expiresAt: string | null
  accessExpiresAt: string | null
  isTrial: boolean
  status: string
  environment: string
  autoRenewStatus: number | null
  autoRenewProductId: string | null
  appAccountToken: string | null
  resolvedAt: string
}

const ACTIVE_STOREKIT_STATUSES = new Set([
  "active_trial",
  "active_paid",
  "grace_period"
])

/**
 * Re-evaluate a stored projection at read time.
 *
 * Access is judged against `access_expires_at`, which already accounts for a billing grace period
 * extending past the subscription's own expiry; a perpetual (non-consumable) row has no deadline
 * at all and stays active until it is revoked.
 */
export function isStoreKitRecordActive(
  record: Pick<
    StoreKitSubscriptionRecord,
    "status" | "accessExpiresAt" | "perpetual"
  >,
  now: Date
): boolean {
  if (!ACTIVE_STOREKIT_STATUSES.has(record.status)) return false
  if (record.perpetual === true || record.perpetual === 1) return true
  if (!record.accessExpiresAt) return false
  const deadline = Date.parse(record.accessExpiresAt)
  return Number.isFinite(deadline) && deadline > now.getTime()
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

/**
 * Resolve the entitlement a notification implies.
 *
 * The notification payload is a point-in-time snapshot that Apple may deliver late, out of order,
 * or more than once, so by default the current state is re-read from `Get All Subscription
 * Statuses` and the payload is used only as a fallback when that lookup is unavailable. This is
 * also what lets a `REFUND` or `REVOKE` revoke access even though those payloads carry no
 * subscription `status` field — the revocation date on the signed transaction is enough.
 */
async function resolveNotificationSnapshot(
  verified: VerifiedStoreKitNotification,
  runtime: StoreKitRuntime,
  config: StoreKitServiceConfig
): Promise<{
  snapshot: StoreKitEntitlementSnapshot | null
  reconciled: boolean
}> {
  const transaction = verified.transaction
  if (!transaction) return { snapshot: null, reconciled: false }

  const allowGracePeriodAccess = config.allowGracePeriodAccess ?? true
  const originalTransactionId = transaction.originalTransactionId
  if (
    originalTransactionId &&
    config.reconcileNotificationsWithApple !== false
  ) {
    const state = await lookupStoreKitSubscriptionState(
      originalTransactionId,
      runtime
    )
    if (state.subscriptionTransactions.length > 0) {
      return {
        snapshot: resolveStoreKitEntitlement(
          {
            environment: verified.environment,
            transaction,
            statusResponse: state.statusResponse,
            latestSubscription: state.latestSubscription,
            subscriptionTransactions: state.subscriptionTransactions
          },
          config.now,
          allowGracePeriodAccess
        ),
        reconciled: true
      }
    }
  }

  return {
    snapshot: resolveStoreKitEntitlementCore(
      {
        environment: verified.environment,
        transaction,
        latestSubscriptionStatus: verified.latestSubscription?.status,
        latestRenewalInfo: verified.renewalInfo ?? undefined,
        subscriptionTransactions: [
          {
            status: verified.latestSubscription?.status,
            transaction,
            renewalInfo: verified.renewalInfo ?? undefined,
            source: "posted_jws"
          }
        ],
        verificationSource: "posted_jws"
      },
      config.now,
      allowGracePeriodAccess
    ),
    reconciled: false
  }
}

export async function processStoreKitNotification(
  signedPayload: string,
  config: StoreKitServiceConfig
): Promise<StoreKitNotificationProcessResult> {
  const { verified, runtime } = await verifyStoreKitNotificationForRuntime(
    signedPayload,
    config.apple
  )
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
    return {
      processed: true,
      replayed: true,
      snapshot: null,
      reconciled: false,
      verified
    }
  }

  const { snapshot, reconciled } = await resolveNotificationSnapshot(
    verified,
    runtime,
    config
  )

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
  return { processed: true, replayed: false, snapshot, reconciled, verified }
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
      accessExpiresAt: null,
      isTrial: false,
      status: "free",
      environment: readableEnvironments[0] ?? "Sandbox",
      autoRenewStatus: null,
      autoRenewProductId: null,
      appAccountToken: null,
      resolvedAt: resolvedAt.toISOString()
    }
  }
  return {
    proActive: isStoreKitRecordActive(record, resolvedAt),
    productId: record.productId,
    expiresAt: record.expiresAt,
    accessExpiresAt: record.accessExpiresAt,
    isTrial: record.isTrial === true || record.isTrial === 1,
    status: record.status,
    environment: record.environment,
    autoRenewStatus: record.autoRenewStatus,
    autoRenewProductId: record.autoRenewProductId,
    appAccountToken: record.appAccountToken,
    resolvedAt: resolvedAt.toISOString()
  }
}
