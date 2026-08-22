/**
 * A complete Worker export, for hosts whose Worker is StoreKit and nothing else.
 *
 * `createStoreKitHandler` composes into an existing router; this wraps it so a greenfield Worker
 * is a single default export with no routing code at all:
 *
 *     export default createStoreKitWorker<Env>({ authenticate })
 *
 * Anything the package does not route falls through to `fetch`, so it stays usable once the Worker
 * grows its own endpoints.
 */
import type { StoreKitExecutionContext } from "./cloudflare.js"
import { describeStoreKitConfig } from "./config.js"
import {
  createStoreKitHandler,
  type StoreKitHandlerOptions,
  type StoreKitWorkerEnv
} from "./router.js"

/* eslint-disable no-unused-vars -- Structural callback signatures name parameters only for typing. */

export interface StoreKitWorkerOptions<
  TEnv extends StoreKitWorkerEnv = StoreKitWorkerEnv
> extends StoreKitHandlerOptions<TEnv> {
  /**
   * Path serving a configuration report: which variables and secrets are present, never a value.
   * Defaults to `/storekit/health`; pass `false` to not serve it.
   */
  healthPath?: string | false | undefined
  /** Everything the package does not route. Returning `null` answers 404. */
  fetch?:
    | ((
        _request: Request,
        _env: TEnv,
        _ctx: StoreKitExecutionContext
      ) => Promise<Response | null> | Response | null)
    | undefined
}

export interface StoreKitWorker<TEnv extends StoreKitWorkerEnv = StoreKitWorkerEnv> {
  fetch: (_request: Request, _env: TEnv, _ctx: StoreKitExecutionContext) => Promise<Response>
}

/* eslint-enable no-unused-vars */

const DEFAULT_HEALTH_PATH = "/storekit/health"

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  })
}

export function createStoreKitWorker<TEnv extends StoreKitWorkerEnv = StoreKitWorkerEnv>(
  options: StoreKitWorkerOptions<TEnv>
): StoreKitWorker<TEnv> {
  const storekit = createStoreKitHandler<TEnv>(options)
  const healthPath = options.healthPath === undefined ? DEFAULT_HEALTH_PATH : options.healthPath

  return {
    async fetch(request, env, ctx) {
      if (healthPath && request.method === "GET" && new URL(request.url).pathname === healthPath) {
        const report = describeStoreKitConfig(env)
        return json({ ok: report.valid, storekit: report }, report.valid ? 200 : 503)
      }

      const handled = await storekit.fetch(request, env, ctx)
      if (handled) return handled

      const fallback = await options.fetch?.(request, env, ctx)
      return fallback ?? json({ code: "NOT_FOUND", message: "Not found." }, 404)
    }
  }
}
