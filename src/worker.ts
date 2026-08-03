/**
 * Reference Worker.
 *
 * This is a complete, deployable example of the drop-in integration: the module owns routing,
 * Apple verification, entitlement policy, D1 persistence and HTTP status mapping, so the only
 * thing left here is deciding who the caller is.
 *
 * To adopt the module in an existing Worker, copy the `createStoreKitHandler` call below and the
 * `authenticate` adapter in `src/auth.ts`. Nothing else in this file is required.
 */
import { createStoreKitHandler, describeStoreKitConfig } from "./storekit"
import { authenticateStoreKitRequest } from "./auth"

// Generic over the Worker's own generated `Env`, so bindings keep their real types below.
const storekit = createStoreKitHandler<Env>({
  authenticate: authenticateStoreKitRequest,
  // Defaults to `env.STOREKIT_DB`; shown explicitly because renaming the binding is the most
  // common first change an adopter makes.
  database: (env) => env.STOREKIT_DB,
  onEvent: (event) => console.log(JSON.stringify(event))
})

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  })
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // Surface a misconfigured deployment here rather than at a customer's first purchase.
    // `describeStoreKitConfig` reports secret presence only, never a value.
    if (request.method === "GET" && url.pathname === "/health") {
      const report = describeStoreKitConfig(env)
      return json({ ok: report.valid, storekit: report }, report.valid ? 200 : 503)
    }

    const handled = await storekit.fetch(request, env, ctx)
    if (handled) return handled

    return json({ error: "not_found" }, 404)
  }
}

export { storekit }
