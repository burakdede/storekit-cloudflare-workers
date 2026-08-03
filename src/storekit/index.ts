/**
 * Drop-in server-side StoreKit 2 for Cloudflare Workers + D1.
 *
 * Copy this directory into a Worker, apply `schema.sql` to a D1 database, set the Apple secrets,
 * and mount `createStoreKitHandler`. See the project README for the full integration guide.
 *
 * The design is server-authoritative: the iOS client submits Apple-signed JWS material and the
 * Worker verifies the signature, app identity, environment and product allow-list before any
 * entitlement is granted. No client-asserted subscription state is ever trusted.
 */

export {
  assertStoreKitConfig,
  describeStoreKitConfig,
  parseAppleRootCertificatesPem,
  storeKitAllowedProductIds,
  storeKitAllowGracePeriodAccess,
  storeKitAppAppleId,
  storeKitAppleLookupFallbackEnabled,
  storeKitReconcileNotifications,
  storeKitConfiguredEnvironment,
  storeKitConfiguredEnvironments,
  storeKitSandboxPreReleaseEnabled,
  type StoreKitConfigReport
} from "./config"

export {
  StoreKitConfigError,
  StoreKitPersistenceError,
  StoreKitVerificationError,
  type StoreKitVerificationDiagnostics
} from "./errors"

export {
  STOREKIT_ENVIRONMENT,
  STOREKIT_STATUS,
  type StoreKitEntitlementSnapshot,
  type StoreKitEntitlementSource,
  type StoreKitEntitlementStatus,
  type StoreKitEnv,
  type StoreKitEnvironment
} from "./types"

export {
  resolveStoreKitEntitlementCore,
  resolveStoreKitEntitlementCore as resolveStoreKitEntitlementPolicy,
  type StoreKitEntitlementCandidate,
  type StoreKitEntitlementInput,
  type StoreKitEntitlementRenewalInfo,
  type StoreKitEntitlementTransaction
} from "./entitlement"

export {
  buildStoreKitRuntimes,
  lookupStoreKitSubscriptionState,
  resolveStoreKitEntitlement,
  storeKitStatusName,
  verifyStoreKitNotification,
  verifyStoreKitNotificationForRuntime,
  verifyStoreKitNotificationWithRuntime,
  verifyStoreKitTransaction,
  verifyStoreKitTransactionWithRuntime,
  type StoreKitRuntime,
  type StoreKitSubscriptionState,
  type VerifiedStoreKitNotification,
  type VerifiedStoreKitSubscriptionTransaction,
  type VerifiedStoreKitTransaction
} from "./verification"

export {
  loadStoreKitSubscriptionByInstallation,
  persistStoreKitNotification,
  persistStoreKitSubscriptionForInstallation,
  storeKitNotificationExists,
  storeKitNotificationStatement,
  type StoreKitDatabase,
  type StoreKitSubscriptionRecord
} from "./storage"

export {
  getStoreKitEntitlement,
  isStoreKitRecordActive,
  processStoreKitNotification,
  readStoreKitEntitlement,
  syncStoreKitTransaction,
  type StoreKitCurrentEntitlement,
  type StoreKitNotificationProcessResult,
  type StoreKitServiceConfig,
  type StoreKitTransactionSyncInput,
  type StoreKitTransactionSyncResult
} from "./service"

export {
  createStoreKitHandler,
  storeKitRoutePaths,
  type StoreKitEventSink,
  type StoreKitHandler,
  type StoreKitHandlerOptions,
  type StoreKitRequestContext,
  type StoreKitRoutePaths,
  type StoreKitWorkerEnv
} from "./router"

export {
  extendStoreKitSubscriptionRenewalDate,
  getStoreKitNotificationHistory,
  getStoreKitRefundHistory,
  getStoreKitTransactionHistory,
  lookUpStoreKitOrderId,
  requestStoreKitTestNotification,
  sendStoreKitConsumptionInformation,
  type StoreKitServerApiEnv
} from "./server-api"
