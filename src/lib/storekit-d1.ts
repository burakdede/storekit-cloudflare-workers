/**
 * Cloudflare D1 persistence adapter.
 *
 * This is deliberately limited to the StoreKit tables. Authentication, HTTP, logging policy,
 * and Apple verification stay outside this file so consumers can compose their own Worker.
 */
import type { StoreKitEntitlementSnapshot } from "../storekit"

export interface StoreKitD1Env {
  STOREKIT_DB?: D1Database
}

export interface StoreKitSubscriptionRecord {
  originalTransactionId: string
  environment: string
  installationId: string | null
  appAccountToken: string | null
  latestTransactionId: string
  productId: string
  status: string
  expiresAt: string | null
  isTrial: boolean | number
  revocationDate: string | null
  lastVerifiedAt: string
}

export class StoreKitPersistenceError extends Error {
  readonly operation: string

  constructor(operation: string, cause: unknown) {
    super(`StoreKit D1 operation failed: ${operation}`)
    this.name = "StoreKitPersistenceError"
    this.operation = operation
    this.cause = cause
  }
}

function database(env: StoreKitD1Env): D1Database {
  if (!env.STOREKIT_DB)
    throw new StoreKitPersistenceError(
      "binding",
      new Error("STOREKIT_DB is not bound")
    )
  return env.STOREKIT_DB
}

async function first<T>(
  env: StoreKitD1Env,
  sql: string,
  bindings: unknown[],
  operation: string
): Promise<T | null> {
  try {
    return await database(env)
      .prepare(sql)
      .bind(...bindings)
      .first<T>()
  } catch (cause) {
    throw new StoreKitPersistenceError(operation, cause)
  }
}

async function batch(
  env: StoreKitD1Env,
  statements: D1PreparedStatement[],
  operation: string
): Promise<void> {
  try {
    await database(env).batch(statements)
  } catch (cause) {
    throw new StoreKitPersistenceError(operation, cause)
  }
}

function prepared(
  env: StoreKitD1Env,
  sql: string,
  bindings: unknown[]
): D1PreparedStatement {
  return database(env)
    .prepare(sql)
    .bind(...bindings)
}

export async function loadStoreKitSubscriptionByInstallation(
  installationId: string,
  resolvedAt: Date,
  readableEnvironments: string[],
  env: StoreKitD1Env
): Promise<StoreKitSubscriptionRecord | null> {
  if (readableEnvironments.length === 0) return null
  const placeholders = readableEnvironments.map(() => "?").join(", ")
  return first<StoreKitSubscriptionRecord>(
    env,
    `SELECT
    original_transaction_id AS originalTransactionId,
    environment,
    installation_id AS installationId,
    app_account_token AS appAccountToken,
    latest_transaction_id AS latestTransactionId,
    product_id AS productId,
    status,
    expires_at AS expiresAt,
    is_trial AS isTrial,
    revocation_date AS revocationDate,
    last_verified_at AS lastVerifiedAt
  FROM storekit_subscriptions
  WHERE installation_id = ? AND environment IN (${placeholders})
  ORDER BY CASE WHEN status IN ('active_trial','active_paid','grace_period')
    AND expires_at IS NOT NULL AND expires_at > ? THEN 0 ELSE 1 END,
    CASE WHEN environment = 'Production' THEN 0 ELSE 1 END,
    expires_at DESC, last_verified_at DESC, latest_transaction_id DESC
  LIMIT 1`,
    [installationId, ...readableEnvironments, resolvedAt.toISOString()],
    "subscription_read"
  )
}

