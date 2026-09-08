/**
 * D1 persistence adapter for StoreKit projections and notification replay state.
 *
 * This module intentionally contains no HTTP, session, or Apple SDK logic, and no dependency on
 * any host application helper: it needs nothing but a `D1Database` binding. Callers decide which
 * installation and environments are authorized; this adapter only persists verified projections.
 */
import type { StoreKitD1Database } from "./cloudflare.js"
import { StoreKitPersistenceError } from "./errors.js"
import type { StoreKitEntitlementSnapshot } from "./types.js"

export interface StoreKitSubscriptionRecord {
  originalTransactionId: string
  environment: string
  installationId: string | null
  appAccountToken: string | null
  inAppOwnershipType: string | null
  subscriptionGroupIdentifier: string | null
  latestTransactionId: string
  productId: string
  status: string
  expiresAt: string | null
  accessExpiresAt: string | null
  perpetual: boolean | number
  gracePeriodExpiresAt: string | null
  isTrial: boolean | number
  revocationDate: string | null
  revocationReason: number | null
  revocationType: string | null
  revocationPercentage: number | null
  isUpgraded: boolean | number
  productType: string | null
  offerDiscountType: string | null
  latestSignedDate: string | null
  autoRenewStatus: number | null
  autoRenewProductId: string | null
  expirationIntent: number | null
  isInBillingRetry: boolean | number | null
  priceIncreaseStatus: number | null
  renewalPrice: number | null
  currency: string | null
  lastVerifiedAt: string
}

/**
 * The adapter takes a `D1Database` directly rather than an env object, so it never assumes what
 * your binding is called. Pass `env.STOREKIT_DB`, `env.DB`, or whatever your Worker declares.
 */
export type StoreKitDatabase = StoreKitD1Database

function requireStoreKitDb(db: StoreKitDatabase | undefined, operation: string): StoreKitDatabase {
  if (!db) {
    throw new StoreKitPersistenceError("StoreKit D1 database is not bound.", operation, false)
  }
  return db
}

function isoNow(): string {
  return new Date().toISOString()
}

/**
 * D1 failures are surfaced as a single persistence error type rather than the driver's own, so
 * hosts translate one thing. The underlying message is preserved for logging but never carries
 * request data; bindings are not included.
 */
async function storeKitD1First<T>(
  db: StoreKitDatabase | undefined,
  statement: string,
  bindings: unknown[],
  operation: string
): Promise<T | null> {
  try {
    return (
      (await requireStoreKitDb(db, operation)
        .prepare(statement)
        .bind(...bindings)
        .first<T>()) ?? null
    )
  } catch (error) {
    if (error instanceof StoreKitPersistenceError) throw error
    throw new StoreKitPersistenceError(
      error instanceof Error ? error.message : "unknown_error",
      operation
    )
  }
}

async function storeKitD1All<T>(
  db: StoreKitDatabase | undefined,
  statement: string,
  bindings: unknown[],
  operation: string
): Promise<T[]> {
  try {
    const result = await requireStoreKitDb(db, operation)
      .prepare(statement)
      .bind(...bindings)
      .all<T>()
    return result.results ?? []
  } catch (error) {
    if (error instanceof StoreKitPersistenceError) throw error
    throw new StoreKitPersistenceError(
      error instanceof Error ? error.message : "unknown_error",
      operation
    )
  }
}

/**
 * Run statements as one D1 batch, which D1 executes as a single transaction. That atomicity is
 * what keeps a notification from being recorded as processed when its entitlement write fails.
 */
async function storeKitD1Batch(
  db: StoreKitDatabase | undefined,
  statements: { statement: string; bindings: unknown[] }[],
  operation: string
): Promise<void> {
  if (statements.length === 0) return
  const database = requireStoreKitDb(db, operation)
  try {
    await database.batch(
      statements.map((entry) => database.prepare(entry.statement).bind(...entry.bindings))
    )
  } catch (error) {
    if (error instanceof StoreKitPersistenceError) throw error
    throw new StoreKitPersistenceError(
      error instanceof Error ? error.message : "unknown_error",
      operation
    )
  }
}

