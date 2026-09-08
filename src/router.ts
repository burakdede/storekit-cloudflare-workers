/**
 * Drop-in Cloudflare Worker request handler.
 *
 * This is the "one call" integration: give it your `env`, tell it how to authenticate a request,
 * and mount it. It owns request parsing, Apple verification, entitlement policy, D1 persistence
 * and HTTP status mapping, and it deliberately owns nothing else: authentication is yours,
 * because only your app knows who a caller is.
 *
 *     const storekit = createStoreKitHandler({
 *       authenticate: async (request) => ({ accountId: await myUserIdFrom(request) })
 *     })
 *
 *     export default {
 *       async fetch(request, env, ctx) {
 *         const handled = await storekit.fetch(request, env, ctx)
 *         return handled ?? myOtherRoutes(request, env, ctx)
 *       }
 *     }
 *
 * `fetch` returns `null` when the request is not a StoreKit route, so it composes with any router.
 */
import type { StoreKitExecutionContext } from "./cloudflare.js"
import {
  StoreKitConfigError,
  StoreKitOwnershipConflictError,
  StoreKitPersistenceError,
  StoreKitVerificationError
} from "./errors.js"
import {
  getStoreKitEntitlement,
  listStoreKitEntitlements,
  processStoreKitNotification,
  syncStoreKitTransaction,
  type StoreKitEntitlementChange,
  type StoreKitServiceConfig,
  type StoreKitTransactionSyncResult
} from "./service.js"
import {
  storeKitAllowAccountTransfer,
  storeKitAllowFamilySharing,
  storeKitAllowGracePeriodAccess,
  storeKitConfiguredEnvironments,
  storeKitReconcileNotifications
} from "./config.js"
import type { StoreKitDatabase } from "./storage.js"
import type { StoreKitEnv } from "./types.js"
import type { StoreKitRuntimeSource } from "./verification.js"

/**
 * The minimum a Worker environment must provide: the StoreKit variables.
 *
 * The handler is generic over your own generated `Env`, so your bindings keep their real types
 * inside `authenticate` and `database` and nothing here dictates what your D1 binding is called.
 */
export type StoreKitWorkerEnv = StoreKitEnv

export interface StoreKitRoutePaths {
  /** Authenticated: client posts Apple-signed transaction JWS after purchase or restore. */
  sync: string
  /** Authenticated: read the current entitlement projection. */
  entitlement: string
  /** Unauthenticated: Apple's App Store Server Notifications V2 webhook. */
  notifications: string
}

export const storeKitRoutePaths: StoreKitRoutePaths = {
  sync: "/storekit/transactions/sync",
  entitlement: "/storekit/entitlement",
  notifications: "/storekit/notifications"
}

/**
 * What the host resolved about the caller.
 *
 * `accountId` is the stable identifier the entitlement is bound to: a user id, an installation
 * id, whatever your app uses. `expectedAppAccountToken` should be set when your client passes an
 * `appAccountToken` on purchase; the module then refuses a transaction minted for a different
 * account, which is what stops a purchase being replayed onto someone else's account.
 */
export interface StoreKitRequestContext {
  accountId: string
  appBundleId?: string | undefined
  expectedAppAccountToken?: string | undefined
  sandboxAllowed?: boolean | undefined
}

/* eslint-disable no-unused-vars -- Structural callback signatures name parameters only for typing. */
/** Structured log sink. Receives no secrets, no signed payloads and no bearer tokens. */
export type StoreKitEventSink = (_event: Record<string, unknown>) => void

