/**
 * Replace this adapter with the host application's authentication integration.
 *
 * StoreKit cannot determine which installation a transaction belongs to. The host must authenticate
 * the request and return its own installation/account identity before transaction sync is allowed.
 */
export interface StoreKitPrincipal {
  installationId: string
  appBundleId: string
  appAccountToken?: string
}

export async function authenticateStoreKitRequest(
  _request: Request,
  _env: Env
): Promise<StoreKitPrincipal | null> {
  // Deliberately fail closed. Do not replace this with a client-supplied installation header.
  return null
}
