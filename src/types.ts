/**
 * Types shared across the StoreKit module.
 *
 * Kept free of any Apple SDK, Cloudflare, or HTTP import so the policy kernel, the storage
 * adapter, and the host application can all speak the same vocabulary without pulling in each
 * other's dependencies.
 */

export const STOREKIT_ENVIRONMENT = {
  SANDBOX: "Sandbox",
  PRODUCTION: "Production"
} as const

export type StoreKitEnvironment =
  typeof STOREKIT_ENVIRONMENT.SANDBOX | typeof STOREKIT_ENVIRONMENT.PRODUCTION

/** Apple's `status` values from Get All Subscription Statuses. */
export const STOREKIT_STATUS = {
  ACTIVE: 1,
  EXPIRED: 2,
  BILLING_RETRY: 3,
  BILLING_GRACE_PERIOD: 4,
  REVOKED: 5
} as const

/**
 * Worker variables and secrets the module reads.
 *
 * Everything here is supplied as a plain Worker binding, so a host application only has to expose
 * its `env` to the module rather than construct any Apple client itself.
 */
export interface StoreKitEnv {
  STOREKIT_ALLOWED_ENVIRONMENTS?: string
  STOREKIT_ALLOW_SANDBOX_PRE_RELEASE?: string
  STOREKIT_ALLOWED_PRODUCT_IDS?: string
  STOREKIT_ALLOW_APPLE_LOOKUP_FALLBACK?: string
  STOREKIT_ALLOW_GRACE_PERIOD_ACCESS?: string
  STOREKIT_RECONCILE_NOTIFICATIONS?: string
  STOREKIT_ALLOW_ACCOUNT_TRANSFER?: string
  STOREKIT_ALLOW_FAMILY_SHARING?: string
  STOREKIT_BUNDLE_ID?: string
  APP_STORE_CONNECT_ISSUER_ID?: string
  APP_STORE_CONNECT_KEY_ID?: string
  APP_STORE_CONNECT_PRIVATE_KEY?: string
  APP_STORE_APP_APPLE_ID?: string
  APPLE_ROOT_CERTIFICATES_PEM?: string
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
  /** Superseded by an upgrade. The replacement transaction carries the live entitlement. */
  | "upgraded"
  /** Family Sharing access ended. Nobody was refunded; the organiser's subscription is unaffected. */
  | "family_revoked"
  /** A `FAMILY_SHARED` purchase excluded by policy. Only ever set when family sharing is off. */
  | "family_shared"
  | "unknown"

/** Where the authoritative claims behind a snapshot came from. */
export type StoreKitEntitlementSource =
  "posted_jws" | "apple_transaction_lookup" | "app_store_history"

/**
 * The resolved entitlement for one original transaction at one instant.
 *
 * This is the module's central value: verification produces it, the policy kernel computes it,
 * storage projects it, and a host serves it. It carries only Apple-verified claims, nothing a
 * client asserted.
 */
export interface StoreKitEntitlementSnapshot {
  proActive: boolean
  productId: string | null
  /** The subscription's own expiry, which has already elapsed during a billing grace period. */
  expiresAt: string | null
  /**
   * When access actually lapses: `expiresAt` normally, `gracePeriodExpiresAt` during a billing
   * grace period, and `null` for a perpetual (non-consumable) purchase. Read paths must judge
   * active access against this, never against `expiresAt`.
   */
  accessExpiresAt: string | null
  /** True for a non-consumable purchase, whose entitlement never lapses. */
  perpetual: boolean
  gracePeriodExpiresAt: string | null
  isTrial: boolean
  status: StoreKitEntitlementStatus
  environment: StoreKitEnvironment
  originalTransactionId: string | null
  latestTransactionId: string | null
  webOrderLineItemId: string | null
  purchaseDate: string | null
  revocationDate: string | null
  revocationReason: number | null
  /**
   * `REFUND_FULL`, `REFUND_PRORATED` or `FAMILY_REVOKE`, or `null` on older signed material.
   *
   * All three end access to this transaction. The distinction is for reporting: only the two
   * refund types involve money moving.
   */
  revocationType: string | null
  /** The proportion of the transaction revoked, in **milliunits**. `100000` is 100%. */
  revocationPercentage: number | null
  appAccountToken: string | null
  /**
   * `PURCHASED` or `FAMILY_SHARED`, or `null` on material signed before Apple added the field.
   *
   * A family-shared entitlement is a real one — Apple intends the family member to have access —
   * so it is reported rather than filtered, and `proActive` still respects it by default.
   */
  inAppOwnershipType: string | null
  /**
   * True when Apple cancelled this subscription to move the customer to another one.
   *
   * A superseded transaction never grants access: its replacement does. Kept on the snapshot and
   * in the audit projection because the upgrade history is worth having.
   */
  isUpgraded: boolean
  productType: string | null
  offerDiscountType: string | null
  /** Apple's signing time for the material behind this snapshot; the out-of-order write guard. */
  signedDate: string | null
  autoRenewStatus: number | null
  autoRenewProductId: string | null
  expirationIntent: number | null
  isInBillingRetryPeriod: boolean | null
  priceIncreaseStatus: number | null
  renewalPrice: number | null
  currency: string | null
  source: StoreKitEntitlementSource
  resolvedAt: string
}
