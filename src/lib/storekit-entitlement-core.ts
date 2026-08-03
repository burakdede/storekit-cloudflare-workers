/**
 * Pure StoreKit entitlement policy.
 *
 * This file intentionally has no Cloudflare, Apple SDK, database, or HTTP dependency. It is the
 * reusable policy kernel that can be copied into another Worker or tested with plain objects.
 */

import type {
  StoreKitEntitlementSnapshot,
  StoreKitEntitlementStatus,
  StoreKitEnvironment
} from "../storekit"

export interface StoreKitEntitlementTransaction {
  transactionId?: string
  originalTransactionId?: string
  productId?: string
  environment?: string
  expiresDate?: number
  purchaseDate?: number
  revocationDate?: number
  webOrderLineItemId?: string
  appAccountToken?: string
  offerType?: number
}

export interface StoreKitEntitlementCandidate {
  status: number | undefined
  transaction: StoreKitEntitlementTransaction
  source: StoreKitEntitlementSnapshot["source"]
}

export interface StoreKitEntitlementInput {
  environment: StoreKitEnvironment
  transaction: StoreKitEntitlementTransaction
  latestSubscriptionStatus: number | undefined
  subscriptionTransactions: StoreKitEntitlementCandidate[]
  verificationSource: "posted_jws" | "apple_transaction_lookup"
}

const STATUS = {
  ACTIVE: 1,
  EXPIRED: 2,
  BILLING_RETRY: 3,
  BILLING_GRACE_PERIOD: 4,
  REVOKED: 5
} as const

const INTRODUCTORY_OFFER = 1

function isoFromAppleMillis(value: number | undefined): string | null {
  if (!Number.isFinite(value)) return null
  return new Date(Number(value)).toISOString()
}

function isFutureAppleMillis(value: number | undefined, now: Date): boolean {
  return Number.isFinite(value) && Number(value) > now.getTime()
}

function isValidEntitlementProduct(
  transaction: StoreKitEntitlementTransaction
): boolean {
  return Boolean(
    transaction.productId &&
    transaction.originalTransactionId &&
    transaction.transactionId
  )
}

function transactionMillis(value: number | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0
}

function isCandidateActive(
  transaction: StoreKitEntitlementTransaction,
  status: number | undefined,
  now: Date,
  allowGracePeriodAccess: boolean
): boolean {
  if (!isValidEntitlementProduct(transaction)) return false
  if (transaction.revocationDate) return false
  if (!isFutureAppleMillis(transaction.expiresDate, now)) return false
  if (status === STATUS.EXPIRED || status === STATUS.REVOKED) return false
  if (status === STATUS.BILLING_RETRY) return false
  if (status === STATUS.BILLING_GRACE_PERIOD) return allowGracePeriodAccess
  return status === undefined || status === STATUS.ACTIVE
}

function compareTransactions(
  left: StoreKitEntitlementTransaction,
  right: StoreKitEntitlementTransaction
): number {
  return (
    transactionMillis(right.expiresDate) -
      transactionMillis(left.expiresDate) ||
    transactionMillis(right.purchaseDate) -
      transactionMillis(left.purchaseDate) ||
    String(right.transactionId ?? "").localeCompare(
      String(left.transactionId ?? "")
    )
  )
}

function baseSnapshot(
  transaction: StoreKitEntitlementTransaction,
  environment: StoreKitEnvironment,
  status: StoreKitEntitlementStatus,
  proActive: boolean,
  source: StoreKitEntitlementSnapshot["source"],
  now: Date
): StoreKitEntitlementSnapshot {
  return {
    proActive,
    productId: transaction.productId ?? null,
    expiresAt: isoFromAppleMillis(transaction.expiresDate),
    isTrial: status === "active_trial",
    status,
    environment,
    originalTransactionId: transaction.originalTransactionId ?? null,
    latestTransactionId: transaction.transactionId ?? null,
    webOrderLineItemId: transaction.webOrderLineItemId ?? null,
    purchaseDate: isoFromAppleMillis(transaction.purchaseDate),
    revocationDate: isoFromAppleMillis(transaction.revocationDate),
    appAccountToken: transaction.appAccountToken ?? null,
    source,
    resolvedAt: now.toISOString()
  }
}

function activeStatus(
  transaction: StoreKitEntitlementTransaction
): "active_trial" | "active_paid" {
  return transaction.offerType === INTRODUCTORY_OFFER
    ? "active_trial"
    : "active_paid"
}

/** Resolve a verified transaction set without performing I/O or trusting client state. */
export function resolveStoreKitEntitlementCore(
  input: StoreKitEntitlementInput,
  now = new Date(),
  allowGracePeriodAccess = true
): StoreKitEntitlementSnapshot {
  const submittedSource =
    input.verificationSource === "apple_transaction_lookup"
      ? "apple_transaction_lookup"
      : "posted_jws"
  const candidates = [
    ...input.subscriptionTransactions,
    ...(input.subscriptionTransactions.length === 0
      ? [
          {
            status: input.latestSubscriptionStatus,
            transaction: input.transaction,
            source: submittedSource as StoreKitEntitlementSnapshot["source"]
          }
        ]
      : [])
  ].sort((left, right) => {
    const leftActive = isCandidateActive(
      left.transaction,
      left.status,
      now,
      allowGracePeriodAccess
    )
    const rightActive = isCandidateActive(
      right.transaction,
      right.status,
      now,
      allowGracePeriodAccess
    )
    if (leftActive !== rightActive) return leftActive ? -1 : 1
    return compareTransactions(left.transaction, right.transaction)
  })

  const candidate = candidates[0] ?? {
    status: input.latestSubscriptionStatus,
    transaction: input.transaction,
    source: submittedSource as StoreKitEntitlementSnapshot["source"]
  }
  const transaction = candidate.transaction
  const status = candidate.status

  if (transaction.revocationDate) {
    return baseSnapshot(
      transaction,
      input.environment,
      "refunded",
      false,
      candidate.source,
      now
    )
  }
  if (!isValidEntitlementProduct(transaction)) {
    return baseSnapshot(
      transaction,
      input.environment,
      "unknown",
      false,
      candidate.source,
      now
    )
  }
  if (status === STATUS.REVOKED) {
    return baseSnapshot(
      transaction,
      input.environment,
      "revoked",
      false,
      candidate.source,
      now
    )
  }
  if (
    status === STATUS.EXPIRED ||
    !isFutureAppleMillis(transaction.expiresDate, now)
  ) {
    return baseSnapshot(
      transaction,
      input.environment,
      "expired",
      false,
      candidate.source,
      now
    )
  }
  if (status === undefined || status === STATUS.ACTIVE) {
    return baseSnapshot(
      transaction,
      input.environment,
      activeStatus(transaction),
      true,
      candidate.source,
      now
    )
  }
  if (status === STATUS.BILLING_GRACE_PERIOD) {
    return baseSnapshot(
      transaction,
      input.environment,
      "grace_period",
      allowGracePeriodAccess,
      candidate.source,
      now
    )
  }
  if (status === STATUS.BILLING_RETRY) {
    return baseSnapshot(
      transaction,
      input.environment,
      "billing_retry",
      false,
      candidate.source,
      now
    )
  }
  return baseSnapshot(
    transaction,
    input.environment,
    "unknown",
    false,
    candidate.source,
    now
  )
}
