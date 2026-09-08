# Changelog

## Unreleased

### Security

- **An entitlement now stays bound to the first account that syncs it.** The sync upsert resolved
  `installation_id` with `COALESCE(excluded, existing)`, so any account posting another customer's
  signed transaction took the entitlement: the row rebound, the original owner's read returned
  nothing, and the poster's returned `active_paid`. A signed transaction is not a secret — it is held
  by the client and turns up in logs and support tickets — so possession of one no longer moves an
  entitlement. A conflicting sync answers `409 OWNERSHIP_CONFLICT` and writes nothing.
  `expectedAppAccountToken` already covered this, but only for hosts that wired it up and clients
  that passed a token, so out of the box there was no defence.
- `STOREKIT_ALLOW_ACCOUNT_TRANSFER` (and the `allowAccountTransfer` option) restores the previous
  behaviour for the legitimate case of moving a purchase between accounts. It defaults to off; scope
  it to a single call rather than enabling it deployment-wide.
- New `StoreKitOwnershipConflictError` and `loadStoreKitSubscriptionOwner` exports.

### Apple contract

- **Family Sharing is now modelled.** Apple marks every transaction `PURCHASED` or `FAMILY_SHARED`;
  the module read neither. `inAppOwnershipType` is carried through the policy, the snapshot, both D1
  projections and the entitlement read. A shared purchase still grants access by default, which is
  Apple's intent, but hosts can now see which entitlements are shared — needed for per-seat products
  and for reporting that should not count five family members as five subscribers.
- `STOREKIT_ALLOW_FAMILY_SHARING` / `allowFamilySharing` (default on) excludes shared purchases,
  which then resolve as the new `family_shared` status. Ownership is decided before billing state, so
  an excluded share does not report `grace_period` and prompt a payment update at a non-payer.
- A transaction signed before Apple added the field reports `null` and is treated as purchased, so
  no existing entitlement changes on upgrade.
- Migration `0002_in_app_ownership_type.sql` adds the column to both projections.
- **Revocation is no longer collapsed to one state.** Apple's status 5 covers both a refund and
  Family Sharing ending, and `revocationType` separates them. `REFUND_FULL` and `REFUND_PRORATED`
  report `refunded`; `FAMILY_REVOKE` reports the new `family_revoked` status, because the organiser's
  subscription is alive and paid for and a refund that never happened does not belong in support or
  revenue reporting. `revocationType` and `revocationPercentage` (milliunits) are on the snapshot and
  both projections. All three still deny access, so no entitlement decision changes.
- A revocation Apple sent without a type, and every row written before this change, continues to
  report `refunded`. Migration `0003_revocation_detail.sql` adds the columns.

### API

- `resolveStoreKitEntitlementCore(input, now?, policy?)` now takes a `StoreKitEntitlementPolicy`
  object. The original `allowGracePeriodAccess` boolean is still accepted in its place, so existing
  calls keep working.

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

### Packaging

- Published to npm as `storekit-cloudflare-workers`: ESM-only, `sideEffects: false`, its own types,
  and one runtime dependency (`@apple/app-store-server-library`), so adopting it is `npm install`
  rather than copying a directory.
- `createStoreKitWorker` is a whole Worker in one export, including a `GET /storekit/health`
  configuration report. `createStoreKitHandler` is still there for mounting inside an existing
  router.
- `npx storekit-cloudflare-workers init` copies the D1 migration, writes a mount point with an
  `authenticate` stub, and prints the Wrangler configuration and secret commands. It never edits an
  existing file.
- `migrations/` ships in the tarball, so `"migrations_dir": "node_modules/storekit-cloudflare-workers/migrations"`
  works and the SQL need not be vendored at all.
- Subpath `storekit-cloudflare-workers/entitlement` exposes the pure policy kernel on its own.

### Guarantees

- The package imports nothing outside itself except `@apple/app-store-server-library`, and
  references no ambient Cloudflare global: the D1 and `ExecutionContext` surfaces it needs are
  declared structurally in `src/cloudflare.ts`, so it typechecks in any Worker. Tests enforce both.
- Relative imports carry the `.js` extension the published ESM build needs, enforced by a test, and
  a smoke job installs the packed tarball into a scratch Worker on every CI run to prove the export
  map resolves and the result bundles for workerd.
- The `authenticate` adapter fails closed by design, in the example Worker and in the stub `init`
  writes.
