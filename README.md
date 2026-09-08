# storekit-cloudflare-workers

[![npm](https://img.shields.io/npm/v/storekit-cloudflare-workers)](https://www.npmjs.com/package/storekit-cloudflare-workers)
[![CI](https://github.com/burakdede/storekit-cloudflare-workers/actions/workflows/ci.yml/badge.svg)](https://github.com/burakdede/storekit-cloudflare-workers/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/storekit-cloudflare-workers)](LICENSE)

**Server-side Apple StoreKit 2 subscription validation and entitlements for Cloudflare Workers and
D1** — in one npm package. Verifies Apple-signed JWS transactions against the App Store Server API,
resolves subscription entitlements (trials, billing grace periods, refunds, lifetime unlocks), and
handles App Store Server Notifications V2 idempotently. TypeScript, ESM, edge-native, no third-party
service in your purchase path.

> **Independent project.** Not affiliated with, endorsed by, or sponsored by Apple Inc. or
> Cloudflare, Inc. "StoreKit", "App Store" and "Apple" are trademarks of Apple Inc.; "Cloudflare",
> "Workers" and "D1" are trademarks of Cloudflare, Inc. They are used here only to describe what
> this software interoperates with.

Install one package, apply one migration, set four secrets, mount one handler. You get Apple JWS
verification, a correct entitlement engine, idempotent App Store Server Notifications V2, and the
operational Apple calls, without writing any of it yourself.

**Docs:** [Quick start](#setup) · [HTTP API](docs/http-api.md) · [TypeScript API](docs/api.md) ·
[iOS client](docs/ios-client.md) · [Configuration](docs/configuration.md) ·
[Security](docs/security.md) · [Operations](docs/operations.md) · [FAQ](docs/faq.md)

```bash
npm install storekit-cloudflare-workers
npx storekit-cloudflare-workers init   # migration, mount point, and the Wrangler config to paste
```

```ts
import { createStoreKitWorker } from "storekit-cloudflare-workers"

export default createStoreKitWorker<Env>({
  authenticate: async (request, env) => {
    const session = await mySessionFrom(request, env)
    return session ? { accountId: session.userId } : null
  }
})
```

That is a complete Worker. Already have one? Mount the handler instead, and keep your router:

```ts
import { createStoreKitHandler } from "storekit-cloudflare-workers"

const storekit = createStoreKitHandler<Env>({ authenticate })

export default {
  async fetch(request, env, ctx) {
    return (await storekit.fetch(request, env, ctx)) ?? myRoutes(request, env, ctx)
  }
}
```

`fetch` returns `null` for non-StoreKit paths, so it composes with whatever router you already
have.

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

**Possession of a signed transaction is not proof of ownership.** The JWS is held by the client and
ends up in debug logs and support tickets. The first account to sync a transaction keeps it; a sync
from anyone else answers `409` and writes nothing, so a leaked transaction cannot take a paying
customer's access away.

**An upgraded subscription can outrank the one that replaced it.** Apple marks the transaction it
cancelled with `isUpgraded`, and that transaction can carry a later `expiresDate` than its
replacement. Rank by expiry alone and the server reports the tier the customer upgraded away from —
with access working and only the product name wrong.

**`REVOKE` is not always a refund.** Apple's status 5 covers both a refund and Family Sharing ending.
`revocationType` separates them, and reporting a family revoke as `refunded` puts a refund that never
happened into your revenue reporting.

**One customer can hold more than one entitlement.** Two subscription groups, or a lifetime unlock
alongside a subscription, are concurrent. A read that returns one row makes the other invisible.

---

## What you get

- **Verification**: signature and Apple certificate chain, bundle ID, environment, closed product
  allow-list, transaction identity, and an Apple re-lookup whose response only replaces the client
  copy after its identity claims match.
- **Entitlement policy**: paid, free trial, grace period, billing retry, expired, revoked,
  refunded, family-revoked, upgraded, and perpetual, resolved from verified claims only. Pure and
  I/O-free, so you can test your tier rules against plain objects.
- **Family Sharing**: `inAppOwnershipType` on every entitlement, and a policy switch for per-seat
  products.
- **Subscription groups**: one entitlement per group, so an app selling two things is served both.
- **Renewal and commerce metadata**: renewal date, auto-renew status and product, expiration intent,
  billing retry, price increase status, price and currency, storefront, transaction reason, offer
  type and identifier, and win-back offer eligibility.
- **Persistence**: entitlement projection, transaction audit trail, and a notification replay
  ledger in D1, written in atomic batches.
- **A mountable handler**: sync, entitlement read, and the Apple webhook, with request validation
  and error mapping that never leaks which check rejected a payload.
- **A change hook**: `onEntitlementChange` fires when a refund, renewal, expiry or grace period
  actually changes the entitlement, so your app can mirror the tier, send the payment-failure push,
  or release resources.
- **Config validation**: every problem reported at once, secret presence without secret values.
- **Operational Apple calls**: test notifications, notification-history replay for outage
  recovery, transaction and refund history, order lookup, renewal-date extension, and consumption
  information for `CONSUMPTION_REQUEST`.

## What you supply

**Authentication.** A StoreKit transaction proves _that a purchase happened_, never _who it belongs
to_. Only your app knows that, so `authenticate` is yours to implement. It ships failing closed.

---

## How it fits together

```mermaid
flowchart LR
    ios["iOS app<br/>StoreKit 2"]

    subgraph worker["Your Cloudflare Worker"]
        auth["authenticate()<br/>you implement this"]
        lib["storekit-cloudflare-workers<br/>verify, resolve, persist"]
    end

    apple["Apple<br/>App Store Server API<br/>and Notifications V2"]
    d1[("Cloudflare D1")]

    ios -- "signed transaction JWS" --> lib
    lib -- "who is this caller?" --> auth
    lib <-->|"verify and reconcile"| apple
    apple -- "notification webhook" --> lib
    lib -- "entitlement projection" --> d1
    d1 -- "current entitlement" --> ios
```

Two arrows leave your side of the diagram: the client sends Apple-signed material, and
`authenticate` says who the caller is. Everything else is the module's job.

## Request flows

### A purchase

The standard StoreKit 2 integration. The client never sends product status, expiry, price, or a
premium flag; only the signed transaction, which the server re-verifies against Apple before
trusting a single claim in it.

```mermaid
sequenceDiagram
    autonumber
    participant App as iOS app
    participant SK as StoreKit 2
    participant W as Your Worker
    participant Apple as Apple servers
    participant D1 as D1

    App->>SK: product.purchase with appAccountToken
    SK->>Apple: process the payment
    Apple-->>SK: signed transaction
    SK-->>App: verified Transaction plus jwsRepresentation
    App->>W: POST /storekit/transactions/sync
    Note over W: authenticate() resolves the account.<br/>Nothing the client claims is trusted.
    W->>W: Verify JWS signature and Apple certificate chain
    W->>W: Check bundle id, environment, product allow-list
    W->>Apple: Get Transaction Info
    Apple-->>W: Apple-signed copy, replaces the client one
    W->>Apple: Get All Subscription Statuses
    Apple-->>W: status plus signedRenewalInfo
    Note over W: Grace period resolves against<br/>gracePeriodExpiresDate, not the elapsed expiresDate.
    W->>D1: Upsert projection and audit row in one batch
    W-->>App: entitlement snapshot
    App->>SK: transaction.finish()
```

Finish the transaction only after the server confirms, or a network failure drops the purchase from
the client queue before the backend recorded it.

### A renewal, cancellation, or refund

Apple pushes these; the customer is not in the app when they happen. This is what keeps the
projection true between syncs.

```mermaid
sequenceDiagram
    autonumber
    participant Apple as Apple
    participant W as Your Worker
    participant D1 as D1

    Apple->>W: POST /storekit/notifications
    W->>W: Verify JWS. Apple signs it, there is no bearer token.
    alt notificationUUID already in the replay ledger
        W-->>Apple: 200 processed, replayed
    else new notification
        W->>Apple: Get All Subscription Statuses
        Apple-->>W: current status and renewal info
        Note over W: Reconciles against Apple rather than trusting<br/>a payload that may arrive late or out of order.
        W->>D1: Upsert guarded by Apple signing time
        Note over D1: A late older event cannot rewind newer state.<br/>Revocations always land.
        W-->>Apple: 200 processed
    end
```

### Reading the entitlement

```mermaid
sequenceDiagram
    participant App as iOS app
    participant W as Your Worker
    participant D1 as D1

    App->>W: GET /storekit/entitlement
    W->>D1: Read the projection for this account
    D1-->>W: stored row
    Note over W: Expiry is re-evaluated at read time against<br/>accessExpiresAt, never a stored boolean.
    W-->>App: proActive, status, accessExpiresAt
```

---

## Setup

### 1. Install

```bash
npm install storekit-cloudflare-workers
npx storekit-cloudflare-workers init
```

`init` copies the D1 migration into `migrations/`, writes `src/storekit.ts` with the one adapter
the package cannot supply, and prints the Wrangler block and secret commands below. It never edits
a file that already exists, so it is safe to re-run.

The package is ESM-only, ships its own types, and depends on nothing but Apple's
`@apple/app-store-server-library`, which is why `nodejs_compat` is required below.

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
  "d1_databases": [
    {
      "binding": "STOREKIT_DB",
      "database_name": "storekit",
      "database_id": "...",
      "migrations_dir": "migrations"
    }
  ]
}
```

Using a different binding name? Pass it through: `database: (env) => env.MY_DB`.

### 3. Create the tables

```bash
npx wrangler d1 create storekit          # copy the id into wrangler.jsonc
npx wrangler d1 migrations apply STOREKIT_DB --local
npx wrangler d1 migrations apply STOREKIT_DB --remote
```

Would rather not vendor the SQL at all? Point Wrangler at the copy inside `node_modules` and skip
`init`'s migration step with `--no-migrations`:

```jsonc
"migrations_dir": "node_modules/storekit-cloudflare-workers/migrations"
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
npx wrangler deploy
```

Check `GET /storekit/health`, which `createStoreKitWorker` serves: it runs `describeStoreKitConfig`
and lists every configuration problem, reporting which secrets are present without ever revealing a
value. Mounting the handler yourself instead? Call `describeStoreKitConfig(env)` from your own
health route.

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

`GET /storekit/entitlement` answers with the single best entitlement at the top level — all a
one-product app needs — plus an `entitlements` array with one entry per subscription group. Read the
array if you sell more than one thing.

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

| Document                                          | Contents                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| [http-api.md](docs/http-api.md)                   | Every route, request and response body, error codes, field meanings |
| [api.md](docs/api.md)                             | Every TypeScript export, option, and returned type                  |
| [ios-client.md](docs/ios-client.md)               | Swift integration: purchase, restore, updates, gating access        |
| [configuration.md](docs/configuration.md)         | Every variable and secret, where to get it, trade-offs              |
| [security.md](docs/security.md)                   | Trust boundaries and the full verification chain                    |
| [operations.md](docs/operations.md)               | Webhook behaviour, outage recovery, troubleshooting                 |
| [faq.md](docs/faq.md)                             | Common questions, gotchas, and how this compares to hosted services |
| [apple-contract.md](docs/apple-contract.md)       | Apple references and how this maps to them                          |
| [release-checklist.md](docs/release-checklist.md) | Pre-release verification for this package                           |
| [`example/`](example)                             | A deployable Worker using the package as published                  |

## Common questions

- **[Do I need `nodejs_compat`?](docs/faq.md#do-i-need-nodejs_compat)** Yes — Apple's library uses
  Node built-ins.
- **[What is the difference between `expiresAt` and `accessExpiresAt`?](docs/faq.md#what-is-the-difference-between-expiresat-and-accessexpiresat)**
  Gate on `accessExpiresAt`; `expiresAt` is already in the past during a grace period.
- **[Can I use it with Hono or my own router?](docs/faq.md#can-i-use-it-with-hono-itty-router-or-my-own-router)**
  Yes, `fetch` returns `null` for paths it does not own.
- **[How is this different from RevenueCat or Adapty?](docs/faq.md#how-is-this-different-from-revenuecat-adapty-or-glassfy)**
  No third party in the purchase path, no revenue share, your own D1.
- **[Why do I implement `authenticate` myself?](docs/faq.md#why-do-i-have-to-implement-authenticate-myself)**
  A transaction proves a purchase happened, never who it belongs to.

The rest are in the [FAQ](docs/faq.md).

## Scope

**Covered:** auto-renewable subscriptions, non-consumables, multiple subscription groups, Family
Sharing, subscription upgrades, refunds and revocations (full, prorated and family), billing grace
periods and retry, introductory/promotional/offer-code/win-back offers, renewal and commerce
metadata, App Store Server Notifications V2 including transaction-less events, and both Apple
environments simultaneously.

**Not covered:** consumable balance ledgers (crediting is app-specific), app-transaction
verification, OCSP revocation checking (Apple's SDK OCSP path calls `Response.buffer()`, which the
Workers runtime does not provide; signature and chain validation are unaffected), the Advanced
Commerce API, StoreKit 1 receipts, and V1 notifications.

## How this stays correct against Apple

The Apple SDK is pinned to an exact version, and
`test/unit/storekit-apple-sdk-conformance.test.ts` keeps that pin honest. It asserts every Apple
literal the policy compares against (`"FREE_TRIAL"`, `"Non-Consumable"`, offer type `1`, status `1`
to `5`) is still equal to the SDK's own exported enum, pins the payload shapes at the type level so
a renamed field fails `typecheck`, and runs Apple's real `SignedDataVerifier` under
`Environment.LOCAL_TESTING` so decoding is exercised for real rather than stubbed.

Signature and certificate chain verification are tested separately, in `storekit-jws-verification.test.ts`,
by running the verifier in `SANDBOX` mode — where nothing is skipped — against a purpose-built
certificate authority. A payload rooted in a different CA, a leaf the intermediate never signed, a
missing Apple marker OID, an expired chain, a tampered body and a wrong bundle are each rejected, and
each assertion pins the SDK's `VerificationStatus` rather than merely expecting a throw.

That matters because TypeScript cannot catch a literal that stops matching an enum: both sides stay
strings and numbers. Without those assertions an SDK bump could misclassify every trial as paid, or
revoke every lifetime purchase, with a green suite.

CI runs on every pull request, on `main`, and weekly. Dependabot raises SDK bumps as pull requests
that must pass the conformance suite, and a separate advisory job runs that suite against
`@apple/app-store-server-library@latest` so a breaking Apple release is visible before the bump
arrives.

**What this does not prove:** that your `APPLE_ROOT_CERTIFICATES_PEM` holds Apple's real roots (the
suite supplies its own), OCSP revocation checking (disabled under Workers), and anything about
Apple's live servers. CI proves this module still agrees with the Apple SDK; it does not prove the
SDK still agrees with Apple. Sandbox testing before release is not optional. The full breakdown is in
[docs/apple-contract.md](docs/apple-contract.md#what-is-not-verified-here).

## Package layout

- `src/` is the package. It imports nothing but Apple's SDK: no host helpers and no ambient
  Cloudflare globals, so it typechecks in any Worker regardless of how that Worker names its
  bindings or generates its types. Tests enforce both boundaries.
- `example/` is a deployable Worker that consumes the package by its published name.
- `migrations/` is the D1 schema, shipped in the tarball so Wrangler can apply it from
  `node_modules`.

Subpath `storekit-cloudflare-workers/entitlement` is the pure policy kernel on its own, for hosts
that want the rules without the Apple SDK or D1.

## Development

```bash
npm install
npm run cf:typegen      # regenerates worker-configuration.d.ts for example/
npm run release:check   # format, lint, typecheck, tests, build, pack, and a Worker dry-run build
```

Tests use injectable verifier boundaries and a D1 fake; no Apple keys or production transactions are
in this repository.

## Contributing

Bug reports and pull requests are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the
workflow, and please read the reporting guidance below before opening an issue.

## Reporting a bug

Open a [GitHub issue](../../issues/new/choose) using the bug template. A useful report includes:

- What you expected to happen and what happened instead.
- The `verificationStage` from your `onEvent` sink, if verification failed. The HTTP response
  deliberately omits it.
- The output of `describeStoreKitConfig(env)`, which reports secret **presence** only.
- Your `STOREKIT_ALLOWED_ENVIRONMENTS`, product allow-list shape, and Wrangler
  `compatibility_date`.
- Whether it reproduces in sandbox, production, or both.

**Never paste** a signed transaction or notification payload, an App Store Connect private key, an
Apple bearer token, or a customer identifier. Those are credentials and personal data. Redact them;
the stage and operation names are enough to diagnose almost everything.

For a suspected vulnerability or a credential exposure, do **not** open a public issue. Follow
[`SECURITY.md`](SECURITY.md).

## License

MIT. See [`LICENSE`](LICENSE).

## Trademarks

This project is independent and is not affiliated with, endorsed by, or sponsored by Apple Inc. or
Cloudflare, Inc.

Apple, App Store, StoreKit, and TestFlight are trademarks of Apple Inc., registered in the U.S. and
other countries. Cloudflare, Cloudflare Workers, and D1 are trademarks of Cloudflare, Inc. All
other trademarks are the property of their respective owners.

These names are used solely to identify the services this software interoperates with, as nominative
fair use. No claim of ownership or endorsement is made or implied.
