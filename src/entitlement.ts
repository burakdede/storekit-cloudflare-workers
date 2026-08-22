/**
 * Pure StoreKit entitlement policy.
 *
 * This file intentionally has no Cloudflare, Apple SDK, database, or HTTP dependency. It is the
 * reusable policy kernel that can be copied into another Worker or tested with plain objects.
 */

import {
  STOREKIT_STATUS as STATUS,
  type StoreKitEntitlementSnapshot,
  type StoreKitEntitlementSource,
  type StoreKitEntitlementStatus,
  type StoreKitEnvironment
} from "./types.js"

/**
 * The subset of Apple's `JWSTransactionDecodedPayload` the policy reads. Kept structural so the
 * kernel can be exercised with plain objects and stays decoupled from the Apple SDK types.
 */
export interface StoreKitEntitlementTransaction {
  transactionId?: string | undefined
  originalTransactionId?: string | undefined
  productId?: string | undefined
  environment?: string | undefined
  expiresDate?: number | undefined
  purchaseDate?: number | undefined
  revocationDate?: number | undefined
  revocationReason?: number | undefined
  webOrderLineItemId?: string | undefined
  appAccountToken?: string | undefined
  offerType?: number | undefined
  offerDiscountType?: string | undefined
  signedDate?: number | undefined
  type?: string | undefined
}

/**
 * The subset of Apple's `JWSRenewalInfoDecodedPayload` the policy reads.
 *
 * `gracePeriodExpiresDate` is what makes billing-grace-period entitlement correct: once a renewal
 * fails, the transaction's own `expiresDate` is already in the past while Apple still reports
 * status 4 and the customer still deserves access.
 */
export interface StoreKitEntitlementRenewalInfo {
  autoRenewStatus?: number | undefined
  autoRenewProductId?: string | undefined
  expirationIntent?: number | undefined
  isInBillingRetryPeriod?: boolean | undefined
  gracePeriodExpiresDate?: number | undefined
  priceIncreaseStatus?: number | undefined
  renewalPrice?: number | undefined
  currency?: string | undefined
  offerDiscountType?: string | undefined
  signedDate?: number | undefined
}

export interface StoreKitEntitlementCandidate {
  status: number | undefined
  transaction: StoreKitEntitlementTransaction
  renewalInfo?: StoreKitEntitlementRenewalInfo | undefined
  source: StoreKitEntitlementSource
}

export interface StoreKitEntitlementInput {
  environment: StoreKitEnvironment
  transaction: StoreKitEntitlementTransaction
  latestSubscriptionStatus: number | undefined
  latestRenewalInfo?: StoreKitEntitlementRenewalInfo | undefined
  subscriptionTransactions: StoreKitEntitlementCandidate[]
  verificationSource: "posted_jws" | "apple_transaction_lookup"
}

const INTRODUCTORY_OFFER = 1
const FREE_TRIAL = "FREE_TRIAL"
const NON_CONSUMABLE = "Non-Consumable"

function isoFromAppleMillis(value: number | undefined): string | null {
  if (!Number.isFinite(value)) return null
  return new Date(Number(value)).toISOString()
}

function isFutureAppleMillis(value: number | undefined, now: Date): boolean {
  return Number.isFinite(value) && Number(value) > now.getTime()
}

function isValidEntitlementProduct(transaction: StoreKitEntitlementTransaction): boolean {
  return Boolean(
    transaction.productId && transaction.originalTransactionId && transaction.transactionId
  )
}

function transactionMillis(value: number | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0
}

/**
 * A non-consumable purchase never expires, so Apple omits `expiresDate` entirely. Treating a
 * missing expiry as "expired" would revoke every lifetime unlock.
 */
function isPerpetualPurchase(transaction: StoreKitEntitlementTransaction): boolean {
  return transaction.type === NON_CONSUMABLE && !Number.isFinite(transaction.expiresDate)
}

/**
 * The instant access actually lapses, which is not always the transaction's `expiresDate`.
 *
 * Returns `undefined` for perpetual purchases (access never lapses). During a billing grace
 * period Apple keeps serving the customer until `gracePeriodExpiresDate`, which is later than the
 * already-elapsed `expiresDate`.
 */