/**
 * Apple delivers App Store Server Notifications V2 out of order and retries them for days, so a
 * delayed older event must never rewind newer entitlement state. Rows are therefore only updated
 * when the incoming Apple signing time is at least as recent as the stored one.
 *
 * Revocations bypass the guard: a refund is terminal and monotonic, so it must land even when it
 * is signed earlier than the state it supersedes.
 */
function monotonicWriteGuard(table: string): string {
  return `WHERE excluded.revocation_date IS NOT NULL
    OR COALESCE(excluded.latest_signed_date, '') >= COALESCE(${table}.latest_signed_date, '')`
}

const SUBSCRIPTION_COLUMNS = `original_transaction_id, environment, installation_id, app_account_token,
  in_app_ownership_type, subscription_group_identifier, latest_transaction_id, app_bundle_id, product_id, status, expires_at, access_expires_at,
  perpetual, grace_period_expires_at, is_trial, revocation_date, revocation_reason,
  revocation_type, revocation_percentage, is_upgraded, product_type,
  offer_discount_type, latest_signed_date, auto_renew_status, auto_renew_product_id,
  expiration_intent, is_in_billing_retry, price_increase_status, renewal_price, currency,
  last_verified_at, created_at, updated_at`

const TRANSACTION_COLUMNS = `transaction_id, environment, original_transaction_id, web_order_line_item_id,
  installation_id, app_account_token, in_app_ownership_type, subscription_group_identifier, app_bundle_id, product_id, purchase_date, expires_at,
  access_expires_at, perpetual, revocation_date, revocation_reason, revocation_type,
  revocation_percentage, status, pro_active, source, is_upgraded,
  product_type, offer_discount_type, latest_signed_date, first_seen_at, last_seen_at`

function placeholders(count: number): string {
  return new Array(count).fill("?").join(", ")
}

/**
 * How a write is allowed to change the account an entitlement is bound to.
 *
 * The default is sticky: the first account to sync a transaction keeps it, and a later sync by
 * anyone else leaves the binding alone. That rule lives in SQL rather than in a read-then-write
 * check so two concurrent syncs cannot both observe an unbound row and race to claim it.
 */
function installationBindingRule(table: string, allowAccountTransfer: boolean): string {
  return allowAccountTransfer
    ? `COALESCE(excluded.installation_id, ${table}.installation_id)`
    : `COALESCE(${table}.installation_id, excluded.installation_id)`
}

function subscriptionUpsertStatement(allowAccountTransfer: boolean): string {
  return `INSERT INTO storekit_subscriptions (${SUBSCRIPTION_COLUMNS})
    VALUES (${placeholders(33)})
    ON CONFLICT(original_transaction_id, environment) DO UPDATE SET
      installation_id = ${installationBindingRule("storekit_subscriptions", allowAccountTransfer)},
      app_account_token = COALESCE(excluded.app_account_token, storekit_subscriptions.app_account_token),
      in_app_ownership_type = COALESCE(excluded.in_app_ownership_type, storekit_subscriptions.in_app_ownership_type),
      subscription_group_identifier = COALESCE(excluded.subscription_group_identifier, storekit_subscriptions.subscription_group_identifier),
      latest_transaction_id = excluded.latest_transaction_id,
      app_bundle_id = excluded.app_bundle_id,
      product_id = excluded.product_id,
      status = excluded.status,
      expires_at = excluded.expires_at,
      access_expires_at = excluded.access_expires_at,
      perpetual = excluded.perpetual,
      grace_period_expires_at = excluded.grace_period_expires_at,
      is_trial = excluded.is_trial,
      revocation_date = excluded.revocation_date,
      revocation_reason = excluded.revocation_reason,
      revocation_type = excluded.revocation_type,
      revocation_percentage = excluded.revocation_percentage,
      is_upgraded = excluded.is_upgraded,
      product_type = COALESCE(excluded.product_type, storekit_subscriptions.product_type),
      offer_discount_type = COALESCE(excluded.offer_discount_type, storekit_subscriptions.offer_discount_type),
      latest_signed_date = COALESCE(excluded.latest_signed_date, storekit_subscriptions.latest_signed_date),
      auto_renew_status = COALESCE(excluded.auto_renew_status, storekit_subscriptions.auto_renew_status),
      auto_renew_product_id = COALESCE(excluded.auto_renew_product_id, storekit_subscriptions.auto_renew_product_id),
      expiration_intent = COALESCE(excluded.expiration_intent, storekit_subscriptions.expiration_intent),
      is_in_billing_retry = COALESCE(excluded.is_in_billing_retry, storekit_subscriptions.is_in_billing_retry),
      price_increase_status = COALESCE(excluded.price_increase_status, storekit_subscriptions.price_increase_status),
      renewal_price = COALESCE(excluded.renewal_price, storekit_subscriptions.renewal_price),
      currency = COALESCE(excluded.currency, storekit_subscriptions.currency),
      last_verified_at = excluded.last_verified_at,
      updated_at = excluded.updated_at
    ${monotonicWriteGuard("storekit_subscriptions")}`
}

