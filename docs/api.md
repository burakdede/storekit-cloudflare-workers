# TypeScript API reference

Everything the package exports, grouped by the layer you are likely to be working at. Types ship
with the package; nothing here needs `@types/*`.

```ts
import { createStoreKitWorker } from "storekit-cloudflare-workers"
```

- [Mounting](#mounting) — `createStoreKitWorker`, `createStoreKitHandler`
- [Service layer](#service-layer) — verify, persist, and read without HTTP
- [Entitlement policy](#entitlement-policy) — the pure kernel
- [Verification](#verification) — Apple JWS and the App Store Server API client
- [Persistence](#persistence) — the D1 adapter
- [Configuration](#configuration) — reading and validating `env`
- [App Store Server API](#app-store-server-api) — operational calls
- [Errors](#errors)
- [Runtime types](#runtime-types)

---

## Mounting

### `createStoreKitWorker(options)`

A complete Worker in one export: the StoreKit routes, a `GET /storekit/health` configuration
report, and a fallback for everything else.

```ts
export default createStoreKitWorker<Env>({
  authenticate,
  fetch: (request, env, ctx) => myRoutes(request, env, ctx), // optional
  healthPath: "/storekit/health" // or false
})
```

Takes every option `createStoreKitHandler` takes, plus:

| Option       | Type                       | Default            | Notes                                              |
| ------------ | -------------------------- | ------------------ | -------------------------------------------------- |
| `healthPath` | `string \| false`          | `/storekit/health` | Reports secret **presence**, never a value.        |
| `fetch`      | `(request, env, ctx) => …` | —                  | Your other routes. Returning `null` answers `404`. |

### `createStoreKitHandler(options)`

The composable form. `fetch` resolves to `null` for non-StoreKit paths, so it drops into Hono,
itty-router, a `switch`, or anything else.

```ts
const storekit = createStoreKitHandler<Env>({ authenticate })

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return (await storekit.fetch(request, env, ctx)) ?? myRouter.fetch(request, env, ctx)
  }
}
```

| Option                            | Type                                                           | Default                                             | Notes                                                                   |
| --------------------------------- | -------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| `authenticate`                    | `(request, env) => StoreKitRequestContext \| null`             | **required**                                        | Return `null` to answer `401`. Never called for the Apple webhook.      |
| `database`                        | `(env) => D1Database \| undefined`                             | `env.STOREKIT_DB`                                   | Point at any binding name.                                              |
| `paths`                           | `Partial<StoreKitRoutePaths>`                                  | `/storekit/*`                                       | e.g. `{ sync: "/api/v1/iap/sync" }`.                                    |
| `allowGracePeriodAccess`          | `boolean`                                                      | `STOREKIT_ALLOW_GRACE_PERIOD_ACCESS`, itself `true` | Code wins over the variable.                                            |
| `reconcileNotificationsWithApple` | `boolean`                                                      | `STOREKIT_RECONCILE_NOTIFICATIONS`, itself `true`   | Re-read Apple's status per notification.                                |
| `allowAccountTransfer`            | `boolean`                                                      | `STOREKIT_ALLOW_ACCOUNT_TRANSFER`, itself `false`   | Let a sync take an entitlement off the account that owns it.            |
| `allowFamilySharing`              | `boolean`                                                      | `STOREKIT_ALLOW_FAMILY_SHARING`, itself `true`      | Whether a `FAMILY_SHARED` purchase grants access.                       |
| `onEntitlementChange`             | `(change: StoreKitEntitlementChange) => void \| Promise<void>` | —                                                   | Fires when a write actually changed the entitlement. See below.         |
| `entitlementChangeMode`           | `"await" \| "waitUntil"`                                       | `"await"`                                           | `waitUntil` responds without waiting for the hook.                      |
| `onEvent`                         | `(event: Record<string, unknown>) => void`                     | —                                                   | Structured logs. No secrets, payloads, or tokens are ever passed to it. |

Returns `{ fetch, paths }`.

### `StoreKitRequestContext`

What your `authenticate` returns.

| Field                     | Type       | Notes                                                                                                                                      |
| ------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `accountId`               | `string`   | The identifier the entitlement binds to: your user id, account id, or installation id.                                                     |
| `expectedAppAccountToken` | `string?`  | Set it when your client passes `appAccountToken` at purchase. This is what stops a signed transaction being replayed onto another account. |
| `appBundleId`             | `string?`  | Overrides `STOREKIT_BUNDLE_ID` per request, for multi-app Workers.                                                                         |
| `sandboxAllowed`          | `boolean?` | Per-caller sandbox allowance, e.g. only for internal testers.                                                                              |

### `storeKitRoutePaths`

The default paths, as an object, so you can reference them instead of hardcoding strings.

---

## Service layer

No HTTP dependency: call these from a Durable Object, a queue consumer, a GraphQL resolver, or a
cron trigger.

```ts
import { syncStoreKitTransaction } from "storekit-cloudflare-workers"

const { snapshot } = await syncStoreKitTransaction(
  { signedTransactionJWS, installationId: userId, appBundleId, expectedAppAccountToken },
  { apple: env, d1: env.STOREKIT_DB }
)
```

| Function                                                   | Returns                                                   | Purpose                                                                     |
| ---------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| `syncStoreKitTransaction(input, config)`                   | `{ snapshot, verified }`                                  | Verify a signed transaction, reconcile with Apple, persist, and project.    |
| `processStoreKitNotification(signedPayload, config)`       | `{ processed, replayed, snapshot, reconciled, verified }` | The webhook path, including the replay ledger.                              |
| `getStoreKitEntitlement(accountId, environments, config)`  | `StoreKitCurrentEntitlement`                              | Read the projection, re-evaluating expiry now. Never throws on "no record". |
| `readStoreKitEntitlement(accountId, environments, config)` | `StoreKitSubscriptionRecord \| null`                      | The raw stored row.                                                         |
| `isStoreKitRecordActive(record, now)`                      | `boolean`                                                 | The access rule on its own, for your own queries.                           |

### `StoreKitServiceConfig`

| Field                             | Type          | Notes                                          |
| --------------------------------- | ------------- | ---------------------------------------------- |
| `apple`                           | `StoreKitEnv` | Usually just `env`.                            |
| `d1`                              | `D1Database`  | The binding to persist into.                   |
| `allowGracePeriodAccess`          | `boolean?`    | Defaults to the Worker variable.               |
| `reconcileNotificationsWithApple` | `boolean?`    | Defaults to the Worker variable.               |
| `allowAccountTransfer`            | `boolean?`    | Defaults to the Worker variable, itself off.   |
| `allowFamilySharing`              | `boolean?`    | Defaults to the Worker variable, itself on.    |
| `sandboxAllowed`                  | `boolean?`    | Narrow the allowed environments for this call. |
| `now`                             | `Date?`       | Inject the clock, for tests.                   |

### `onEntitlementChange`

Storing the entitlement is half an integration; the other half is your application reacting to it.
This is where you mirror the tier onto your own `users` table, send the payment-failure push that
saves a subscription, or release server-side resources on a refund.

```ts
createStoreKitHandler<Env>({
  authenticate,
  onEntitlementChange: async ({ accountId, previous, next, changed, source, notification }) => {
    if (!accountId) return
    await env.DB.prepare("UPDATE users SET tier = ? WHERE id = ?")
      .bind(next.proActive ? "pro" : "free", accountId)
      .run()

    if (changed.includes("status") && next.status === "grace_period") {
      await sendPaymentUpdatePush(accountId)
    }
  }
})
```

| Field          | Type                                 | Notes                                                         |
| -------------- | ------------------------------------ | ------------------------------------------------------------- |
| `accountId`    | `string \| null`                     | The account the entitlement is bound to, from the stored row. |
| `previous`     | `StoreKitSubscriptionRecord \| null` | The projection before this write. `null` on a first purchase. |
| `next`         | `StoreKitEntitlementSnapshot`        | What was just persisted.                                      |
| `changed`      | `StoreKitEntitlementChangeField[]`   | Which significant fields differ. Never empty.                 |
| `source`       | `"sync" \| "notification"`           | Which path wrote it.                                          |
| `notification` | `{ uuid, type, subtype }?`           | Present when `source` is `"notification"`.                    |

**It fires only on a real change.** `changed` is computed over `proActive`, `status`, `productId`,
`accessExpiresAt`, `autoRenewStatus`, `autoRenewProductId` and `revocationType`. Timestamps that move
on every write are excluded deliberately, so a client re-syncing at every launch does not look like a
subscription event, and a replayed notification fires nothing.

**A throwing hook never fails the request.** The write has already committed. Failing the response
would make Apple redeliver a notification that was in fact processed, or turn a successful purchase
into a server error. Errors go to `onEvent` as `storekit_entitlement_change_hook_failed`.

**Cost.** The hook needs the previous state, which is one extra indexed row read per write. It is
only issued when a hook is configured.

Pass `entitlementChangeMode: "waitUntil"` to respond without waiting for the hook. It needs the `ctx`
your Worker was called with, and falls back to awaiting when none was passed.

---

## Entitlement policy

`resolveStoreKitEntitlementCore(input, now?, policy?)` is the pure kernel: no Apple
SDK, no D1, no HTTP, no clock of its own. It takes plain objects and returns a
`StoreKitEntitlementSnapshot`, so you can unit-test your tier rules against fixtures, or import it
in another runtime entirely:

```ts
import { resolveStoreKitEntitlementCore } from "storekit-cloudflare-workers/entitlement"
```

That subpath pulls in none of the Apple SDK. `resolveStoreKitEntitlementPolicy` is an alias of the
same function.

Inputs are `StoreKitEntitlementInput`, built from `StoreKitEntitlementCandidate`,
`StoreKitEntitlementTransaction`, and `StoreKitEntitlementRenewalInfo` — all structural, all
Apple-shaped.

`policy` is `StoreKitEntitlementPolicy`, the states Apple leaves to you. Both default to granting
access, which is Apple's own intent.

| Field                    | Default | Meaning                                           |
| ------------------------ | ------- | ------------------------------------------------- |
| `allowGracePeriodAccess` | `true`  | Whether a billing grace period keeps access.      |
| `allowFamilySharing`     | `true`  | Whether a `FAMILY_SHARED` purchase grants access. |

A bare boolean is still accepted in place of the object and means `allowGracePeriodAccess`, so calls
written against the original signature keep working.

---

## Verification

Use these when you want verified Apple claims without the persistence or HTTP layers.

| Function                                                     | Purpose                                                                                               |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `verifyStoreKitTransaction(signedTransactionJWS, env)`       | Verify signature, certificate chain, bundle, environment and product allow-list; re-look-up at Apple. |
| `verifyStoreKitNotification(signedPayload, env)`             | The same, for a notification body.                                                                    |
| `verifyStoreKitNotificationForRuntime(signedPayload, env)`   | Also returns the runtime that accepted it, so you reconcile with the matching credentials.            |
| `lookupStoreKitSubscriptionState(originalTransactionId, rt)` | Apple's `Get All Subscription Statuses`, every signed entry independently verified.                   |
| `resolveStoreKitEntitlement(verified, now?, grace?)`         | Snapshot from an already-verified transaction.                                                        |
| `buildStoreKitRuntimes(env)`                                 | One verifier + client per configured environment. Build once, reuse.                                  |
| `storeKitStatusName(status)`                                 | Apple's numeric status as a readable name, for logs.                                                  |

The `*WithRuntime` variants take a prebuilt `StoreKitRuntime` instead of `env`, which is also the
seam the test suite injects at.

---

## Persistence

The D1 adapter. It takes a database binding directly and never reads `env`, so your binding can be
called anything.

| Function                                                                                  | Purpose                                                             |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `persistStoreKitSubscriptionForInstallation(snapshot, accountId, bundleId, db, options?)` | Write the projection and audit row, guarded on Apple's signed date. |
| `loadStoreKitSubscriptionByInstallation(accountId, now, environments, db)`                | Read one account's row.                                             |
| `loadStoreKitSubscriptionOwner(originalTransactionId, environment, db)`                   | The account a transaction is bound to, or `null`.                   |
| `persistStoreKitNotification(notification, db)`                                           | Write the replay ledger entry and projection in one atomic batch.   |
| `storeKitNotificationExists(uuid, db)`                                                    | Replay check.                                                       |
| `storeKitNotificationStatement(...)`                                                      | The ledger statement, to compose into your own batch.               |

Tables: `storekit_subscriptions` (projection), `storekit_transactions` (audit trail),
`storekit_notifications` (replay ledger). The schema is
[`migrations/0001_storekit.sql`](../migrations/0001_storekit.sql).

---

## Configuration

| Function                                  | Purpose                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| `describeStoreKitConfig(env)`             | Every problem at once, plus secret **presence** without values. Safe to log. |
| `assertStoreKitConfig(env)`               | Throws `StoreKitConfigError` if anything is wrong. Good for a startup check. |
| `storeKitConfiguredEnvironments(env)`     | The allowed Apple environments.                                              |
| `storeKitAllowedProductIds(env)`          | The product allow-list as a `Set`.                                           |
| `storeKitAllowGracePeriodAccess(env)`     | The effective grace-period policy.                                           |
| `storeKitReconcileNotifications(env)`     | The effective reconciliation policy.                                         |
| `storeKitAppleLookupFallbackEnabled(env)` | Whether a failed Apple lookup falls back to signed claims.                   |
| `storeKitAppAppleId(env, environment)`    | The numeric App Store app id Apple requires for production notifications.    |
| `parseAppleRootCertificatesPem(pem)`      | Apple's roots as DER buffers.                                                |

Every variable and secret is documented in [configuration.md](configuration.md).

---

## App Store Server API

Operational calls, sharing the same authenticated, environment-pinned client. **All of these are
privileged — never expose them on an unauthenticated route.**

| Function                                                                 | Apple endpoint                                                 |
| ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `requestStoreKitTestNotification(env, environment?)`                     | Request a Test Notification — the fastest webhook proof.       |
| `getStoreKitNotificationHistory(env, request, token?, environment?)`     | Get Notification History — outage recovery, 6 months retained. |
| `getStoreKitTransactionHistory(env, transactionId, request, revision?)`  | Get Transaction History.                                       |
| `getStoreKitRefundHistory(env, transactionId, revision?)`                | Get Refund History.                                            |
| `lookUpStoreKitOrderId(env, orderId, environment?)`                      | Look Up Order ID — support workflows.                          |
| `extendStoreKitSubscriptionRenewalDate(env, originalTransactionId, req)` | Extend a Subscription Renewal Date — goodwill after an outage. |
| `sendStoreKitConsumptionInformation(env, transactionId, request)`        | Send Consumption Information, answering `CONSUMPTION_REQUEST`. |

Request and response types come from `@apple/app-store-server-library`. Worked examples are in
[operations.md](operations.md#other-operational-calls).

---

## Errors

| Class                            | Meaning                                                    | Handler response               |
| -------------------------------- | ---------------------------------------------------------- | ------------------------------ |
| `StoreKitConfigError`            | Missing or invalid Apple credentials. An operator error.   | `503 UPSTREAM_UNAVAILABLE`     |
| `StoreKitVerificationError`      | Signed material failed signature, identity, or policy.     | `400` (`401` on the webhook)   |
| `StoreKitPersistenceError`       | A D1 operation failed. `retryable` distinguishes the case. | `503` if retryable, else `400` |
| `StoreKitOwnershipConflictError` | The transaction's entitlement belongs to another account.  | `409 OWNERSHIP_CONFLICT`       |

`StoreKitVerificationError` carries `stage`, `sdkErrorName`, `appleHttpStatus`, and `appleApiError`
for logging. None of it reaches the HTTP response — that is deliberate, see
[security.md](security.md).

---

## Runtime types

The package declares the Cloudflare surface it uses structurally, so it typechecks in any Worker
regardless of how yours generates types: `StoreKitD1Database`, `StoreKitPreparedStatement`,
`StoreKitExecutionContext`. Real Cloudflare bindings satisfy them, so you pass `env.STOREKIT_DB` and
`ctx` straight in and never import these names yourself.

Value types worth knowing: `StoreKitEntitlementSnapshot`, `StoreKitCurrentEntitlement`,
`StoreKitSubscriptionRecord`, `StoreKitEntitlementStatus`, `StoreKitEnvironment`, `StoreKitEnv`, and
the constants `STOREKIT_STATUS` and `STOREKIT_ENVIRONMENT`. Field-by-field meanings are in
[http-api.md](http-api.md#entitlement-fields).
