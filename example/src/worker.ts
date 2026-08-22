/**
 * Reference Worker: the whole integration, deployable as-is.
 *
 * The package owns routing, Apple verification, entitlement policy, D1 persistence and HTTP status
 * mapping, so the only thing left here is deciding who the caller is.
 *
 * Composing with an existing router instead? Use `createStoreKitHandler`, whose `fetch` returns
 * `null` for non-StoreKit paths — see the "Mounting inside an existing Worker" section of the
 * README.
 */
import { createStoreKitWorker } from "storekit-cloudflare-workers"
import { authenticateStoreKitRequest } from "./auth"

export default createStoreKitWorker<Env>({
  authenticate: authenticateStoreKitRequest,
  // Defaults to `env.STOREKIT_DB`; shown explicitly because renaming the binding is the most
  // common first change an adopter makes.
  database: (env) => env.STOREKIT_DB,
  onEvent: (event) => console.log(JSON.stringify(event))
})
