/**
 * Operational App Store Server API calls.
 *
 * These are the endpoints an integration needs beyond the purchase path: proving the webhook
 * works, reconciling missed notifications after an outage, answering Apple's refund enquiries,
 * and granting goodwill extensions. Each one reuses the same authenticated, environment-pinned
 * client the verification path builds, so credentials are configured in exactly one place.
 *
 * All of these are privileged operations. Never expose them on an unauthenticated route.
 */
import type {
  ConsumptionRequest,
  ExtendRenewalDateRequest,
  ExtendRenewalDateResponse,
  HistoryResponse,
  NotificationHistoryRequest,
  NotificationHistoryResponse,
  OrderLookupResponse,
  RefundHistoryResponse,
  SendTestNotificationResponse,
  TransactionHistoryRequest
} from "@apple/app-store-server-library"
import { storeKitConfiguredEnvironment } from "./config"
import { StoreKitConfigError } from "./errors"
import type { StoreKitEnv, StoreKitEnvironment } from "./types"
import { buildStoreKitRuntimes, type StoreKitRuntime } from "./verification"

export type StoreKitServerApiEnv = StoreKitEnv

/**
 * The full Apple client, which carries more methods than the verification path's structural
 * subset. Cast at this boundary so `verification.ts` keeps its minimal, easily-stubbed contract.
 */
type AppleServerApi = {
  requestTestNotification: () => Promise<SendTestNotificationResponse>
  getNotificationHistory: (
    // eslint-disable-next-line no-unused-vars -- Structural SDK signatures name parameters only for typing.
    _paginationToken: string | null,
    // eslint-disable-next-line no-unused-vars
    _request: NotificationHistoryRequest
  ) => Promise<NotificationHistoryResponse>
  getTransactionHistory: (
    // eslint-disable-next-line no-unused-vars
    _transactionId: string,
    // eslint-disable-next-line no-unused-vars
    _revision: string | null,
    // eslint-disable-next-line no-unused-vars
    _request: TransactionHistoryRequest
  ) => Promise<HistoryResponse>
  getRefundHistory: (
    // eslint-disable-next-line no-unused-vars
    _transactionId: string,
    // eslint-disable-next-line no-unused-vars
    _revision: string | null
  ) => Promise<RefundHistoryResponse>
  // eslint-disable-next-line no-unused-vars
  lookUpOrderId: (_orderId: string) => Promise<OrderLookupResponse>
  extendSubscriptionRenewalDate: (
    // eslint-disable-next-line no-unused-vars
    _originalTransactionId: string,
    // eslint-disable-next-line no-unused-vars
    _request: ExtendRenewalDateRequest
  ) => Promise<ExtendRenewalDateResponse>
  sendConsumptionInformation: (
    // eslint-disable-next-line no-unused-vars
    _transactionId: string,
    // eslint-disable-next-line no-unused-vars
    _request: ConsumptionRequest
  ) => Promise<void>
}

/**
 * Resolve the runtime for one environment.
 *
 * Operational calls address a specific store, so the environment is explicit rather than
 * discovered by trial verification the way an inbound signed payload is.
 */
async function runtimeForEnvironment(
  env: StoreKitEnv,
  environment: StoreKitEnvironment | undefined
): Promise<StoreKitRuntime> {
  const target = environment ?? storeKitConfiguredEnvironment(env)
  const runtimes = await buildStoreKitRuntimes(env)
  const runtime = runtimes.find((candidate) => candidate.environment === target)
  if (!runtime) {
    throw new StoreKitConfigError(
      `StoreKit environment ${target} is not in STOREKIT_ALLOWED_ENVIRONMENTS.`
    )
  }
  return runtime
}

async function appleApi(
  env: StoreKitEnv,
  environment: StoreKitEnvironment | undefined
): Promise<AppleServerApi> {
  const runtime = await runtimeForEnvironment(env, environment)
  return runtime.client as unknown as AppleServerApi
}

/**
 * Ask Apple to send a test notification to the configured webhook URL.
 *
 * The returned token can be passed to Apple's `getTestNotificationStatus` to see exactly what
 * Apple observed — this is the fastest way to prove a webhook is reachable and verifying.
 */
export async function requestStoreKitTestNotification(
  env: StoreKitEnv,
  environment?: StoreKitEnvironment
): Promise<SendTestNotificationResponse> {
  return (await appleApi(env, environment)).requestTestNotification()
}

/**
 * Read the notifications Apple attempted to deliver.
 *
 * This is the reconciliation path after a webhook outage: Apple retains history for 6 months, so
 * replaying it through `processStoreKitNotification` recovers entitlement state that was missed.
 */
export async function getStoreKitNotificationHistory(
  env: StoreKitEnv,
  request: NotificationHistoryRequest,
  paginationToken: string | null = null,
  environment?: StoreKitEnvironment
): Promise<NotificationHistoryResponse> {
  return (await appleApi(env, environment)).getNotificationHistory(
    paginationToken,
    request
  )
}

/** Full signed transaction history for a customer, newest first by default. */
export async function getStoreKitTransactionHistory(
  env: StoreKitEnv,
  transactionId: string,
  request: TransactionHistoryRequest,
  revision: string | null = null,
  environment?: StoreKitEnvironment
): Promise<HistoryResponse> {
  return (await appleApi(env, environment)).getTransactionHistory(
    transactionId,
    revision,
    request
  )
}

export async function getStoreKitRefundHistory(
  env: StoreKitEnv,
  transactionId: string,
  revision: string | null = null,
  environment?: StoreKitEnvironment
): Promise<RefundHistoryResponse> {
  return (await appleApi(env, environment)).getRefundHistory(
    transactionId,
    revision
  )
}

/** Resolve a customer-supplied order id from their App Store receipt, for support workflows. */
export async function lookUpStoreKitOrderId(
  env: StoreKitEnv,
  orderId: string,
  environment?: StoreKitEnvironment
): Promise<OrderLookupResponse> {
  return (await appleApi(env, environment)).lookUpOrderId(orderId)
}

/**
 * Extend a subscription's renewal date, e.g. as goodwill after an outage.
 *
 * Apple sends a `RENEWAL_EXTENSION` notification afterwards, so the entitlement projection
 * updates through the normal webhook path rather than needing a separate write here.
 */
export async function extendStoreKitSubscriptionRenewalDate(
  env: StoreKitEnv,
  originalTransactionId: string,
  request: ExtendRenewalDateRequest,
  environment?: StoreKitEnvironment
): Promise<ExtendRenewalDateResponse> {
  return (await appleApi(env, environment)).extendSubscriptionRenewalDate(
    originalTransactionId,
    request
  )
}

/**
 * Answer a `CONSUMPTION_REQUEST` notification.
 *
 * Apple sends that notification when a customer requests a refund and has consented to share
 * consumption data; responding within 12 hours is what lets Apple weigh your usage data in the
 * refund decision. Only send it when `consentStatus` reflects real customer consent.
 */
export async function sendStoreKitConsumptionInformation(
  env: StoreKitEnv,
  transactionId: string,
  request: ConsumptionRequest,
  environment?: StoreKitEnvironment
): Promise<void> {
  await (
    await appleApi(env, environment)
  ).sendConsumptionInformation(transactionId, request)
}
