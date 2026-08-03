# Release checklist

## Publishing this repository

- [ ] Review the Apple contract links and the pinned `@apple/app-store-server-library` version.
- [ ] Confirm the trademark and non-affiliation notices are present in README.md and
      docs/apple-contract.md.
- [ ] Confirm the Wrangler `compatibility_date` and version are current.
- [ ] Run `npm ci`, `npm run cf:typegen`, and `npm run release:check`.
- [ ] Confirm the Apple SDK conformance suite passes against `@apple/app-store-server-library@latest`,
      not only against the pinned version:
      `npm i --no-save @apple/app-store-server-library@latest && npm run typecheck && npx vitest run test/unit/storekit-apple-sdk-conformance.test.ts`
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
- [ ] Put a rate limiting or WAF rule in front of the notification route.
- [ ] Verify the client gates access on `accessExpiresAt`, not `expiresAt`.
- [ ] Separate production and sandbox Worker environments, D1 databases, and credentials.
- [ ] Name the owner for reconciliation after a webhook outage.

## Sandbox verification, which CI cannot replace

CI proves this module still agrees with the Apple SDK. It does not prove the SDK still agrees with
Apple's servers, and it never touches Apple's live API, real certificate chains, or real
notification delivery. See
[what is not verified here](apple-contract.md#what-is-not-verified-here).

Everything below therefore has to be exercised against Apple at least once before a production
release, and again after any change to verification or entitlement policy.

- [ ] **A real purchase verifies end to end.** This is the only proof that certificate chain
      validation works with your `APPLE_ROOT_CERTIFICATES_PEM`, since `LOCAL_TESTING` skips it.
- [ ] **The webhook receives and verifies a real notification.** Send one with
      `requestStoreKitTestNotification` and confirm a row lands in `storekit_notifications`.
- [ ] **A renewal updates the projection.** Sandbox subscription periods are accelerated, so this
      takes minutes.
- [ ] **The grace-period path keeps access.** Force a billing failure from
      **Settings > Developer > Sandbox Apple Account**, then confirm `status` is `grace_period`,
      `access_expires_at` is in the future, and `expires_at` is in the past. This is the behaviour
      most likely to regress and the most expensive when it does.
- [ ] **Billing retry denies access** and reports `billing_retry` rather than `expired`.
- [ ] **A refund revokes access.** Request one in sandbox and confirm `revocation_date` is set and
      the entitlement drops, including when the refund arrives after a newer renewal.
- [ ] **A free trial reports `active_trial` and a paid introductory offer reports `active_paid`.**
      The distinction comes from `offerDiscountType`, so it needs a real Apple-signed transaction
      to confirm.
- [ ] **A duplicate notification is idempotent**, returning 200 without a second projection write.
- [ ] Record which of these were run, against which build, and on what date.
