# Changelog

## 0.1.0

First release. Server-authoritative StoreKit 2 for Cloudflare Workers and D1.

### Entitlement engine

- Billing grace periods keep access. Apple only reports status 4 once a renewal has already failed,
  so the transaction's own `expiresDate` is in the past; the policy resolves a separate
  `accessExpiresAt` from the verified `gracePeriodExpiresDate`. Read paths judge access against it.
- Billing retry resolves to `billing_retry` rather than `expired`, so a client can prompt for a
  payment update.
- `isTrial` keys off `offerDiscountType`, not `offerType`, which also covers paid pay-up-front and
  pay-as-you-go introductory offers.
- Non-consumables resolve as `perpetual` instead of expiring for having no `expiresDate`.
- Renewal metadata is verified and projected: auto-renew status and product, expiration intent,
  billing retry, price increase status, renewal price and currency.

### Notifications

- Writes are guarded on Apple's signing time rather than the server clock, so a late-delivered older
  notification cannot rewind newer state. Revocations bypass the guard because a refund is terminal.
- Each notification re-reads `Get All Subscription Statuses` by default instead of trusting the
  payload, which is also what lets `REFUND` and `REVOKE` revoke access despite carrying no
  subscription `status`.
- The notification UUID replay ledger and the projection are written in one atomic D1 batch.

### Integration surface

- `createStoreKitHandler` mounts sync, entitlement read and the Apple webhook, and returns `null`
  for non-StoreKit paths so it composes with an existing router. Generic over the host's own `Env`.
- The persistence adapter takes a `D1Database` directly; the handler defaults to `env.STOREKIT_DB`
  and accepts a `database` resolver for any other binding name.
- Grace-period and reconciliation policy are read from Worker variables, so behaviour is configured
  in `wrangler.jsonc` rather than by editing source.
- `describeStoreKitConfig` / `assertStoreKitConfig` report every configuration problem at once and
  expose secret presence without secret values.
- Operational App Store Server API calls: test notifications, notification history, transaction and
  refund history, order lookup, renewal-date extension, and consumption information.

### Guarantees

- `src/storekit/` imports nothing outside its own directory except `@apple/app-store-server-library`,
  and a test enforces it, so the directory can be vendored into any Worker.
- `migrations/0001_storekit.sql` and `src/storekit/schema.sql` are kept byte-identical by a test.
- `src/auth.ts` fails closed by design.
