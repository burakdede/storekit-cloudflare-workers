/**
 * Drop-in server-side StoreKit 2 for Cloudflare Workers + D1.
 *
 * Install the package, apply its D1 migration, set the Apple secrets, and mount
 * `createStoreKitHandler` (or export `createStoreKitWorker` directly). See the README for the
 * full integration guide.
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
  storeKitAllowAccountTransfer,
  storeKitAllowFamilySharing,
  storeKitAllowGracePeriodAccess,
  storeKitAppAppleId,
  storeKitAppleLookupFallbackEnabled,
  storeKitReconcileNotifications,
  storeKitConfiguredEnvironment,
  storeKitConfiguredEnvironments,
  storeKitSandboxPreReleaseEnabled,
  type StoreKitConfigReport
} from "./config.js"

export {
  StoreKitConfigError,
  StoreKitOwnershipConflictError,
  StoreKitPersistenceError,
  StoreKitVerificationError,
  type StoreKitVerificationDiagnostics
} from "./errors.js"

export {
  STOREKIT_ENVIRONMENT,
  STOREKIT_NOTIFICATION_TYPE,
  STOREKIT_STATUS,
  type StoreKitEntitlementSnapshot,
  type StoreKitEntitlementSource,
  type StoreKitEntitlementStatus,
  type StoreKitEnv,
  type StoreKitEnvironment,
  type StoreKitNotificationType
} from "./types.js"

export {
  resolveStoreKitEntitlementCore,
  resolveStoreKitEntitlementCore as resolveStoreKitEntitlementPolicy,
  type StoreKitEntitlementCandidate,
  type StoreKitEntitlementInput,
  type StoreKitEntitlementPolicy,
  type StoreKitEntitlementRenewalInfo,
  type StoreKitEntitlementTransaction
} from "./entitlement.js"

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
} from "./verification.js"

export {
  listStoreKitSubscriptionsByInstallation,
  loadStoreKitSubscriptionByInstallation,
  loadStoreKitSubscriptionByTransaction,
  loadStoreKitSubscriptionOwner,
  persistStoreKitNotification,
  persistStoreKitSubscriptionForInstallation,
  storeKitNotificationExists,
  storeKitNotificationStatement,
  type StoreKitDatabase,
  type StoreKitPersistOptions,
  type StoreKitSubscriptionRecord
} from "./storage.js"

export {
  getStoreKitEntitlement,
  isStoreKitRecordActive,
  listStoreKitEntitlements,
  processStoreKitNotification,
  readStoreKitEntitlement,
  syncStoreKitTransaction,
  type StoreKitCurrentEntitlement,
  type StoreKitEntitlementChange,
  type StoreKitEntitlementChangeField,
  type StoreKitEntitlementChangeHook,
  type StoreKitEntitlementEntry,
  type StoreKitNotificationProcessResult,
  type StoreKitServiceConfig,
  type StoreKitTransactionSyncInput,
  type StoreKitTransactionSyncResult
} from "./service.js"

export {
  type StoreKitD1Database,
  type StoreKitExecutionContext,
  type StoreKitPreparedStatement
} from "./cloudflare.js"

export { createStoreKitWorker, type StoreKitWorker, type StoreKitWorkerOptions } from "./worker.js"

export {
  createStoreKitHandler,
  storeKitRoutePaths,
  type StoreKitEventSink,
  type StoreKitHandler,
  type StoreKitHandlerOptions,
  type StoreKitRequestContext,
  type StoreKitRoutePaths,
  type StoreKitWorkerEnv
} from "./router.js"

export {
  extendStoreKitSubscriptionRenewalDate,
  getStoreKitNotificationHistory,
  getStoreKitRefundHistory,
  getStoreKitTransactionHistory,
  lookUpStoreKitOrderId,
  requestStoreKitTestNotification,
  sendStoreKitConsumptionInformation,
  type StoreKitServerApiEnv
} from "./server-api.js"
