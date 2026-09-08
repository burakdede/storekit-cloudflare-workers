/**
 * Framework-neutral StoreKit service orchestration.
 *
 * Authentication, HTTP responses, logging, and environment policy belong to the caller. This
 * service combines Apple verification, entitlement policy, and the D1 adapter so a Worker can use
 * the module through one call per operation.
 */
import { resolveStoreKitEntitlementCore, type StoreKitEntitlementPolicy } from "./entitlement.js"
import { StoreKitOwnershipConflictError, StoreKitVerificationError } from "./errors.js"
import type { StoreKitEntitlementSnapshot, StoreKitEnv } from "./types.js"
import {
  lookupStoreKitSubscriptionState,
  resolveStoreKitEntitlement,
  verifyStoreKitNotificationForRuntime,
  verifyStoreKitTransaction,
  type StoreKitRuntime,
  type VerifiedStoreKitNotification,
  type VerifiedStoreKitTransaction
} from "./verification.js"
import {
  loadStoreKitSubscriptionByInstallation,
  loadStoreKitSubscriptionByTransaction,
  loadStoreKitSubscriptionOwner,
  persistStoreKitNotification,
  persistStoreKitSubscriptionForInstallation,
  storeKitNotificationExists,
  type StoreKitDatabase,
  type StoreKitSubscriptionRecord
} from "./storage.js"

