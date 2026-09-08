# Security model

## Trust boundaries

**The iOS client is untrusted.** It may submit Apple-signed transaction material, but it does not
choose the account, the product, the expiry, or the entitlement. Every value the module persists or
returns comes from a verified Apple claim.

**The notification endpoint is not authenticated by your session.** Apple authenticates itself with
a JWS signature; there is no bearer token. Its trust boundary is the signature plus the bundle and
environment checks below.

**Authentication is yours.** A StoreKit transaction proves that a purchase happened, never who it
belongs to. `authenticate` ships returning `null` (see `example/src/auth.ts`, and the stub `npx storekit-cloudflare-workers init` writes), so every authenticated route answers 401 until you
implement it. Never derive identity from a client-supplied header or body field; anyone can send
one and claim another customer's subscription.

## The verification chain

Every check happens before any entitlement is persisted:

1. **Signature and chain.** The Apple library verifies the JWS signature and its certificate chain
   against your configured Apple roots, evaluated at the payload's signed date.
2. **App identity.** `bundleId` must equal `STOREKIT_BUNDLE_ID`.
3. **Environment.** The payload's environment must match the runtime that verified it, so a
   sandbox-signed transaction can never be accepted as production.
4. **Product allow-list.** `productId` must be in `STOREKIT_ALLOWED_PRODUCT_IDS`.
5. **Transaction identity.** Both `transactionId` and `originalTransactionId` must be present.
6. **Apple re-lookup.** `Get Transaction Info` is queried and its Apple-signed response _replaces_
   the client copy, but only after its `originalTransactionId` matches, so a swap is impossible.
7. **Subscription status.** `Get All Subscription Statuses` is queried; every signed entry it
   returns is independently verified and pinned to the same `originalTransactionId`.
8. **Renewal info.** `signedRenewalInfo` is verified and identity-pinned the same way before the
   policy reads `gracePeriodExpiresDate` from it.
9. **Account binding.** When `expectedAppAccountToken` is supplied, a mismatch is rejected.
10. **Ownership.** If the transaction's entitlement is already bound to a different account, the
    sync is refused rather than rebound.

## Replay and account takeover

A signed transaction is a bearer artifact: whoever holds it can present it. It is not a secret — the
client holds it, and it ends up in debug logs, support tickets and screenshots. Three controls
matter.

**The binding is sticky.** The first account to sync a transaction owns its entitlement. A later
sync by any other account is refused with `409 OWNERSHIP_CONFLICT` and writes nothing; the owner
keeps their access. This is on by default and needs no configuration.

The rule lives in the SQL upsert (`COALESCE(existing, excluded)`) rather than in a read-then-write
check, so two concurrent syncs cannot both see an unbound row and race to claim it. The service also
reads the current owner before writing, purely so the caller gets a clear `409` instead of a success
response describing an entitlement that belongs to somebody else.

Set `STOREKIT_ALLOW_ACCOUNT_TRANSFER=true`, or pass `allowAccountTransfer`, only behind a deliberate
support flow. It restores the old behaviour, in which whoever posts a transaction takes it.

**Pin `appAccountToken`.** Set it on the iOS `Product.purchase(options:)` call to a UUID your server
can tie back to the user, and return it as `expectedAppAccountToken` from `authenticate`. Sticky
binding stops a captured transaction from taking an existing entitlement away; `appAccountToken`
additionally stops it from ever binding to the wrong account in the first place — including the case
where the attacker syncs _first_. Use both.

**Keep the lookup fallback in mind.** With `STOREKIT_ALLOW_APPLE_LOOKUP_FALLBACK=true`, a
signed-but-stale transaction can extend access until its own signed expiry while Apple's API is
unreachable. Set it to `false` where that is unacceptable.

## What is never logged or returned

Raw JWS values, `signedPayload`, the Apple bearer JWT, and the private key never reach logs. Error
responses are deliberately generic (`"StoreKit transaction could not be verified."`); the failing
stage goes to the `onEvent` sink instead, so an attacker probing with forged payloads learns nothing
about which check rejected them.

`describeStoreKitConfig` reports secret presence, never secret values.

## Protecting the webhook

`/storekit/notifications` is necessarily unauthenticated at the HTTP layer, and JWS verification
costs CPU. A flood of forged payloads is rejected correctly but still burns Worker CPU time.

The Cloudflare-native answer is a rate limiting or WAF rule in front of the route rather than a
threshold baked into the module, since the right limit depends on your subscriber volume. Apple's
notification traffic is low and bursty, so a generous per-IP limit is enough. The replay ledger
already makes duplicate _valid_ notifications cheap.

## Offline certificate verification

OCSP checking is disabled because Apple's Node SDK OCSP path calls `Response.buffer()`, which does
not exist in the Workers runtime. Signature and chain validation are unaffected; what is lost is
detection of a _revoked_ Apple intermediate certificate, a scenario Apple handles by rotating
roots, and one the other identity checks above do not depend on.

## What the test suite proves about all this

The verification chain above is exercised in tests, but not uniformly, and the difference matters
when you are judging risk.

**Proved in CI:** all ten steps, including step 1. Apple's real `SignedDataVerifier` runs in
`SANDBOX` mode — where nothing is skipped — against a certificate authority built for the tests,
shaped to satisfy every rule the SDK enforces. A payload rooted in a different CA, a leaf the
intermediate never signed, a leaf missing Apple's marker OID, an expired chain, a body altered after
signing, and a payload for another bundle are each rejected, and each assertion pins the SDK's own
`VerificationStatus` rather than merely expecting a throw. The webhook path is covered the same way.
Every Apple constant the policy compares against is asserted equal to the SDK's exported enum.

**Still not proved in CI:** that _your_ `APPLE_ROOT_CERTIFICATES_PEM` holds Apple's real roots. The
suite proves the verifier enforces the rules; it cannot prove your secret contains the right bytes,
because it supplies its own. A malformed bundle fails every verification and
`describeStoreKitConfig` catches it, but a subtly wrong one may not. A sandbox purchase before
release remains the check for that, and the release checklist treats it as required.

Full breakdown in [apple-contract.md](apple-contract.md#what-is-not-verified-here).

## Operational rules

- Keep App Store Connect credentials in Wrangler secrets, never in `wrangler.jsonc`.
- Treat the product allow-list as a deploy-time decision; adding a product is a config change.
- Treat notification UUID uniqueness as the idempotency boundary.
- Return a failure status when persistence fails, so Apple retries.
- Keep production and sandbox credentials and D1 data separated.
- Never expose the operational App Store Server API calls on an unauthenticated route.