export interface StoreKitHandlerOptions<TEnv extends StoreKitWorkerEnv = StoreKitWorkerEnv> {
  /**
   * Resolve the caller. Return `null` to reject with 401.
   *
   * The notification webhook never calls this: Apple authenticates itself with a JWS signature,
   * and no bearer token exists for it.
   */
  authenticate: (
    _request: Request,
    _env: TEnv
  ) => Promise<StoreKitRequestContext | null> | StoreKitRequestContext | null
  /**
   * Resolve the D1 binding from your env. Defaults to `env.STOREKIT_DB`.
   *
   * Override it when your Worker already declares the database under another name, e.g.
   * `database: (env) => env.DB`.
   */
  database?: ((_env: TEnv) => StoreKitDatabase | undefined) | undefined
  /** Override the mounted paths, e.g. to sit under an existing `/api/v1` prefix. */
  paths?: Partial<StoreKitRoutePaths> | undefined
  /**
   * Whether a billing grace period grants access. Defaults to the
   * `STOREKIT_ALLOW_GRACE_PERIOD_ACCESS` variable, which itself defaults to `true` (Apple's
   * intent). Setting it here overrides the variable.
   */
  allowGracePeriodAccess?: boolean | undefined
  /**
   * Whether a `FAMILY_SHARED` purchase grants access. Defaults to the
   * `STOREKIT_ALLOW_FAMILY_SHARING` variable, which itself defaults to `true` (Apple's intent).
   */
  allowFamilySharing?: boolean | undefined
  /**
   * Re-read Apple's status on each notification. Defaults to the
   * `STOREKIT_RECONCILE_NOTIFICATIONS` variable, which itself defaults to `true`.
   */
  reconcileNotificationsWithApple?: boolean | undefined
  /**
   * Whether a sync may move an entitlement already bound to another account. Defaults to the
   * `STOREKIT_ALLOW_ACCOUNT_TRANSFER` variable, which itself defaults to `false`: a conflicting
   * sync answers `409` and writes nothing.
   */
  allowAccountTransfer?: boolean | undefined
  /**
   * Called after a write that changed the entitlement: a renewal, an expiry, a refund, a grace
   * period starting. This is where you mirror the entitlement onto your own tables, send the
   * payment-failure push, or release server-side resources.
   *
   * It does not fire for an idempotent re-sync or a replayed notification, and a hook that throws
   * is reported to `onEvent` without failing the response — otherwise Apple would redeliver a
   * notification that was in fact processed.
   *
   * Awaited by default. Return quickly, or pass `entitlementChangeMode: "waitUntil"` to let the
   * work outlive the response.
   */
  onEntitlementChange?: ((_change: StoreKitEntitlementChange) => void | Promise<void>) | undefined
  /**
   * `await` (default) blocks the response on the hook; `waitUntil` hands it to the runtime and
   * responds immediately. `waitUntil` needs the `ctx` your Worker was called with, and falls back
   * to awaiting when none was passed.
   */
  entitlementChangeMode?: "await" | "waitUntil" | undefined
  /**
   * Prebuilt Apple runtimes, so the isolate builds the verifier and Apple client once rather than
   * on every request. Defaults to building them from `env`.
   *
   *     const runtimes = buildStoreKitRuntimes(env)   // once, at module scope
   *     createStoreKitHandler({ authenticate, runtimes: () => runtimes })
   */
  runtimes?: StoreKitRuntimeSource | undefined
  onEvent?: StoreKitEventSink | undefined
}

/* eslint-enable no-unused-vars */

/**
 * Describe a sync Apple could not be reached for.
 *
 * `STOREKIT_ALLOW_APPLE_LOOKUP_FALLBACK` lets verification fall back to the submitted JWS when
 * Apple's API is unavailable. That is a deliberate trade-off, but it is silent: the request
 * succeeds and the entitlement resolves from claims that may be stale. These fields are what let an
 * operator see it happening — and tell a rate limit (`429`) apart from an outage, which otherwise
 * look identical.
 */