export interface StoreKitServiceConfig {
  apple: StoreKitEnv
  /** The D1 binding to persist into, e.g. `env.STOREKIT_DB`. */
  d1: StoreKitDatabase
  allowGracePeriodAccess?: boolean
  /** Whether a `FAMILY_SHARED` purchase grants access. Defaults to `true`, Apple's intent. */
  allowFamilySharing?: boolean | undefined
  sandboxAllowed?: boolean
  /**
   * Re-read `Get All Subscription Statuses` when a notification arrives instead of projecting the
   * notification payload alone. Defaults to `true`; see `processStoreKitNotification`.
   */
  reconcileNotificationsWithApple?: boolean
  /**
   * Let a sync move an entitlement already bound to another account onto the calling account.
   *
   * Defaults to `false`, which refuses with `StoreKitOwnershipConflictError`. Enable it only
   * behind a deliberate, audited support flow; it is what lets one customer's signed transaction
   * take another customer's access away.
   */
  allowAccountTransfer?: boolean | undefined
  /** Called after a write that changed the entitlement. See `StoreKitEntitlementChangeHook`. */
  onEntitlementChange?: StoreKitEntitlementChangeHook | undefined
  /** Reports a hook that threw. The write already succeeded, so this never fails the request. */
  onEntitlementChangeError?: ((_error: unknown) => void) | undefined
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

const ACTIVE_STOREKIT_STATUSES = new Set(["active_trial", "active_paid", "grace_period"])

/* eslint-disable no-unused-vars -- Structural callback signature names its parameter only for typing. */

/**
 * What caused an entitlement to change.
 *
 * `previous` is the stored projection as it was before this write, or `null` when nothing was on
 * record. `next` is the snapshot just persisted.
 */
export interface StoreKitEntitlementChange {
  accountId: string | null
  previous: StoreKitSubscriptionRecord | null
  next: StoreKitEntitlementSnapshot
  /** Which of the significant fields differ. Never empty; the hook does not fire otherwise. */
  changed: StoreKitEntitlementChangeField[]
  source: "sync" | "notification"
  notification?: { uuid: string; type: string; subtype: string | null } | undefined
}

export type StoreKitEntitlementChangeField =
  | "proActive"
  | "status"
  | "productId"
  | "accessExpiresAt"
  | "autoRenewStatus"
  | "autoRenewProductId"
  | "revocationType"

/**
 * Called after a write that changed the entitlement.
 *
 * This is where a host mirrors the entitlement onto its own tables, sends the payment-failure push
 * that saves a subscription, or releases server-side resources on a refund. It never fires for an
 * idempotent re-sync or a replayed notification.
 */
export type StoreKitEntitlementChangeHook = (
  _change: StoreKitEntitlementChange
) => void | Promise<void>

/* eslint-enable no-unused-vars */

/**
 * The fields worth waking a host application for.
 *
 * Deliberately not every field: `resolvedAt` and `lastVerifiedAt` move on every write, and firing
 * on those would make the hook a write log rather than a change feed. `accessExpiresAt` is
 * included because that is what a renewal moves, and a renewal is a change a host cares about.
 */
const SIGNIFICANT_CHANGE_FIELDS: StoreKitEntitlementChangeField[] = [
  "proActive",
  "status",
  "productId",
  "accessExpiresAt",
  "autoRenewStatus",
  "autoRenewProductId",
  "revocationType"
]

function previousChangeValue(
  previous: StoreKitSubscriptionRecord,
  field: StoreKitEntitlementChangeField
): unknown {
  // The stored row spells booleans as 0/1, so `proActive` is recomputed rather than read.
  if (field === "proActive") return isStoreKitRecordActive(previous, new Date())
  return previous[field]
}

function storeKitEntitlementChangedFields(
  previous: StoreKitSubscriptionRecord | null,
  next: StoreKitEntitlementSnapshot
): StoreKitEntitlementChangeField[] {
  if (!previous) return [...SIGNIFICANT_CHANGE_FIELDS]
  return SIGNIFICANT_CHANGE_FIELDS.filter(
    (field) => previousChangeValue(previous, field) !== next[field]
  )
}

/** Collect the policy knobs a service config carries into the shape the kernel takes. */
function entitlementPolicy(
  config: Pick<StoreKitServiceConfig, "allowGracePeriodAccess" | "allowFamilySharing">
): StoreKitEntitlementPolicy {
  return {
    allowGracePeriodAccess: config.allowGracePeriodAccess ?? true,
    allowFamilySharing: config.allowFamilySharing ?? true
  }
}

/**
 * Re-evaluate a stored projection at read time.
 *
 * Access is judged against `access_expires_at`, which already accounts for a billing grace period
 * extending past the subscription's own expiry; a perpetual (non-consumable) row has no deadline
 * at all and stays active until it is revoked.
 */
export function isStoreKitRecordActive(
  record: Pick<StoreKitSubscriptionRecord, "status" | "accessExpiresAt" | "perpetual">,
  now: Date
): boolean {
  if (!ACTIVE_STOREKIT_STATUSES.has(record.status)) return false
  if (record.perpetual === true || record.perpetual === 1) return true
  if (!record.accessExpiresAt) return false
  const deadline = Date.parse(record.accessExpiresAt)
  return Number.isFinite(deadline) && deadline > now.getTime()
}

/**
 * Persist a snapshot and tell the host if the entitlement actually changed.
 *
 * The read of the previous state happens before the write, because a change feed cannot be
 * derived after the fact. A hook that throws is reported and swallowed: the write already
 * committed, and failing the response here would make Apple redeliver a notification that was in
 * fact processed, or make a customer's successful purchase look like a server error.
 */
async function persistAndAnnounce(
  snapshot: StoreKitEntitlementSnapshot,
  accountId: string | null,
  appBundleId: string,
  config: StoreKitServiceConfig,
  source: StoreKitEntitlementChange["source"],
  notification?: StoreKitEntitlementChange["notification"],
  persistOptions: { allowAccountTransfer?: boolean } = {}
): Promise<void> {
  const announcing = Boolean(config.onEntitlementChange && snapshot.originalTransactionId)
  const previous = announcing
    ? await loadStoreKitSubscriptionByTransaction(
        snapshot.originalTransactionId as string,
        snapshot.environment,
        config.d1
      )
    : null

  if (notification) {
    await persistStoreKitNotification(
      {
        uuid: notification.uuid,
        type: notification.type,
        subtype: notification.subtype,
        environment: snapshot.environment,
        originalTransactionId: snapshot.originalTransactionId,
        transactionId: snapshot.latestTransactionId
      },
      snapshot,
      appBundleId,
      config.d1
    )
  } else {
    await persistStoreKitSubscriptionForInstallation(
      snapshot,
      accountId,
      appBundleId,
      config.d1,
      persistOptions
    )
  }

  if (!announcing) return
  const changed = storeKitEntitlementChangedFields(previous, snapshot)
  if (changed.length === 0) return
  try {
    await config.onEntitlementChange?.({
      accountId: accountId ?? previous?.installationId ?? null,
      previous,
      next: snapshot,
      changed,
      source,
      notification
    })
  } catch (error) {
    config.onEntitlementChangeError?.(error)
  }
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

  const verified = await verifyStoreKitTransaction(input.signedTransactionJWS, config.apple)
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
  if (input.appAccountToken && input.appAccountToken !== verified.transaction.appAccountToken) {
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

  const snapshot = resolveStoreKitEntitlement(verified, config.now, entitlementPolicy(config))

  const allowAccountTransfer = config.allowAccountTransfer === true
  if (snapshot.originalTransactionId && input.installationId && !allowAccountTransfer) {
    // Refuse before writing, so the caller is never handed a snapshot describing an entitlement
    // that belongs to somebody else. The sticky binding rule in the upsert is the actual
    // protection; this read decides what the caller is told.
    const owner = await loadStoreKitSubscriptionOwner(
      snapshot.originalTransactionId,
      snapshot.environment,
      config.d1
    )
    if (owner && owner !== input.installationId) {
      throw new StoreKitOwnershipConflictError(snapshot.originalTransactionId, snapshot.environment)
    }
  }

  await persistAndAnnounce(
    snapshot,
    input.installationId,
    input.appBundleId,
    config,
    "sync",
    undefined,
    { allowAccountTransfer }
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
 * subscription `status` field; the revocation date on the signed transaction is enough.
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

  const policy = entitlementPolicy(config)
  const originalTransactionId = transaction.originalTransactionId
  if (originalTransactionId && config.reconcileNotificationsWithApple !== false) {
    const state = await lookupStoreKitSubscriptionState(originalTransactionId, runtime)
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
          policy
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
      policy
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

  const { snapshot, reconciled } = await resolveNotificationSnapshot(verified, runtime, config)

  const appBundleId = config.apple.STOREKIT_BUNDLE_ID ?? verified.transaction?.bundleId ?? ""
  const notification = {
    uuid: notificationUuid,
    type: notificationType,
    subtype: verified.notification.subtype ?? null
  }

  if (snapshot) {
    await persistAndAnnounce(snapshot, null, appBundleId, config, "notification", notification)
  } else {
    // Nothing to project: a summary or transaction-less notification. Only the replay ledger
    // entry is written, and there is no entitlement change to announce.
    await persistStoreKitNotification(
      {
        ...notification,
        environment: verified.environment,
        originalTransactionId: null,
        transactionId: null
      },
      null,
      appBundleId,
      config.d1
    )
  }
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
