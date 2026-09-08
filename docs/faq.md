# FAQ

## Getting started

### How do I validate StoreKit 2 purchases on Cloudflare Workers?

Post the Apple-signed `jwsRepresentation` from your app to a Worker that verifies the signature and
Apple certificate chain, checks bundle id, environment, and product, re-reads the transaction from
Apple's App Store Server API, and stores the result. That is what this package does:

```bash
npm install storekit-cloudflare-workers
npx storekit-cloudflare-workers init
```

```ts
import { createStoreKitWorker } from "storekit-cloudflare-workers"

export default createStoreKitWorker<Env>({ authenticate })
```

Full walkthrough in the [README](../README.md#setup).

### Do I need `nodejs_compat`?

Yes. Apple's `@apple/app-store-server-library` uses Node built-ins, so your `wrangler.jsonc` needs:

```jsonc
"compatibility_flags": ["nodejs_compat"]
```

Without it the Worker fails to build. Nothing else about the package requires it.

### Can I use it with Hono, itty-router, or my own router?

Yes. `createStoreKitHandler(...).fetch` returns `null` for paths it does not own, so it composes
with anything:

```ts
app.all(
  "/storekit/*",
  async (c) => (await storekit.fetch(c.req.raw, c.env, c.executionCtx)) ?? c.notFound()
)
```

Or mount it under your existing prefix with `paths: { sync: "/api/v1/iap/sync" }`.

### Does it work with Cloudflare Pages Functions, or only Workers?

Anything that gives you a `fetch(request, env, ctx)` and a D1 binding works, Pages Functions
included. The package never touches Worker-only globals.

### Can I use Postgres / KV / Durable Objects instead of D1?

The bundled persistence is D1. The service layer takes a database argument rather than reading
`env`, and the policy kernel (`storekit-cloudflare-workers/entitlement`) is pure, so you can call
`verifyStoreKitTransaction` + `resolveStoreKitEntitlementCore` and write the snapshot wherever you
like. You would be reimplementing the out-of-order write guard and the notification replay ledger,
so read [operations.md](operations.md#out-of-order-delivery) first.

### Do I have to copy the SQL into my repo?

No. The migration ships inside the package:

```jsonc
"migrations_dir": "node_modules/storekit-cloudflare-workers/migrations"
```

Or run `npx storekit-cloudflare-workers init` to copy it into your own `migrations/`.

---

## Behaviour

### What is the difference between `expiresAt` and `accessExpiresAt`?

`expiresAt` is the subscription's own expiry. `accessExpiresAt` is when access actually lapses:
normally the same, but during a **billing grace period** `expiresAt` is already in the past while
Apple keeps serving the customer, and for a non-consumable there is no deadline at all.

**Gate features on `proActive` or `accessExpiresAt`.** Gating on `expiresAt` locks out paying
customers for the entire grace window — the single most expensive server-side StoreKit bug.

### Why does a customer in a grace period still have access?

Because Apple intends them to: the payment failed, Apple is retrying, and the customer has not
churned. `STOREKIT_ALLOW_GRACE_PERIOD_ACCESS` (default `true`) controls it, and the status is
reported as `grace_period` so your UI can prompt for a payment update while access continues.

### Why is a paid introductory offer not reported as a trial?

Apple's `offerType === 1` covers free trials **and** paid pay-up-front and pay-as-you-go offers. The
distinction lives in `offerDiscountType`, which is what `isTrial` reads. Keying on `offerType` marks
paying customers as trialists and skews every conversion number you report.

### How are refunds handled? A refund arrived after a renewal.

`REFUND` notifications carry no subscription `status`, so a handler that switches on `data.status`
never revokes anything. This package keys on `revocationDate` instead, and revocations bypass the
out-of-order write guard, because a refund is terminal and monotonic — it must land even when Apple
signed it before the renewal it supersedes.

### A customer's access ended but nobody was refunded. Why does it say `family_revoked`?

Because that is what happened. Apple's subscription status 5 covers both a refund and Family Sharing
ending, and `revocationType` is the field that separates them:

| `revocationType`  | Status           | Money moved                              |
| ----------------- | ---------------- | ---------------------------------------- |
| `REFUND_FULL`     | `refunded`       | yes, in full                             |
| `REFUND_PRORATED` | `refunded`       | yes, in part; see `revocationPercentage` |
| `FAMILY_REVOKE`   | `family_revoked` | no                                       |

All three end access to that transaction, so the distinction is for reporting rather than for
gating. Counting a family revoke as a refund puts a refund that never happened into your dashboard,
and the organiser's subscription is meanwhile alive and still being paid for.

`revocationPercentage` is in **milliunits**: `100000` is 100%, `40000` is 40%.

### A customer upgraded their subscription. Why would the server report the old product?

It will not, and `isUpgraded` is why. Apple cancels the old subscription to move a customer onto the
new one and marks the cancelled transaction `isUpgraded: true`. A superseded transaction is excluded
from entitlement selection, so the replacement is what gets reported.

This matters because ranking candidates by expiry alone can pick the wrong one: an upgraded monthly
transaction can carry a later `expiresDate` than the annual subscription that replaced it. The
failure is quiet — access works, and only the product name is wrong — which is why it survives
testing.

If a superseded transaction is the only one available, the status is `upgraded` rather than
`expired`. The customer did not churn; the view is stale, and the replacement is what to go and look
for.

### What happens when notifications arrive out of order?

Writes are guarded on Apple's **signing time**, not your server clock. A `DID_RENEW` that Apple
retries for two days cannot overwrite the `EXPIRED` that legitimately followed it. Guarding on the
server clock instead is the classic version of this bug: the late delivery has the newer clock
reading.

### Are duplicate notifications a problem?

No. Every notification UUID goes into a replay ledger, written in the same atomic D1 batch as the
projection. A redelivery answers `200` with `replayed: true` and writes nothing twice.

### Does it handle Family Sharing?

Yes. Apple marks each transaction `PURCHASED` or `FAMILY_SHARED`, and the snapshot reports which
through `inAppOwnershipType`.

A family-shared purchase grants access by default, because that is what Family Sharing is for. Set
`STOREKIT_ALLOW_FAMILY_SHARING=false` for a genuinely per-seat product; excluded members then resolve
as `status: "family_shared"` with `proActive: false`. Use the field rather than the flag for
reporting — counting five family members as five subscribers is the mistake it exists to prevent.

### Do non-consumables (lifetime unlocks) work?

Yes, and they never expire. A non-consumable has no `expiresDate`; treating a missing expiry as
"expired" revokes every lifetime purchase. Those resolve as `perpetual: true` with a null
`accessExpiresAt`.

### Can it serve sandbox and production at the same time?

Yes. `STOREKIT_ALLOWED_ENVIRONMENTS` accepts both, and each environment gets its own verifier and
Apple client. Rows are keyed by environment, so a sandbox purchase can never satisfy a production
read. Production deployments should normally list `Production` alone.

### What if Apple's API is down when a customer syncs?

`STOREKIT_ALLOW_APPLE_LOOKUP_FALLBACK` decides: `false` (the default) denies the sync, `true` falls
back to the already signature-verified claims in the submitted JWS. The trade-off is written up in
[configuration.md](configuration.md#storekit_allow_apple_lookup_fallback).

### How does my app find out when a subscription changes?

`onEntitlementChange`. The package stores the entitlement; the hook is how your application learns
about it — a refund arriving, a renewal, a grace period starting, a subscription lapsing.

```ts
createStoreKitWorker<Env>({
  authenticate,
  onEntitlementChange: async ({ accountId, next, changed }) => {
    await mirrorTierOntoUser(accountId, next.proActive)
    if (changed.includes("status") && next.status === "grace_period") {
      await promptForPaymentUpdate(accountId)
    }
  }
})
```

It fires only when the entitlement genuinely changed, so a client re-syncing at every launch and a
notification Apple redelivered both fire nothing. A hook that throws is logged to `onEvent` and never
fails the response — the write already committed, and answering non-2xx would make Apple redeliver a
notification that was in fact processed.

Full field list in [api.md](api.md#onentitlementchange).

### I missed notifications during an outage. How do I recover?

Replay them from Apple's notification history, which is retained for six months, through
`getStoreKitNotificationHistory`. Step-by-step in
[operations.md](operations.md#recovering-from-a-webhook-outage).

---

## Security

### Why do I have to implement `authenticate` myself?

Because a StoreKit transaction proves _that a purchase happened_, never _who it belongs to_. Only
your app knows that. It ships returning `null`, so every authenticated route answers `401` until you
implement it — failing closed is deliberate.

### Can I authenticate with an installation id or device id header?

No. Anyone can send one and claim another customer's subscription. Identity must come from a
credential you verify: a session token, JWT, or API key. See
[security.md](security.md#replay-and-account-takeover).

### How do I stop a purchase being replayed onto another account?

Two things, and the first needs no configuration.

**The binding is sticky.** The first account to sync a transaction owns its entitlement. A sync from
any other account is refused with `409 OWNERSHIP_CONFLICT` and writes nothing, so the paying customer
keeps their access even if their signed transaction leaks.

**Pin `appAccountToken`.** Pass it at purchase in the app and return it as `expectedAppAccountToken`
from `authenticate`. The transaction is then refused unless Apple's signed token matches the account
making the request. This additionally covers the case sticky binding cannot: an attacker who syncs
_before_ the real customer ever does.

### A customer changed accounts and cannot restore their purchase. What now?

That is the `409` above doing its job — their purchase is bound to the old account. Move it
deliberately rather than loosening the rule globally: verify the customer through your own support
flow, then run the sync once with `allowAccountTransfer: true`. Leaving
`STOREKIT_ALLOW_ACCOUNT_TRANSFER=true` on permanently means any leaked transaction can take a
customer's subscription away, which is the behaviour the default exists to prevent.

### Do I need to protect the notification webhook with a secret?

No secret, and no bearer token — Apple authenticates itself with a JWS signature, so the webhook
must stay open to Apple. Put rate limiting or a WAF rule in front of it, and note that a payload
that fails verification is answered `401`, never `200`.

### Does anything sensitive end up in logs or responses?

No. Error responses never say which check rejected a payload, so probing teaches an attacker
nothing; the stage goes to your `onEvent` sink instead. `describeStoreKitConfig` reports secret
**presence**, never values. Full list in
[security.md](security.md#what-is-never-logged-or-returned).

---

## Scope and alternatives

### How is this different from RevenueCat, Adapty, or Glassfy?

Those are hosted services with dashboards, paywalls, and per-revenue pricing. This is a dependency
you run inside your own Worker: your D1 database, your Cloudflare account, no third party in the
purchase path, no revenue share, and no vendor holding your entitlement data. You give up the
dashboard and the cross-platform (Play Store) support.

### Does it support Google Play or Android?

No. Apple only.

### Does it support consumables?

Transactions verify, but crediting a consumable balance is app-specific (coins, credits, lives), so
no ledger is bundled. `sendStoreKitConsumptionInformation` is available for answering Apple's
`CONSUMPTION_REQUEST` during refund enquiries.

### Does it support StoreKit 1 receipts or V1 notifications?

No. StoreKit 2 signed transactions and App Store Server Notifications **V2** only. If you still
have `verifyReceipt` clients, migrate them first — Apple has deprecated that endpoint.

### What about app-transaction verification, or the Advanced Commerce API?

Not covered. See [Scope](../README.md#scope) for the complete list of what is and is not included.

### Is OCSP certificate revocation checked?

No. Apple's SDK OCSP path calls `Response.buffer()`, which the Workers runtime does not provide.
Signature verification and full certificate chain validation are unaffected;
[security.md](security.md#offline-certificate-verification) explains the residual risk.

---

## Operations

### How do I know my configuration is right before a customer hits it?

`createStoreKitWorker` serves `GET /storekit/health`, which runs `describeStoreKitConfig` and lists
**every** problem at once with secret presence but no values. Mounting the handler yourself? Call
`describeStoreKitConfig(env)` from your own health route.

### How do I test the webhook end to end?

`await requestStoreKitTestNotification(env)` asks Apple to deliver a real notification to your
configured URL. If a row lands in `storekit_notifications`, the whole chain works.

### Which Apple credentials do I need, and where do they go?

Four secrets, set with `wrangler secret put`, never in `vars`: `APP_STORE_CONNECT_ISSUER_ID`,
`APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_PRIVATE_KEY` (the whole `.p8`), and
`APPLE_ROOT_CERTIFICATES_PEM`. Where each comes from, including converting Apple's roots to PEM, is
in [configuration.md](configuration.md#secrets).

### What does it cost to run?

Whatever your Worker and D1 usage costs. One sync is one Worker request plus one or two Apple API
calls and a small D1 batch; entitlement reads are a single indexed row read. There is no per-purchase
fee, because there is no third party.

### How do I upgrade the package safely?

The Apple SDK is pinned to an exact version, and a conformance suite asserts every Apple literal and
payload shape the policy depends on still matches the SDK. Read [CHANGELOG.md](../CHANGELOG.md), run
your own tests, and verify in sandbox before production — the
[release checklist](release-checklist.md#sandbox-verification-which-ci-cannot-replace) lists exactly
what to exercise.