function appleLookupDegradation(
  verified: StoreKitTransactionSyncResult["verified"]
): Record<string, unknown> | null {
  const diagnostics =
    verified.transactionLookupDiagnostics ?? verified.subscriptionStatusLookupDiagnostics
  if (!diagnostics) return null
  return {
    appleLookupDegraded: true,
    appleLookupFailed: verified.transactionLookupDiagnostics
      ? "transaction"
      : "subscription_status",
    appleHttpStatus: diagnostics.appleHttpStatus,
    appleApiError: diagnostics.appleApiError,
    appleSdkErrorName: diagnostics.sdkErrorName
  }
}

const MAX_JWS_LENGTH = 16_384
const MAX_NOTIFICATION_LENGTH = 65_536

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  })
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ code, message }, status)
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json()
    if (!body || typeof body !== "object" || Array.isArray(body)) return null
    return body as Record<string, unknown>
  } catch {
    return null
  }
}

function readString(body: Record<string, unknown>, key: string, maxLength: number): string | null {
  const value = body[key]
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (trimmed.length < 32 || trimmed.length > maxLength) return null
  return trimmed
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function readAppAccountToken(body: Record<string, unknown>): string | null | undefined {
  const value = body.appAccountToken
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return null
  return value
}

/**
 * Map a module error to a response.
 *
 * Verification failures never explain *why* to the client; the stage travels to logs instead, so
 * an attacker probing with forged payloads learns nothing about which check rejected them.
 */
function responseForError(error: unknown, emit: StoreKitEventSink, event: string): Response {
  if (error instanceof StoreKitOwnershipConflictError) {
    // Unlike a verification failure, this one is worth explaining. The caller already holds the
    // transaction, so the response reveals nothing they do not have, and "someone else owns this
    // purchase" is the only message from which a client can build a sensible recovery flow.
    emit({
      level: "warn",
      event: `${event}_ownership_conflict`,
      originalTransactionId: error.originalTransactionId,
      environment: error.environment
    })
    return errorResponse(
      409,
      "OWNERSHIP_CONFLICT",
      "This purchase is already associated with a different account."
    )
  }
  if (error instanceof StoreKitConfigError) {
    emit({
      level: "error",
      event: `${event}_misconfigured`,
      message: error.message
    })
    return errorResponse(503, "UPSTREAM_UNAVAILABLE", "StoreKit verification is not configured.")
  }
  if (error instanceof StoreKitVerificationError) {
    emit({
      level: "warn",
      event: `${event}_rejected`,
      verificationStage: error.stage,
      verificationFailure: error.message,
      verificationSdkErrorName: error.sdkErrorName,
      verificationAppleHttpStatus: error.appleHttpStatus,
      verificationAppleApiError: error.appleApiError
    })
    return errorResponse(400, "VALIDATION_ERROR", "StoreKit transaction could not be verified.")
  }
  if (error instanceof StoreKitPersistenceError) {
    emit({
      level: "error",
      event: `${event}_storage_failed`,
      operation: error.operation,
      retryable: error.retryable
    })
    return error.retryable
      ? errorResponse(503, "UPSTREAM_UNAVAILABLE", "Backend storage is temporarily unavailable.")
      : errorResponse(400, "VALIDATION_ERROR", "StoreKit transaction could not be verified.")
  }
  emit({ level: "error", event: `${event}_failed` })
  return errorResponse(500, "INTERNAL_ERROR", "StoreKit request could not be completed.")
}

/* eslint-disable no-unused-vars -- Structural fetch signature names parameters only for typing. */
export interface StoreKitHandler<TEnv extends StoreKitWorkerEnv = StoreKitWorkerEnv> {
  /** Returns `null` when the request does not match a StoreKit route. */
  fetch: (
    _request: Request,
    _env: TEnv,
    _ctx?: StoreKitExecutionContext
  ) => Promise<Response | null>
  paths: StoreKitRoutePaths
}

/* eslint-enable no-unused-vars */

/**
 * Default binding lookup: `env.STOREKIT_DB`.
 *
 * Overridable via the `database` option so the module never dictates your binding name.
 */
function defaultDatabase(env: StoreKitWorkerEnv): StoreKitDatabase | undefined {
  return (env as { STOREKIT_DB?: StoreKitDatabase }).STOREKIT_DB
}

export function createStoreKitHandler<TEnv extends StoreKitWorkerEnv = StoreKitWorkerEnv>(
  options: StoreKitHandlerOptions<TEnv>
): StoreKitHandler<TEnv> {
  const paths: StoreKitRoutePaths = { ...storeKitRoutePaths, ...options.paths }
  const emit: StoreKitEventSink = (event) => options.onEvent?.(event)
  const reportHookError = (error: unknown): void => {
    emit({
      level: "error",
      event: "storekit_entitlement_change_hook_failed",
      message: error instanceof Error ? error.message : "unknown_error"
    })
  }
  // eslint-disable-next-line no-unused-vars -- Structural callback signature names its parameter only for typing.
  const resolveDatabase: (_env: TEnv) => StoreKitDatabase | undefined =
    options.database ?? defaultDatabase

  function serviceConfig(
    env: TEnv,
    context?: StoreKitRequestContext,
    ctx?: StoreKitExecutionContext
  ): StoreKitServiceConfig {
    // Code options win over Worker variables; the variables are the zero-code default so a
    // drop-in user configures policy in wrangler.jsonc rather than by editing source.
    const config: StoreKitServiceConfig = {
      apple: env,
      d1: resolveDatabase(env) as StoreKitDatabase,
      allowGracePeriodAccess: options.allowGracePeriodAccess ?? storeKitAllowGracePeriodAccess(env),
      allowFamilySharing: options.allowFamilySharing ?? storeKitAllowFamilySharing(env),
      reconcileNotificationsWithApple:
        options.reconcileNotificationsWithApple ?? storeKitReconcileNotifications(env),
      allowAccountTransfer: options.allowAccountTransfer ?? storeKitAllowAccountTransfer(env)
    }
    if (options.runtimes) config.runtimes = options.runtimes
    const hook = options.onEntitlementChange
    if (hook) {
      config.onEntitlementChange =
        options.entitlementChangeMode === "waitUntil" && ctx
          ? (change) => {
              // Errors still reach onEvent: the service wraps the call, and a rejected promise
              // handed to waitUntil would otherwise be an unhandled rejection.
              ctx.waitUntil(Promise.resolve(hook(change)).catch(reportHookError))
            }
          : hook
      config.onEntitlementChangeError = reportHookError
    }
    if (context?.sandboxAllowed !== undefined) config.sandboxAllowed = context.sandboxAllowed
    return config
  }

  async function handleSync(
    request: Request,
    env: TEnv,
    context: StoreKitRequestContext,
    ctx?: StoreKitExecutionContext
  ): Promise<Response> {
    const body = await readJsonBody(request)
    if (!body) return errorResponse(400, "VALIDATION_ERROR", "Invalid StoreKit sync payload.")

    const signedTransactionJWS = readString(body, "signedTransactionJWS", MAX_JWS_LENGTH)
    if (!signedTransactionJWS) {
      return errorResponse(400, "VALIDATION_ERROR", "Invalid StoreKit sync payload.")
    }
    const appAccountToken = readAppAccountToken(body)
    if (appAccountToken === null) {
      return errorResponse(400, "VALIDATION_ERROR", "Invalid StoreKit sync payload.")
    }

    const appBundleId = context.appBundleId ?? env.STOREKIT_BUNDLE_ID ?? ""
    const result = await syncStoreKitTransaction(
      {
        signedTransactionJWS,
        appAccountToken,
        expectedAppAccountToken: context.expectedAppAccountToken,
        installationId: context.accountId,
        appBundleId
      },
      serviceConfig(env, context, ctx)
    )
    // A degraded sync is one Apple could not be reached for, resolved from the already
    // signature-verified submitted JWS instead. It succeeds, so nothing else marks it, and a
    // deployment can run entirely on the fallback for hours without a single signal. Reported at
    // `warn` for that reason.
    const degradation = appleLookupDegradation(result.verified)
    emit({
      level: degradation ? "warn" : "info",
      event: "storekit_transaction_verified",
      accountId: context.accountId,
      productId: result.snapshot.productId,
      environment: result.snapshot.environment,
      computedStatus: result.snapshot.status,
      proActive: result.snapshot.proActive,
      verificationSource: result.verified.verificationSource,
      ...degradation
    })
    return jsonResponse(result.snapshot, 200)
  }

  async function handleEntitlement(env: TEnv, context: StoreKitRequestContext): Promise<Response> {
    const environments = storeKitConfiguredEnvironments(env)
    const database = { d1: resolveDatabase(env) as StoreKitDatabase }
    const resolvedAt = new Date()
    // The top-level fields describe the single best entitlement, which is what a one-product app
    // reads; `entitlements` lists every group the account holds. Both come from one row read.
    const [entitlement, entitlements] = await Promise.all([
      getStoreKitEntitlement(context.accountId, environments, database, resolvedAt),
      listStoreKitEntitlements(context.accountId, environments, database, resolvedAt)
    ])
    return jsonResponse({ ...entitlement, entitlements }, 200)
  }

  /**
   * Apple retries any non-2xx response for up to three days, which is the desired behaviour for a
   * transient failure. A payload that fails verification is answered 401 rather than 200 so a
   * forged notification is never silently accepted.
   */
  async function handleNotification(
    request: Request,
    env: TEnv,
    ctx?: StoreKitExecutionContext
  ): Promise<Response> {
    const body = await readJsonBody(request)
    const signedPayload = body ? readString(body, "signedPayload", MAX_NOTIFICATION_LENGTH) : null
    if (!signedPayload) {
      return errorResponse(400, "VALIDATION_ERROR", "Invalid StoreKit notification payload.")
    }

    try {
      const result = await processStoreKitNotification(
        signedPayload,
        serviceConfig(env, undefined, ctx)
      )
      emit({
        level: "info",
        event: result.replayed
          ? "storekit_notification_replayed"
          : "storekit_notification_processed",
        notificationType: result.verified.notification.notificationType,
        notificationSubtype: result.verified.notification.subtype,
        reconciled: result.reconciled,
        computedStatus: result.snapshot?.status,
        proActive: result.snapshot?.proActive
      })
      return jsonResponse({ processed: true, replayed: result.replayed }, 200)
    } catch (error) {
      if (error instanceof StoreKitVerificationError) {
        emit({
          level: "warn",
          event: "storekit_notification_rejected",
          verificationStage: error.stage
        })
        return errorResponse(401, "UNAUTHORIZED", "StoreKit notification could not be verified.")
      }
      throw error
    }
  }

  return {
    paths,
    async fetch(request, env, ctx): Promise<Response | null> {
      const { pathname } = new URL(request.url)
      const isSync = pathname === paths.sync
      const isEntitlement = pathname === paths.entitlement
      const isNotification = pathname === paths.notifications
      if (!isSync && !isEntitlement && !isNotification) return null

      const expectedMethod = isEntitlement ? "GET" : "POST"
      if (request.method !== expectedMethod) {
        return errorResponse(405, "METHOD_NOT_ALLOWED", "Method not allowed.")
      }

      try {
        if (isNotification) return await handleNotification(request, env, ctx)

        const context = await options.authenticate(request, env)
        if (!context) {
          return errorResponse(401, "UNAUTHORIZED", "Authentication is required.")
        }
        return isSync
          ? await handleSync(request, env, context, ctx)
          : await handleEntitlement(env, context)
      } catch (error) {
        const event = isNotification
          ? "storekit_notification"
          : isSync
            ? "storekit_transaction_sync"
            : "storekit_entitlement_read"
        return responseForError(error, emit, event)
      }
    }
  }
}
