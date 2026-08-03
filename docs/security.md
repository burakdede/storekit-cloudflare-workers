# Security model

## Trust boundaries

The iOS client is untrusted. It may submit Apple-signed transaction material, but it does not choose
the installation identity, product entitlement, expiry, or account binding. The Worker verifies the
JWS and derives entitlement from verified Apple claims.

The notification endpoint is not authenticated by your user session. Its trust boundary is Apple’s
signed notification JWS and the verifier’s bundle/environment checks. Keep it separate from routes
that accept installation identity.

## Required host integration

Implement `src/auth.ts` with your real authentication. The returned principal must be derived from a
verified credential and contain:

```ts
{
  installationId: string
  appBundleId: string
  appAccountToken?: string
}
```

The reference adapter returns `null` by design. It must not be replaced with a header-only or body-only
identity shortcut.

## Operational rules

- Keep App Store Connect credentials in Wrangler secrets.
- Do not log signed JWS values, API bearer tokens, private keys, or certificate material.
- Use a closed product allow-list; adding a product is a deliberate deploy/configuration change.
- Use `STOREKIT_ALLOW_APPLE_LOOKUP_FALLBACK=false` when stale signed state is unacceptable.
- Treat D1 notification UUID uniqueness as an idempotency boundary.
- Return a failure status when persistence fails so Apple can retry the notification.
- Restrict CORS, rate limits, and request authentication in the host Worker as appropriate.
- Keep production and sandbox D1 data and credentials separated.
