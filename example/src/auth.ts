/**
 * Replace this adapter with your application's authentication.
 *
 * This is the one piece the module cannot supply. A StoreKit transaction proves *that a purchase
 * happened*, never *who it belongs to*; only your app knows that. Resolve the caller here and
 * return the account the entitlement should bind to.
 *
 * It ships failing closed: until you implement it, every authenticated route answers 401. That is
 * deliberate. Never derive identity from a client-supplied header such as `X-Installation-Id`,
 * because anyone can send one and claim another customer's subscription.
 */
import type { StoreKitRequestContext } from "storekit-cloudflare-workers"

export async function authenticateStoreKitRequest(
  request: Request,
  env: Env
): Promise<StoreKitRequestContext | null> {
  void request
  void env

  // Example: replace with your own session/JWT/API-key verification:
  //
  //   const session = await verifySessionToken(request.headers.get("authorization"), env)
  //   if (!session) return null
  //   return {
  //     accountId: session.userId,
  //     // Pin the token your client passed to Product.purchase(options:). Without this, a signed
  //     // transaction can be replayed onto a different account.
  //     expectedAppAccountToken: session.appAccountToken,
  //     appBundleId: session.appBundleId
  //   }

  return null
}