function transactionUpsertStatement(allowAccountTransfer: boolean): string {
  return `INSERT INTO storekit_transactions (${TRANSACTION_COLUMNS})
    VALUES (${placeholders(27)})
    ON CONFLICT(transaction_id, environment) DO UPDATE SET
      original_transaction_id = excluded.original_transaction_id,
      web_order_line_item_id = COALESCE(excluded.web_order_line_item_id, storekit_transactions.web_order_line_item_id),
      installation_id = ${installationBindingRule("storekit_transactions", allowAccountTransfer)},
      app_account_token = COALESCE(excluded.app_account_token, storekit_transactions.app_account_token),
      in_app_ownership_type = COALESCE(excluded.in_app_ownership_type, storekit_transactions.in_app_ownership_type),
      subscription_group_identifier = COALESCE(excluded.subscription_group_identifier, storekit_transactions.subscription_group_identifier),
      app_bundle_id = excluded.app_bundle_id,
      product_id = excluded.product_id,
      purchase_date = COALESCE(excluded.purchase_date, storekit_transactions.purchase_date),
      expires_at = excluded.expires_at,
      access_expires_at = excluded.access_expires_at,
      perpetual = excluded.perpetual,
      revocation_date = excluded.revocation_date,
      revocation_reason = excluded.revocation_reason,
      revocation_type = excluded.revocation_type,
      revocation_percentage = excluded.revocation_percentage,
      status = excluded.status,
      pro_active = excluded.pro_active,
      source = excluded.source,
      is_upgraded = excluded.is_upgraded,
      product_type = COALESCE(excluded.product_type, storekit_transactions.product_type),
      offer_discount_type = COALESCE(excluded.offer_discount_type, storekit_transactions.offer_discount_type),
      latest_signed_date = COALESCE(excluded.latest_signed_date, storekit_transactions.latest_signed_date),
      last_seen_at = excluded.last_seen_at
    ${monotonicWriteGuard("storekit_transactions")}`
}

function subscriptionBindings(
  snapshot: StoreKitEntitlementSnapshot,
  installationId: string | null,
  appBundleId: string,
  nowIso: string
): unknown[] {
  return [
    snapshot.originalTransactionId,
    snapshot.environment,
    installationId,
    snapshot.appAccountToken,
    snapshot.inAppOwnershipType,
    snapshot.subscriptionGroupIdentifier,
    snapshot.latestTransactionId,
    appBundleId,
    snapshot.productId,
    snapshot.status,
    snapshot.expiresAt,
    snapshot.accessExpiresAt,
    snapshot.perpetual ? 1 : 0,
    snapshot.gracePeriodExpiresAt,
    snapshot.isTrial ? 1 : 0,
    snapshot.revocationDate,
    snapshot.revocationReason,
    snapshot.revocationType,
    snapshot.revocationPercentage,
    snapshot.isUpgraded ? 1 : 0,
    snapshot.productType,
    snapshot.offerDiscountType,
    snapshot.signedDate,
    snapshot.autoRenewStatus,
    snapshot.autoRenewProductId,
    snapshot.expirationIntent,
    snapshot.isInBillingRetryPeriod === null ? null : snapshot.isInBillingRetryPeriod ? 1 : 0,
    snapshot.priceIncreaseStatus,
    snapshot.renewalPrice,
    snapshot.currency,
    snapshot.resolvedAt,
    nowIso,
    nowIso
  ]
}

