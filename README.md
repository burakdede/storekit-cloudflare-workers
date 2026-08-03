# cf-worker-storekit2

Drop-in, server-authoritative **StoreKit 2** for **Cloudflare Workers + D1**.

Copy one directory, apply one schema, set four secrets, mount one handler. You get Apple JWS
verification, a correct entitlement engine, idempotent App Store Server Notifications V2, and the
operational Apple calls, without writing any of it yourself.

```ts
import { createStoreKitHandler } from "./storekit"

const storekit = createStoreKitHandler<Env>({
  authenticate: async (request, env) => {
    const session = await mySessionFrom(request, env)
    return session ? { accountId: session.userId } : null
  }
})

export default {
  async fetch(request, env, ctx) {
    return (await storekit.fetch(request, env, ctx)) ?? myRoutes(request, env, ctx)
  }
}
```

That's the whole integration. `fetch` returns `null` for non-StoreKit paths, so it composes with
whatever router you already have.

---

## Why this exists

Server-side StoreKit has a handful of details that are easy to get wrong and expensive when you do.
This module gets them right, and the tests say so:

**A billing grace period does not mean "expired."** When a renewal fails, Apple keeps serving the
customer while it retries the payment, but the transaction's own `expiresDate` is already in the
past. Judge access on `expiresDate` and you cut off paying customers for the entire grace period.
This module resolves a separate `accessExpiresAt` from the verified `gracePeriodExpiresDate`.

**A free trial is not the same as an introductory offer.** `offerType === 1` also covers _paid_
pay-up-front and pay-as-you-go offers. Trials key off `offerDiscountType`.

**Notifications arrive out of order.** Apple does not guarantee delivery order and retries failed
deliveries for days. A late `DID_RENEW` landing after an `EXPIRED` will rewind your state unless
writes are guarded, and guarded on _Apple's_ signing time, because a late-arriving old event has a
newer server clock reading. Revocations bypass the guard, because a refund is terminal.

**`REFUND` carries no subscription status.** Handlers that only act on `data.status` never revoke
access on a refund.

**Non-consumables have no `expiresDate`.** Treating a missing expiry as expired revokes every
lifetime unlock.

---

## What you get

- **Verification**: signature and Apple certificate chain, bundle ID, environment, closed product
  allow-list, transaction identity, and an Apple re-lookup whose response only replaces the client
  copy after its identity claims match.
- **Entitlement policy**: paid, free trial, grace period, billing retry, expired, revoked,
  refunded, and perpetual, resolved from verified claims only. Pure and I/O-free, so you can test
  your tier rules against plain objects.
- **Renewal metadata**: auto-renew status and product, expiration intent, billing retry, price
  increase status, renewal price and currency.
- **Persistence**: entitlement projection, transaction audit trail, and a notification replay
  ledger in D1, written in atomic batches.
- **A mountable handler**: sync, entitlement read, and the Apple webhook, with request validation
  and error mapping that never leaks which check rejected a payload.
- **Config validation**: every problem reported at once, secret presence without secret values.
- **Operational Apple calls**: test notifications, notification-history replay for outage
  recovery, transaction and refund history, order lookup, renewal-date extension, and consumption
  information for `CONSUMPTION_REQUEST`.

## What you supply

**Authentication.** A StoreKit transaction proves _that a purchase happened_, never _who it belongs
to_. Only your app knows that, so `authenticate` is yours to implement. It ships failing closed.

---

## Setup

### 1. Get the code

Either clone this repository as a standalone Worker, or vendor the module into an existing one:

```bash
cp -r src/storekit /path/to/your-worker/src/
npm install @apple/app-store-server-library
```

The directory imports nothing outside itself except the Apple library; a test enforces that, so it
stays copyable.

### 2. Configure Wrangler

```jsonc
{
  "compatibility_date": "2026-08-03",
  "compatibility_flags": ["nodejs_compat"], // required: the Apple library needs Node built-ins
  "vars": {
    "STOREKIT_ALLOWED_ENVIRONMENTS": "Production",
    "STOREKIT_BUNDLE_ID": "com.example.app",
    "STOREKIT_ALLOWED_PRODUCT_IDS": "com.example.app.pro.monthly",
    "APP_STORE_APP_APPLE_ID": "1234567890"
  },
  "d1_databases": [{ "binding": "STOREKIT_DB", "database_name": "...", "database_id": "..." }]
}
```

