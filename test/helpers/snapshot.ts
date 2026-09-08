/**
 * A complete, valid entitlement snapshot for tests to vary one field of.
 *
 * `StoreKitEntitlementSnapshot` gains a field whenever Apple's contract does, and every literal
 * fixture then fails to compile until it is updated by hand. Building from one default keeps that
 * churn in a single place, and keeps each test's diff to the field it is actually about.
 */
import type { StoreKitEntitlementSnapshot } from "../../src/types"

const DEFAULT_SNAPSHOT: StoreKitEntitlementSnapshot = {
  proActive: true,
  productId: "com.example.pro.monthly",
  expiresAt: "2099-06-02T12:00:00.000Z",
  accessExpiresAt: "2099-06-02T12:00:00.000Z",
  perpetual: false,
  gracePeriodExpiresAt: null,
  isTrial: false,
  status: "active_paid",
  environment: "Sandbox",
  originalTransactionId: "original-1",
  latestTransactionId: "transaction-1",
  webOrderLineItemId: "web-order-1",
  purchaseDate: "2026-06-01T12:00:00.000Z",
  revocationDate: null,
  revocationReason: null,
  revocationType: null,
  revocationPercentage: null,
  appAccountToken: null,
  inAppOwnershipType: "PURCHASED",
  isUpgraded: false,
  productType: "Auto-Renewable Subscription",
  offerDiscountType: null,
  signedDate: "2026-06-02T12:00:00.000Z",
  autoRenewStatus: 1,
  autoRenewProductId: "com.example.pro.monthly",
  expirationIntent: null,
  isInBillingRetryPeriod: null,
  priceIncreaseStatus: null,
  renewalPrice: null,
  currency: null,
  source: "posted_jws",
  resolvedAt: "2026-06-02T12:00:00.000Z"
}

export function entitlementSnapshot(
  overrides: Partial<StoreKitEntitlementSnapshot> = {}
): StoreKitEntitlementSnapshot {
  return { ...DEFAULT_SNAPSHOT, ...overrides }
}