function transactionBindings(
  snapshot: StoreKitEntitlementSnapshot,
  installationId: string | null,
  appBundleId: string,
  nowIso: string
): unknown[] {
  return [
    snapshot.latestTransactionId,
    snapshot.environment,
    snapshot.originalTransactionId,
    snapshot.webOrderLineItemId,
    installationId,
    snapshot.appAccountToken,
    snapshot.inAppOwnershipType,
    snapshot.subscriptionGroupIdentifier,
    appBundleId,
    snapshot.productId,
    snapshot.purchaseDate,
    snapshot.expiresAt,
    snapshot.accessExpiresAt,
    snapshot.perpetual ? 1 : 0,
    snapshot.revocationDate,
    snapshot.revocationReason,
    snapshot.revocationType,
    snapshot.revocationPercentage,
    snapshot.status,
    snapshot.proActive ? 1 : 0,
    snapshot.source,
    snapshot.isUpgraded ? 1 : 0,
    snapshot.productType,
    snapshot.offerDiscountType,
    snapshot.signedDate,
    nowIso,
    snapshot.resolvedAt
  ]
}

function assertPersistableSnapshot(snapshot: StoreKitEntitlementSnapshot): void {
  if (!snapshot.originalTransactionId || !snapshot.latestTransactionId || !snapshot.productId) {
    throw new StoreKitPersistenceError(
      "StoreKit snapshot is missing the identity required to persist it.",
      "storekit_snapshot_validation",
      false
    )
  }
}

/**
 * Build the projection writes for a verified snapshot.
 *
 * Both statements are returned together so a caller can commit them in a single D1 batch with the
 * notification ledger insert, which is what keeps "notification recorded" and "entitlement
 * updated" from diverging.
 */
function snapshotProjectionStatements(
  snapshot: StoreKitEntitlementSnapshot,
  installationId: string | null,
  appBundleId: string,
  allowAccountTransfer: boolean
): { statement: string; bindings: unknown[] }[] {
  const nowIso = isoNow()
  return [
    {
      statement: transactionUpsertStatement(allowAccountTransfer),
      bindings: transactionBindings(snapshot, installationId, appBundleId, nowIso)
    },
    {
      statement: subscriptionUpsertStatement(allowAccountTransfer),
      bindings: subscriptionBindings(snapshot, installationId, appBundleId, nowIso)
    }
  ]
}

/**
 * The account a transaction's entitlement is currently bound to, or `null` when it is unbound.
 *
 * Callers use this to answer a conflicting sync with a clear error instead of a success response
 * describing an entitlement the caller does not own. The sticky binding rule in the upsert is what
 * actually protects the row; this read only decides what the caller is told.
 */
/**
 * The projection's read shape, shared by every query that returns a `StoreKitSubscriptionRecord`.
 *
 * Kept in one place so a column added to the table cannot reach one reader and miss another.
 */
/**
 * Best-entitlement-first ordering: currently-active rows, then production over sandbox, then
 * perpetual, then the longest remaining access. Takes the caller's clock as its one binding.
 *
 * Shared so the single-entitlement read and the per-group read cannot disagree about which row
 * wins.
 */
const SUBSCRIPTION_RANKING = `ORDER BY
      CASE
        WHEN status IN ('active_trial', 'active_paid', 'grace_period')
          AND (perpetual = 1 OR (access_expires_at IS NOT NULL AND access_expires_at > ?))
          THEN 0
        ELSE 1
      END,
      CASE WHEN environment = 'Production' THEN 0 ELSE 1 END,
      perpetual DESC,
      access_expires_at DESC,
      last_verified_at DESC,
      latest_transaction_id DESC`

