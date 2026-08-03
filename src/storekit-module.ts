/**
 * Public drop-in entrypoint for the Cloudflare Worker + D1 StoreKit module.
 *
 * Route handlers in this repository remain in `storekit-shared.ts` because they also depend on
 * the host application mobile-session policy. Consumers integrating the reusable module should import this
 * entrypoint plus their own authentication/router adapter.
 */
export {
  resolveStoreKitEntitlement,
  resolveStoreKitEntitlementCore,
  parseAppleRootCertificatesPem,
  storeKitAllowedProductIds,
  storeKitAppleLookupFallbackEnabled,
  storeKitConfiguredEnvironment,
  storeKitConfiguredEnvironments,
  storeKitSandboxPreReleaseEnabled,
  storeKitStatusName,
  verifyStoreKitNotification,
  verifyStoreKitNotificationWithRuntime,
  verifyStoreKitTransaction,
  verifyStoreKitTransactionWithRuntime,
  StoreKitConfigError,
  StoreKitVerificationError,
  type StoreKitEnv,
  type StoreKitEntitlementSnapshot,
  type StoreKitEntitlementStatus,
  type StoreKitEnvironment,
  type StoreKitRuntime,
  type StoreKitVerificationDiagnostics,
  type VerifiedStoreKitNotification,
  type VerifiedStoreKitSubscriptionTransaction,
  type VerifiedStoreKitTransaction
} from "./storekit"

export {
  loadStoreKitSubscriptionByInstallation,
  persistStoreKitNotification,
  persistStoreKitSubscriptionForInstallation,
  storeKitNotificationExists,
  storeKitNotificationStatement,
  type StoreKitD1Env,
  type StoreKitSubscriptionRecord,
  StoreKitPersistenceError
} from "./lib/storekit-d1"

export {
  processStoreKitNotification,
  getStoreKitEntitlement,
  readStoreKitEntitlement,
  syncStoreKitTransaction,
  type StoreKitNotificationProcessResult,
  type StoreKitCurrentEntitlement,
  type StoreKitServiceConfig,
  type StoreKitTransactionSyncInput,
  type StoreKitTransactionSyncResult
} from "./lib/storekit-service"

export {
  resolveStoreKitEntitlementCore as resolveStoreKitEntitlementPolicy,
  type StoreKitEntitlementCandidate,
  type StoreKitEntitlementInput,
  type StoreKitEntitlementTransaction
} from "./lib/storekit-entitlement-core"