function projectionStatements(
  snapshot: StoreKitEntitlementSnapshot,
  installationId: string | null,
  appBundleId: string,
  nowIso: string,
  includeInstallationUpdate: boolean,
  env: StoreKitD1Env
): D1PreparedStatement[] {
  const transactionUpdate = includeInstallationUpdate
    ? `installation_id = COALESCE(excluded.installation_id, storekit_transactions.installation_id),`
    : `installation_id = storekit_transactions.installation_id,`
  const subscriptionUpdate = includeInstallationUpdate
    ? `installation_id = COALESCE(excluded.installation_id, storekit_subscriptions.installation_id),`
    : `installation_id = storekit_subscriptions.installation_id,`
  return [
    prepared(
      env,
      `INSERT INTO storekit_transactions (
      transaction_id, environment, original_transaction_id, web_order_line_item_id,
      installation_id, app_account_token, app_bundle_id, product_id, purchase_date,
      expires_at, revocation_date, status, pro_active, source, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(transaction_id, environment) DO UPDATE SET
      original_transaction_id=excluded.original_transaction_id,
      web_order_line_item_id=COALESCE(excluded.web_order_line_item_id,storekit_transactions.web_order_line_item_id),
      ${transactionUpdate}
      app_account_token=COALESCE(excluded.app_account_token,storekit_transactions.app_account_token),
      app_bundle_id=excluded.app_bundle_id, product_id=excluded.product_id,
      purchase_date=COALESCE(excluded.purchase_date,storekit_transactions.purchase_date),
      expires_at=excluded.expires_at, revocation_date=excluded.revocation_date,
      status=excluded.status, pro_active=excluded.pro_active,
      source=excluded.source, last_seen_at=excluded.last_seen_at`,
      [
        snapshot.latestTransactionId,
        snapshot.environment,
        snapshot.originalTransactionId,
        snapshot.webOrderLineItemId,
        installationId,
        snapshot.appAccountToken,
        appBundleId,
        snapshot.productId,
        snapshot.purchaseDate,
        snapshot.expiresAt,
        snapshot.revocationDate,
        snapshot.status,
        snapshot.proActive ? 1 : 0,
        snapshot.source,
        nowIso,
        snapshot.resolvedAt
      ]
    ),
    prepared(
      env,
      `INSERT INTO storekit_subscriptions (
      original_transaction_id, environment, installation_id, app_account_token,
      latest_transaction_id, app_bundle_id, product_id, status, expires_at, is_trial,
      revocation_date, last_verified_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(original_transaction_id, environment) DO UPDATE SET
      ${subscriptionUpdate}
      app_account_token=COALESCE(excluded.app_account_token,storekit_subscriptions.app_account_token),
      latest_transaction_id=excluded.latest_transaction_id, app_bundle_id=excluded.app_bundle_id,
      product_id=excluded.product_id, status=excluded.status, expires_at=excluded.expires_at,
      is_trial=excluded.is_trial, revocation_date=excluded.revocation_date,
      last_verified_at=excluded.last_verified_at, updated_at=excluded.updated_at`,
      [
        snapshot.originalTransactionId,
        snapshot.environment,
        installationId,
        snapshot.appAccountToken,
        snapshot.latestTransactionId,
        appBundleId,
        snapshot.productId,
        snapshot.status,
        snapshot.expiresAt,
        snapshot.isTrial ? 1 : 0,
        snapshot.revocationDate,
        snapshot.resolvedAt,
        nowIso,
        nowIso
      ]
    )
  ]
}

function assertSnapshot(snapshot: StoreKitEntitlementSnapshot): void {
  if (
    !snapshot.originalTransactionId ||
    !snapshot.latestTransactionId ||
    !snapshot.productId
  ) {
    throw new StoreKitPersistenceError(
      "projection_validation",
      new Error("verified transaction identity is incomplete")
    )
  }
}

export async function persistStoreKitSubscriptionForInstallation(
  snapshot: StoreKitEntitlementSnapshot,
  installationId: string | null,
  appBundleId: string,
  env: StoreKitD1Env
): Promise<void> {
  assertSnapshot(snapshot)
  const nowIso = new Date().toISOString()
  try {
    const statements = projectionStatements(
      snapshot,
      installationId,
      appBundleId,
      nowIso,
      true,
      env
    )
    await batch(env, statements, "subscription_projection")
  } catch (error) {
    if (error instanceof StoreKitPersistenceError) throw error
    throw new StoreKitPersistenceError("subscription_projection", error)
  }
}

export async function storeKitNotificationExists(
  notificationUuid: string,
  env: StoreKitD1Env
): Promise<boolean> {
  const row = await first<{ notificationUuid: string }>(
    env,
    `SELECT notification_uuid AS notificationUuid
    FROM storekit_notifications WHERE notification_uuid = ?`,
    [notificationUuid],
    "notification_lookup"
  )
  return row !== null
}

export function storeKitNotificationStatement(
  notificationUuid: string,
  notificationType: string,
  subtype: string | null,
  environment: string,
  originalTransactionId: string | null,
  transactionId: string | null
): { statement: string; bindings: unknown[] } {
  const nowIso = new Date().toISOString()
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
  env: StoreKitD1Env
): Promise<void> {
  const notificationSql = storeKitNotificationStatement(
    notification.uuid,
    notification.type,
    notification.subtype,
    notification.environment,
    notification.originalTransactionId,
    notification.transactionId
  )
  const statements = [
    prepared(env, notificationSql.statement, notificationSql.bindings)
  ]
  if (snapshot) {
    assertSnapshot(snapshot)
    statements.push(
      ...projectionStatements(
        snapshot,
        null,
        appBundleId,
        new Date().toISOString(),
        false,
        env
      )
    )
  }
  await batch(env, statements, "notification_projection")
}