const SUBSCRIPTION_RECORD_COLUMNS = `SELECT
      original_transaction_id AS originalTransactionId,
      environment,
      installation_id AS installationId,
      app_account_token AS appAccountToken,
      in_app_ownership_type AS inAppOwnershipType,
      subscription_group_identifier AS subscriptionGroupIdentifier,
      latest_transaction_id AS latestTransactionId,
      product_id AS productId,
      status,
      expires_at AS expiresAt,
      access_expires_at AS accessExpiresAt,
      perpetual,
      grace_period_expires_at AS gracePeriodExpiresAt,
      is_trial AS isTrial,
      revocation_date AS revocationDate,
      revocation_reason AS revocationReason,
      revocation_type AS revocationType,
      revocation_percentage AS revocationPercentage,
      is_upgraded AS isUpgraded,
      product_type AS productType,
      offer_discount_type AS offerDiscountType,
      latest_signed_date AS latestSignedDate,
      auto_renew_status AS autoRenewStatus,
      auto_renew_product_id AS autoRenewProductId,
      expiration_intent AS expirationIntent,
      is_in_billing_retry AS isInBillingRetry,
      price_increase_status AS priceIncreaseStatus,
      renewal_price AS renewalPrice,
      currency,
      last_verified_at AS lastVerifiedAt`

/** The stored projection for one transaction, regardless of which account it is bound to. */
export async function loadStoreKitSubscriptionByTransaction(
  originalTransactionId: string,
  environment: string,
  db: StoreKitDatabase | undefined
): Promise<StoreKitSubscriptionRecord | null> {
  return storeKitD1First<StoreKitSubscriptionRecord>(
    db,
    `${SUBSCRIPTION_RECORD_COLUMNS}
    FROM storekit_subscriptions
    WHERE original_transaction_id = ? AND environment = ?`,
    [originalTransactionId, environment],
    "storekit_subscription_select_by_transaction"
  )
}

export async function loadStoreKitSubscriptionOwner(
  originalTransactionId: string,
  environment: string,
  db: StoreKitDatabase | undefined
): Promise<string | null> {
  const row = await storeKitD1First<{ installationId: string | null }>(
    db,
    `SELECT installation_id AS installationId
    FROM storekit_subscriptions
    WHERE original_transaction_id = ? AND environment = ?`,
    [originalTransactionId, environment],
    "storekit_subscription_select_owner"
  )
  return row?.installationId ?? null
}

export async function loadStoreKitSubscriptionByInstallation(
  installationId: string,
  resolvedAt: Date,
  readableEnvironments: string[],
  db: StoreKitDatabase | undefined
): Promise<StoreKitSubscriptionRecord | null> {
  if (readableEnvironments.length === 0) return null
  const environmentPlaceholders = readableEnvironments.map(() => "?").join(", ")
  return storeKitD1First<StoreKitSubscriptionRecord>(
    db,
    `${SUBSCRIPTION_RECORD_COLUMNS}
    FROM storekit_subscriptions
    WHERE installation_id = ?
      AND environment IN (${environmentPlaceholders})
    ${SUBSCRIPTION_RANKING}
    LIMIT 1`,
    [installationId, ...readableEnvironments, resolvedAt.toISOString()],
    "storekit_subscription_select_by_installation"
  )
}

export interface StoreKitPersistOptions {
  /**
   * Let this write move an entitlement already bound to another account onto `installationId`.
   *
   * Off by default. See `StoreKitOwnershipConflictError`.
   */
  allowAccountTransfer?: boolean | undefined
}

/**
 * Every entitlement an account holds, one per subscription group.
 *
 * Apple allows at most one active subscription per group, so a group is the unit an entitlement is
 * resolved within: rows inside a group compete and the best one wins, while separate groups are
 * concurrent and all of them are returned. A non-subscription purchase has no group and is keyed
 * by product, so a lifetime unlock sits alongside a subscription rather than displacing it.
 */
