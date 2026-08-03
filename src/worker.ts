import {
  getStoreKitEntitlement,
  processStoreKitNotification,
  syncStoreKitTransaction,
  StoreKitConfigError,
  StoreKitPersistenceError,
  StoreKitVerificationError,
  storeKitConfiguredEnvironments
} from "./storekit-module"
import { authenticateStoreKitRequest } from "./auth"

const MAX_BODY_BYTES = 256 * 1024

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  })
}

function serviceConfig(env: Env) {
  return {
    apple: env,
    d1: env,
    allowGracePeriodAccess:
      env.STOREKIT_ALLOW_GRACE_PERIOD_ACCESS?.trim().toLowerCase() !== "false",
    sandboxAllowed: storeKitConfiguredEnvironments(env).includes("Sandbox")
  }
}

async function bodyJson(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("content-length") ?? "0")
  if (contentLength > MAX_BODY_BYTES)
    throw new Error("request body is too large")
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES)
    throw new Error("request body is too large")
  const value = JSON.parse(text) as unknown
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("request body must be a JSON object")
  return value as Record<string, unknown>
}

function errorResponse(error: unknown): Response {
  if (error instanceof StoreKitVerificationError)
    return json(
      { error: "storekit_verification_failed", stage: error.stage },
      400
    )
  if (error instanceof StoreKitConfigError)
    return json({ error: "storekit_not_configured" }, 503)
  if (error instanceof StoreKitPersistenceError)
    return json(
      { error: "storekit_persistence_failed", operation: error.operation },
      503
    )
  return json({ error: "invalid_request" }, 400)
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === "GET" && url.pathname === "/health")
    return json({ ok: true })

  if (
    request.method === "POST" &&
    url.pathname === "/v1/storekit/notifications"
  ) {
    let payload: Record<string, unknown>
    try {
      payload = await bodyJson(request)
    } catch {
      return json({ error: "invalid_request" }, 400)
    }
    const signedPayload = payload.signedPayload
    if (typeof signedPayload !== "string" || signedPayload.length === 0)
      return json({ error: "signedPayload is required" }, 400)
    try {
      const result = await processStoreKitNotification(
        signedPayload,
        serviceConfig(env)
      )
      return json(
        { processed: result.processed, replayed: result.replayed },
        200
      )
    } catch (error) {
      return errorResponse(error)
    }
  }

  if (request.method !== "POST" && request.method !== "GET")
    return json({ error: "method_not_allowed" }, 405)
  const principal = await authenticateStoreKitRequest(request, env)
  if (!principal) return json({ error: "authentication_required" }, 401)

  if (
    request.method === "POST" &&
    url.pathname === "/v1/storekit/transactions/sync"
  ) {
    let payload: Record<string, unknown>
    try {
      payload = await bodyJson(request)
    } catch {
      return json({ error: "invalid_request" }, 400)
    }
    if (
      typeof payload.signedTransactionJWS !== "string" ||
      payload.signedTransactionJWS.length === 0
    )
      return json({ error: "signedTransactionJWS is required" }, 400)
    if (
      payload.appAccountToken !== undefined &&
      typeof payload.appAccountToken !== "string"
    )
      return json({ error: "appAccountToken must be a string" }, 400)
    try {
      const result = await syncStoreKitTransaction(
        {
          signedTransactionJWS: payload.signedTransactionJWS,
          appAccountToken: payload.appAccountToken as string | undefined,
          expectedAppAccountToken: principal.appAccountToken,
          installationId: principal.installationId,
          appBundleId: principal.appBundleId
        },
        serviceConfig(env)
      )
      return json({ snapshot: result.snapshot }, 200)
    } catch (error) {
      return errorResponse(error)
    }
  }

  if (request.method === "GET" && url.pathname === "/v1/storekit/entitlement") {
    try {
      const snapshot = await getStoreKitEntitlement(
        principal.installationId,
        storeKitConfiguredEnvironments(env),
        serviceConfig(env)
      )
      return json(snapshot, 200)
    } catch (error) {
      return errorResponse(error)
    }
  }
  return json({ error: "not_found" }, 404)
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env)
  }
}