function accessDeadlineMillis(
  transaction: StoreKitEntitlementTransaction,
  status: number | undefined,
  renewalInfo: StoreKitEntitlementRenewalInfo | undefined
): number | undefined {
  if (isPerpetualPurchase(transaction)) return undefined
  const expiresDate = transactionMillis(transaction.expiresDate)
  if (status !== STATUS.BILLING_GRACE_PERIOD) return expiresDate
  const graceDeadline = renewalInfo?.gracePeriodExpiresDate
  if (!Number.isFinite(graceDeadline)) return expiresDate
  return Math.max(expiresDate, Number(graceDeadline))
}

/**
 * Whether a billing grace period still grants access.
 *
 * Apple only reports status 4 while the grace period is running, so a missing
 * `gracePeriodExpiresDate` (the app has grace periods enabled but the renewal info was not
 * available) is trusted rather than treated as lapsed.
 */
function isWithinGracePeriod(
  renewalInfo: StoreKitEntitlementRenewalInfo | undefined,
  now: Date
): boolean {
  const graceDeadline = renewalInfo?.gracePeriodExpiresDate
  if (!Number.isFinite(graceDeadline)) return true
  return isFutureAppleMillis(graceDeadline, now)
}

function hasAccessWindow(
  transaction: StoreKitEntitlementTransaction,
  status: number | undefined,
  renewalInfo: StoreKitEntitlementRenewalInfo | undefined,
  now: Date
): boolean {
  const deadline = accessDeadlineMillis(transaction, status, renewalInfo)
  if (deadline === undefined) return true
  return isFutureAppleMillis(deadline, now)
}

function isCandidateActive(
  candidate: StoreKitEntitlementCandidate,
  now: Date,
  allowGracePeriodAccess: boolean
): boolean {
  const { transaction, status, renewalInfo } = candidate
  if (!isValidEntitlementProduct(transaction)) return false
  if (transaction.revocationDate) return false
  if (status === STATUS.EXPIRED || status === STATUS.REVOKED) return false
  if (status === STATUS.BILLING_RETRY) return false
  if (status === STATUS.BILLING_GRACE_PERIOD) {
    return allowGracePeriodAccess && isWithinGracePeriod(renewalInfo, now)
  }
  if (status !== undefined && status !== STATUS.ACTIVE) return false
  return hasAccessWindow(transaction, status, renewalInfo, now)
}

/** Sort key for picking the longest-lived candidate; perpetual purchases outrank every expiry. */
function candidateDeadlineRank(candidate: StoreKitEntitlementCandidate): number {
  const deadline = accessDeadlineMillis(
    candidate.transaction,
    candidate.status,
    candidate.renewalInfo
  )
  return deadline === undefined ? Number.POSITIVE_INFINITY : deadline
}

function compareCandidates(
  left: StoreKitEntitlementCandidate,
  right: StoreKitEntitlementCandidate
): number {
  const deadlineDelta = candidateDeadlineRank(right) - candidateDeadlineRank(left)
  if (deadlineDelta !== 0 && Number.isFinite(deadlineDelta)) return deadlineDelta
  if (deadlineDelta !== 0) return deadlineDelta > 0 ? 1 : -1
  return (
    transactionMillis(right.transaction.purchaseDate) -
      transactionMillis(left.transaction.purchaseDate) ||
    String(right.transaction.transactionId ?? "").localeCompare(
      String(left.transaction.transactionId ?? "")
    )
  )
}

/**
 * `offerType === 1` covers every introductory offer, including pay-up-front and pay-as-you-go
 * ones that are not free. `offerDiscountType` is the field that actually distinguishes a trial;
 * the `offerType` check remains as a fallback for transactions signed before Apple added it.
 */
function isFreeTrialTransaction(transaction: StoreKitEntitlementTransaction): boolean {
  if (transaction.offerDiscountType) return transaction.offerDiscountType === FREE_TRIAL
  return transaction.offerType === INTRODUCTORY_OFFER
}

function activeStatus(transaction: StoreKitEntitlementTransaction): "active_trial" | "active_paid" {
  return isFreeTrialTransaction(transaction) ? "active_trial" : "active_paid"
}