export async function listStoreKitSubscriptionsByInstallation(
  installationId: string,
  resolvedAt: Date,
  readableEnvironments: string[],
  db: StoreKitDatabase | undefined
): Promise<StoreKitSubscriptionRecord[]> {
  if (readableEnvironments.length === 0) return []
  const environmentPlaceholders = readableEnvironments.map(() => "?").join(", ")
  const rows = await storeKitD1All<StoreKitSubscriptionRecord>(
    db,
    `${SUBSCRIPTION_RECORD_COLUMNS}
    FROM storekit_subscriptions
    WHERE installation_id = ?
      AND environment IN (${environmentPlaceholders})
    ${SUBSCRIPTION_RANKING}`,
    [installationId, ...readableEnvironments, resolvedAt.toISOString()],
    "storekit_subscription_list_by_installation"
  )

  // Rows arrive best-first, so the first one seen for a key is the winner for that key.
  const best = new Map<string, StoreKitSubscriptionRecord>()
  for (const row of rows) {
    const key = row.subscriptionGroupIdentifier ?? `product:${row.productId}`
    if (!best.has(key)) best.set(key, row)
  }
  return [...best.values()]
}

export async function persistStoreKitSubscriptionForInstallation(
  snapshot: StoreKitEntitlementSnapshot,
  installationId: string | null,
  appBundleId: string,
  db: StoreKitDatabase | undefined,
  options: StoreKitPersistOptions = {}
): Promise<void> {
  assertPersistableSnapshot(snapshot)
  await storeKitD1Batch(
    db,
    snapshotProjectionStatements(
      snapshot,
      installationId,
      appBundleId,
      options.allowAccountTransfer === true
    ),
    "storekit_subscription_and_transaction_upsert"
  )
}

export async function storeKitNotificationExists(
  notificationUuid: string,
  db: StoreKitDatabase | undefined
): Promise<boolean> {
  const row = await storeKitD1First<{ notificationUuid: string }>(
    db,
    `SELECT notification_uuid AS notificationUuid
    FROM storekit_notifications
    WHERE notification_uuid = ?`,
    [notificationUuid],
    "storekit_notification_select"
  )
  return Boolean(row)
}

export function storeKitNotificationStatement(
  notificationUuid: string,
  notificationType: string,
  subtype: string | null,
  environment: string,
  originalTransactionId: string | null,
  transactionId: string | null
): { statement: string; bindings: unknown[] } {
  const nowIso = isoNow()
  return {
    statement: `INSERT OR IGNORE INTO storekit_notifications (
      notification_uuid, notification_type, subtype, environment,
      original_transaction_id, transaction_id, processed_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    bindings: [
      notificationUuid,
      notificationType,
      subtype,
      environment,
      originalTransactionId,
      transactionId,
      nowIso,
      nowIso
    ]
  }
}

export async function persistStoreKitNotification(
  notification: {
    uuid: string
    type: string
    subtype: string | null
    environment: string
    originalTransactionId: string | null
    transactionId: string | null
  },
  snapshot: StoreKitEntitlementSnapshot | null,
  appBundleId: string,
  db: StoreKitDatabase | undefined
): Promise<void> {
  const notificationStatement = storeKitNotificationStatement(
    notification.uuid,
    notification.type,
    notification.subtype,
    notification.environment,
    notification.originalTransactionId,
    notification.transactionId
  )
  if (!snapshot) {
    await storeKitD1Batch(db, [notificationStatement], "storekit_notification_insert")
    return
  }
  assertPersistableSnapshot(snapshot)
  // Notifications never bind an entitlement to an installation; only an authenticated transaction
  // sync may do that. The upserts therefore pass a null installation id and COALESCE preserves
  // whatever binding a previous sync established.
  await storeKitD1Batch(
    db,
    [...snapshotProjectionStatements(snapshot, null, appBundleId, false), notificationStatement],
    "storekit_notification_and_subscription_upsert"
  )
}
