# Changelog

## Unreleased

### Upgrading

**Apply the new migrations.** Five were added; Wrangler runs them in filename order:

```bash
npx wrangler d1 migrations apply STOREKIT_DB --local
npx wrangler d1 migrations apply STOREKIT_DB --remote
```

Every one adds nullable columns to the existing projections. Nothing is rewritten, no row changes
its entitlement, and the defaults are chosen so pre-existing rows keep behaving exactly as they did —
a `NULL` `in_app_ownership_type` reads as purchased, a `NULL` `revocation_type` still reports
`refunded`.

**One behaviour change needs a decision.** A sync for a transaction already bound to a different
account now answers `409 OWNERSHIP_CONFLICT` and writes nothing, where it previously rebound the
entitlement. This closes a hole — a leaked signed transaction could take a paying customer's access
away — but a customer who legitimately changed accounts now needs a deliberate transfer. Clients
should treat `409` as terminal rather than retrying it. See
[`STOREKIT_ALLOW_ACCOUNT_TRANSFER`](docs/configuration.md#storekit_allow_account_transfer).

**Three additions are worth wiring up**, none of them required:

- `onEntitlementChange`, to react when a refund, renewal or grace period changes an entitlement.
- The `entitlements` array on `GET /storekit/entitlement`, if you sell more than one product. The
  top-level fields are unchanged, so a one-product app needs no change at all.
- An alert on `appleLookupDegraded`, so a deployment running on the Apple fallback is visible.

**Two new statuses** can appear: `family_revoked` and `upgraded`, plus `family_shared` if you turn
Family Sharing off. Anything gating on `proActive` is unaffected; a `switch` over `status` needs the
new cases, or a default.

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
- **Upgraded subscriptions no longer win entitlement selection.** Apple marks the subscription it
  cancelled to perform an upgrade with `isUpgraded`, and the policy did not read it. Ranking
  candidates by expiry alone can therefore pick a superseded monthly transaction over the annual one
  that replaced it, reporting the product the customer upgraded away from — with access working and
  only the tier wrong. Superseded transactions are now excluded from selection, kept in the audit
  projection, and reported through `isUpgraded` on the snapshot.
- A superseded transaction standing alone resolves to the new `upgraded` status rather than
  `expired`, since the customer did not churn. Migration `0004_is_upgraded.sql` adds the column.

### Testing

- **An end-to-end test drives a customer's whole lifecycle through the composed stack**: real HTTP
  into the mounted handler, real ES256 signatures verified against a real certificate chain, the real
  policy, and real SQLite behind the real migrations. Purchase, read-back, a refund revoking access,
  notification replay, a forged chain rejected, and a second account refused.
- Writing it surfaced that `vi.mock` cannot intercept a module's calls to itself, so an earlier draft
  ran against Apple's real network, silently degraded through
  `STOREKIT_ALLOW_APPLE_LOOKUP_FALLBACK`, and passed for the wrong reason. The suite disables that
  fallback so an unreachable Apple fails loudly rather than looking like success.
- **`runtimes` lets a host supply a prebuilt Apple verifier and client.** `buildStoreKitRuntimes` was
  documented as "build once, reuse", but the module rebuilt one on every sync and every notification
  and offered no way to pass one in. Defaults to the previous behaviour.

- **Signature and certificate chain verification is now actually tested.** `src/verification.ts` was
  wrapped end to end in a `v8 ignore` block, reporting 100% coverage while executing none of its
  logic, and the conformance suite deliberately ran under `Environment.LOCAL_TESTING`, which skips
  both signature and chain validation. Nothing proved that a forged payload was rejected.
- Tests now run Apple's real `SignedDataVerifier` in `SANDBOX` mode against a purpose-built
  certificate authority satisfying every rule the SDK enforces. Covered in both directions: a valid
  payload verifies; a foreign root, an unsigned leaf, a missing Apple marker OID, an expired chain, a
  tampered body and a wrong bundle are each rejected — asserting the SDK's `VerificationStatus`, not
  merely that something threw. The unauthenticated webhook path is covered the same way.
- The `v8 ignore` block is narrowed to the client construction that genuinely needs real App Store
  Connect credentials, so `verification.ts` now reports honest coverage.

### Observability

- **A sync that fell back because Apple was unreachable is now visible.** With
  `STOREKIT_ALLOW_APPLE_LOOKUP_FALLBACK` on, such a sync succeeds and the entitlement resolves from
  the submitted JWS, so nothing marked it — a deployment could serve entirely from the fallback for
  hours without a signal. The sync event is raised to `warn` and carries `appleLookupDegraded`,
  `appleLookupFailed` (which call failed, since the blast radius differs) and Apple's HTTP status,
  which separates a rate limit from a bad credential from an Apple incident.

### Testing

- **The adapter's SQL now runs against a real database.** Every test went through
  `MockD1Database`, which re-implements the statements in JavaScript by matching on their text, so
  nothing had ever parsed or executed the SQL itself — a column the schema lacked, or an
  `ON CONFLICT` clause SQLite reads differently, would have passed.
- `test/integration/` executes the real statements against real SQLite (`node:sqlite`, no new
  dependency) over the real migrations, covering the account binding rule, the out-of-order write
  guard, the revocation bypass, per-group reads, ranking, environment isolation, and the notification
  ledger's idempotency. The `test:integration` script previously pointed at a directory that did not
  exist.
- Line coverage is unchanged, because both layers exercise the same lines. The difference is
  semantic: deleting one column from a migration fails eleven integration tests and no unit tests.

### Tooling

- **`init` no longer tells an existing project to replace its Worker.** It generated a
  `createStoreKitWorker` default export and printed "point your Worker's main at the file above" —
  which, followed literally in a project that already had a Worker, swaps out the whole application.
  It now detects an existing entrypoint from Wrangler's `main` or the conventional paths, generates a
  mountable `createStoreKitHandler` instead, and prints the composition to paste in. `--mode
worker|handler` overrides the guess.
- **`--flag value` is parsed.** Only `--flag=value` worked; the space-separated form matched the
  bare-flag case and yielded `true`, so `init --dir build` resolved its target to a directory
  literally named `true` and wrote the migrations there.
- The CLI has behavioural tests for the first time, which is why neither of the above was noticed.

### Integration surface

- **Commerce and renewal metadata Apple signs is no longer discarded.** `price`, `currency`,
  `storefront`, `storefrontId`, `transactionReason`, `quantity`, `offerType`, `offerIdentifier`,
  `offerPeriod`, `originalPurchaseDate`, `appTransactionId`, `renewalDate`,
  `recentSubscriptionStartDate` and `eligibleWinBackOfferIds` are on the snapshot and the
  projections. None of it gates access; all of it is needed to build the screens and reports around
  access.
- `renewalDate` is what a UI should show. It cannot be derived from `expiresAt`, which during a
  billing grace period is already in the past — exactly when a customer looks.
- `price` and `renewalPrice` are in **milliunits**: `9990` is 9.99. The unit is repeated at every
  point it appears, because reading it as currency units is a thousand-fold error that looks
  plausible in test data.
- `currency` now falls back to the transaction's when renewal info carries none. Strictly additive:
  values that were `null` may now be populated, and nothing already set changes.
  Migration `0006_commerce_metadata.sql`.
- **Subscription groups are modelled, so an app with more than one product is served correctly.**
  `subscriptionGroupIdentifier` is stored on both projections, and `GET /storekit/entitlement` now
  returns an `entitlements` array with one entry per group alongside the existing top-level fields.
  Previously the read ended in `LIMIT 1` and a second concurrent entitlement was simply invisible.
- Apple permits one active subscription per group, so entries within a group compete and separate
  groups are concurrent. A non-subscription purchase has no group and is keyed by product, which is
  what lets a lifetime unlock coexist with a subscription.
- The top-level fields are unchanged and still describe the single best entitlement, so a
  one-product integration needs no change. New `listStoreKitEntitlements` and
  `listStoreKitSubscriptionsByInstallation` exports; `StoreKitPreparedStatement` gains `all()`.
  Migration `0005_subscription_group.sql`.
- **`onEntitlementChange` lets a host react to an entitlement changing.** Previously a refund could
  arrive, the projection update, and the application never find out; `onEvent` is a log sink, not a
  change feed. The hook receives the previous projection, the new snapshot, which fields differ, and
  the notification that caused it, so a host can mirror the tier onto its own tables, send the
  payment-failure push, or release resources on a refund.
- It fires only on a material change — timestamps that move on every write are excluded — so an
  idempotent re-sync and a replayed notification fire nothing. A throwing hook is reported through
  `onEvent` and never fails the response, since the write has already committed and a non-2xx answer
  would make Apple redeliver a processed notification.
- `entitlementChangeMode: "waitUntil"` hands the hook to the runtime instead of blocking the
  response. `StoreKitHandler.fetch` now uses the `ctx` it already accepted.
- New `loadStoreKitSubscriptionByTransaction` export.

### API

- `STOREKIT_NOTIFICATION_TYPE` and `StoreKitNotificationType` export Apple's 23 notification types, so
  a host switching on `notificationType` has something to check its cases against. Declared by this
  package rather than re-exported from the Apple SDK, and pinned against the SDK's `NotificationTypeV2`
  in both directions by the conformance suite.
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

### Testing

- **Signature and certificate chain verification is now actually tested.** `src/verification.ts` was
  wrapped end to end in a `v8 ignore` block, reporting 100% coverage while executing none of its
  logic, and the conformance suite deliberately ran under `Environment.LOCAL_TESTING`, which skips
  both signature and chain validation. Nothing proved that a forged payload was rejected.
- Tests now run Apple's real `SignedDataVerifier` in `SANDBOX` mode against a purpose-built
  certificate authority satisfying every rule the SDK enforces. Covered in both directions: a valid
  payload verifies; a foreign root, an unsigned leaf, a missing Apple marker OID, an expired chain, a
  tampered body and a wrong bundle are each rejected — asserting the SDK's `VerificationStatus`, not
  merely that something threw. The unauthenticated webhook path is covered the same way.
- The `v8 ignore` block is narrowed to the client construction that genuinely needs real App Store
  Connect credentials, so `verification.ts` now reports honest coverage.

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
