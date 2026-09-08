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

  // Where your application reacts to a subscription changing: a renewal, an expiry, a refund, a
  // grace period starting. Storing the entitlement is the package's job; acting on it is yours.
  //
  // It fires only when the entitlement actually changed, so a client re-syncing at every launch and
  // a notification Apple redelivered both fire nothing. Throwing here is reported to `onEvent` and
  // never fails the response, because the write has already committed.
  onEntitlementChange: async ({ accountId, next, changed, source }) => {
    console.log(
      JSON.stringify({
        event: "entitlement_changed",
        accountId,
        source,
        changed,
        status: next.status,
        proActive: next.proActive
      })
    )

    // A real integration mirrors the tier onto its own tables here, and prompts a payment update
    // when a renewal has failed but access continues:
    //
    //   await mirrorTierOntoUser(accountId, next.proActive)
    //   if (changed.includes("status") && next.status === "grace_period") {
    //     await sendPaymentUpdatePush(accountId)
    //   }
  },

  onEvent: (event) => console.log(JSON.stringify(event))
})