Using a different binding name? Pass it through: `database: (env) => env.MY_DB`.

### 3. Create the tables

```bash
npx wrangler d1 create cf-worker-storekit2   # copy the id into wrangler.jsonc
npm run db:migrate:remote                    # or: wrangler d1 execute <DB> --file=src/storekit/schema.sql
```

### 4. Set the Apple secrets

```bash
npx wrangler secret put APP_STORE_CONNECT_ISSUER_ID
npx wrangler secret put APP_STORE_CONNECT_KEY_ID
npx wrangler secret put APP_STORE_CONNECT_PRIVATE_KEY   # the whole .p8, BEGIN/END lines included
npx wrangler secret put APPLE_ROOT_CERTIFICATES_PEM     # concatenated Apple roots
```

Where each value comes from, and how to convert Apple's root certificates to PEM, is in
[`docs/configuration.md`](docs/configuration.md).

### 5. Implement `authenticate`, then deploy

```bash
npm run release:check && npm run deploy
```

Check `GET /health`: it runs `describeStoreKitConfig` and lists every configuration problem,
reporting which secrets are present without ever revealing a value.

### 6. Point Apple at the webhook

In App Store Connect > your app > **App Information > App Store Server Notifications**, set the
**Version 2** URL to `https://your-worker.example.com/storekit/notifications`. Then prove it works:

```ts
await requestStoreKitTestNotification(env)
```

---

## Routes

| Method | Path                          | Authentication        |
| ------ | ----------------------------- | --------------------- |
| `POST` | `/storekit/transactions/sync` | your `authenticate`   |
| `GET`  | `/storekit/entitlement`       | your `authenticate`   |
| `POST` | `/storekit/notifications`     | Apple's JWS signature |

Override any path via `paths: { sync: "/api/v1/iap/sync" }`.

## The iOS side

Send only Apple-signed material. The server ignores any client-asserted status, expiry, price, or
premium flag.

```swift
for await result in Transaction.updates {
    guard case .verified(let transaction) = result else { continue }
    try await api.post("/storekit/transactions/sync", [
        "signedTransactionJWS": result.jwsRepresentation
    ])
    await transaction.finish()
}
```

Call sync after purchase, after restore, on `Transaction.updates`, and at launch. Gate features on
**`accessExpiresAt`**, not `expiresAt`.

Setting `appAccountToken` on `Product.purchase` and pinning it via `expectedAppAccountToken` in
`authenticate` is what stops a signed transaction being replayed onto another account.

---

## Beyond the bundled routes

The service layer has no HTTP dependency, so a GraphQL API, Durable Object or queue consumer can
call it directly:

```ts
const { snapshot } = await syncStoreKitTransaction(
  {
    signedTransactionJWS,
    installationId: userId,
    appBundleId,
    expectedAppAccountToken
  },
  { apple: env, d1: env.STOREKIT_DB }
)
```

And `resolveStoreKitEntitlementCore` is the pure policy kernel: no Apple SDK, no D1, no HTTP.

---

## Documentation

| Document                                          | Contents                                               |
| ------------------------------------------------- | ------------------------------------------------------ |
| [configuration.md](docs/configuration.md)         | Every variable and secret, where to get it, trade-offs |
| [security.md](docs/security.md)                   | Trust boundaries and the full verification chain       |
| [operations.md](docs/operations.md)               | Webhook behaviour, outage recovery, troubleshooting    |
| [apple-contract.md](docs/apple-contract.md)       | Apple references and how this maps to them             |
| [release-checklist.md](docs/release-checklist.md) | Pre-deployment verification                            |

## Scope

**Covered:** auto-renewable subscriptions, non-consumables, refunds and revocations, billing grace
periods and retry, introductory/promotional offers, renewal metadata, App Store Server Notifications
V2 including transaction-less events, and both Apple environments simultaneously.

**Not covered:** consumable balance ledgers (crediting is app-specific), app-transaction
verification, OCSP revocation checking (Apple's SDK OCSP path calls `Response.buffer()`, which the
Workers runtime does not provide; signature and chain validation are unaffected), the Advanced
Commerce API, StoreKit 1 receipts, and V1 notifications.

## Development

```bash
npm install
npm run release:check   # format, lint, typecheck, tests, and a Worker dry-run build
```

Tests use injectable verifier boundaries and a D1 fake; no Apple keys or production transactions are
in this repository.

## License

MIT. See [`LICENSE`](LICENSE).
