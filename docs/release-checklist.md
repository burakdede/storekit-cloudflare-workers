# Release checklist

## Publishing this repository

- [ ] Review the Apple contract links and the pinned `@apple/app-store-server-library` version.
- [ ] Confirm the trademark and non-affiliation notices are present in README.md and
      docs/apple-contract.md.
- [ ] Confirm the Wrangler `compatibility_date` and version are current.
- [ ] Run `npm ci`, `npm run cf:typegen`, and `npm run release:check`.
- [ ] Confirm no secrets, signed production transactions, or customer identifiers are tracked.
- [ ] Confirm `wrangler.jsonc` still contains only placeholder values (`com.example.app`, the
      all-zero database ID).
- [ ] Confirm `src/auth.ts` still fails closed.

## Adopting it in a deployment

- [ ] Implement and review `authenticate` before deploying. It must derive identity from a verified
      credential, never from a request header or body.
- [ ] Pin `expectedAppAccountToken` if your client sets `appAccountToken` on purchase.
- [ ] Set every secret with `wrangler secret put`; verify with `GET /health`.
- [ ] Decide `STOREKIT_ALLOW_APPLE_LOOKUP_FALLBACK` deliberately; see `docs/configuration.md`.
- [ ] Confirm `STOREKIT_ALLOWED_PRODUCT_IDS` lists exactly the products that should grant access.
- [ ] Confirm production allows only `Production`, and that any sandbox allowance is intentional.
- [ ] Apply the migration to a disposable D1 database first and inspect the tables and indexes.
- [ ] Configure the App Store Server Notifications **V2** URL and confirm delivery with
      `requestStoreKitTestNotification`.
- [ ] Put a rate limiting or WAF rule in front of the notification route.
- [ ] Verify the client gates access on `accessExpiresAt`, not `expiresAt`.
- [ ] Exercise the grace-period path in sandbox by forcing a billing failure from
      **Settings > Developer > Sandbox Apple Account**.
- [ ] Separate production and sandbox Worker environments, D1 databases, and credentials.
- [ ] Name the owner for reconciliation after a webhook outage.