function baseSnapshot(
  candidate: StoreKitEntitlementCandidate,
  environment: StoreKitEnvironment,
  status: StoreKitEntitlementStatus,
  proActive: boolean,
  now: Date
): StoreKitEntitlementSnapshot {
  const { transaction, renewalInfo } = candidate
  const accessDeadline = accessDeadlineMillis(transaction, candidate.status, renewalInfo)
  return {
    proActive,
    productId: transaction.productId ?? null,
    expiresAt: isoFromAppleMillis(transaction.expiresDate),
    accessExpiresAt: accessDeadline === undefined ? null : isoFromAppleMillis(accessDeadline),
    perpetual: isPerpetualPurchase(transaction),
    gracePeriodExpiresAt: isoFromAppleMillis(renewalInfo?.gracePeriodExpiresDate),
    isTrial: status === "active_trial",
    status,
    environment,
    originalTransactionId: transaction.originalTransactionId ?? null,
    latestTransactionId: transaction.transactionId ?? null,
    webOrderLineItemId: transaction.webOrderLineItemId ?? null,
    purchaseDate: isoFromAppleMillis(transaction.purchaseDate),
    revocationDate: isoFromAppleMillis(transaction.revocationDate),
    revocationReason: transaction.revocationReason ?? null,
    appAccountToken: transaction.appAccountToken ?? null,
    productType: transaction.type ?? null,
    offerDiscountType: transaction.offerDiscountType ?? null,
    signedDate: isoFromAppleMillis(transaction.signedDate ?? renewalInfo?.signedDate),
    autoRenewStatus: renewalInfo?.autoRenewStatus ?? null,
    autoRenewProductId: renewalInfo?.autoRenewProductId ?? null,
    expirationIntent: renewalInfo?.expirationIntent ?? null,
    isInBillingRetryPeriod: renewalInfo?.isInBillingRetryPeriod ?? null,
    priceIncreaseStatus: renewalInfo?.priceIncreaseStatus ?? null,
    renewalPrice: renewalInfo?.renewalPrice ?? null,
    currency: renewalInfo?.currency ?? null,
    source: candidate.source,
    resolvedAt: now.toISOString()
  }
}

/** Resolve a verified transaction set without performing I/O or trusting client state. */
export function resolveStoreKitEntitlementCore(
  input: StoreKitEntitlementInput,
  now = new Date(),
  allowGracePeriodAccess = true
): StoreKitEntitlementSnapshot {
  const submittedSource: StoreKitEntitlementSource =
    input.verificationSource === "apple_transaction_lookup"
      ? "apple_transaction_lookup"
      : "posted_jws"
  const submittedCandidate: StoreKitEntitlementCandidate = {
    status: input.latestSubscriptionStatus,
    transaction: input.transaction,
    renewalInfo: input.latestRenewalInfo,
    source: submittedSource
  }
  const candidates = (
    input.subscriptionTransactions.length > 0
      ? [...input.subscriptionTransactions]
      : [submittedCandidate]
  ).sort((left, right) => {
    const leftActive = isCandidateActive(left, now, allowGracePeriodAccess)
    const rightActive = isCandidateActive(right, now, allowGracePeriodAccess)
    if (leftActive !== rightActive) return leftActive ? -1 : 1
    return compareCandidates(left, right)
  })

  const candidate = candidates[0] ?? submittedCandidate
  const { transaction, status, renewalInfo } = candidate

  if (transaction.revocationDate) {
    return baseSnapshot(candidate, input.environment, "refunded", false, now)
  }
  if (!isValidEntitlementProduct(transaction)) {
    return baseSnapshot(candidate, input.environment, "unknown", false, now)
  }
  if (status === STATUS.REVOKED) {
    return baseSnapshot(candidate, input.environment, "revoked", false, now)
  }
  // Grace period and billing retry are resolved before the expiry check on purpose: in both
  // states the transaction's own expiresDate has already elapsed, so an expiry-first order would
  // report every grace-period customer as "expired" and revoke paid access.
  if (status === STATUS.BILLING_GRACE_PERIOD) {
    const withinGrace = isWithinGracePeriod(renewalInfo, now)
    if (!withinGrace) {
      return baseSnapshot(candidate, input.environment, "expired", false, now)
    }
    return baseSnapshot(candidate, input.environment, "grace_period", allowGracePeriodAccess, now)
  }
  if (status === STATUS.BILLING_RETRY) {
    return baseSnapshot(candidate, input.environment, "billing_retry", false, now)
  }
  if (status === STATUS.EXPIRED) {
    return baseSnapshot(candidate, input.environment, "expired", false, now)
  }
  if (status === undefined || status === STATUS.ACTIVE) {
    if (!hasAccessWindow(transaction, status, renewalInfo, now)) {
      return baseSnapshot(candidate, input.environment, "expired", false, now)
    }
    return baseSnapshot(candidate, input.environment, activeStatus(transaction), true, now)
  }
  return baseSnapshot(candidate, input.environment, "unknown", false, now)
}
