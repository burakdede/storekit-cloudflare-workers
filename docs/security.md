# Security model

## Trust boundaries

**The iOS client is untrusted.** It may submit Apple-signed transaction material, but it does not
choose the account, the product, the expiry, or the entitlement. Every value the module persists or
returns comes from a verified Apple claim.

**The notification endpoint is not authenticated by your session.** Apple authenticates itself with
a JWS signature; there is no bearer token. Its trust boundary is the signature plus the bundle and
environment checks below.

**Authentication is yours.** A StoreKit transaction proves that a purchase happened, never who it
belongs to. `src/auth.ts` ships returning `null`, so every authenticated route answers 401 until you
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

## Replay and account takeover

A signed transaction is a bearer artifact: whoever holds it can present it. Two controls matter.

**Pin `appAccountToken`.** Set it on the iOS `Product.purchase(options:)` call to a UUID your server
can tie back to the user, and return it as `expectedAppAccountToken` from `authenticate`. Without
this, a signed transaction captured from one account can be synced onto another.

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

**Proved in CI:** the claim checks (steps 2 to 9). Apple's real `SignedDataVerifier` runs under
`Environment.LOCAL_TESTING`, which performs genuine decoding, schema validation and its own bundle
and environment checks, and the module's identity pinning and entitlement policy run on the result.
Every Apple constant the policy compares against is asserted equal to the SDK's exported enum.

**Not proved in CI:** step 1, signature and certificate chain validation. `LOCAL_TESTING` skips it
by design, and Apple's test certificates are not published in the npm tarball. The implementation is
Apple's own library code and is covered by Apple's test suite, but the fact that _your_
`APPLE_ROOT_CERTIFICATES_PEM` produces a working chain is only established by a real sandbox
purchase. Treat that as a required release step, not a nice-to-have; a malformed root bundle fails
every verification, which `describeStoreKitConfig` catches, but a subtly wrong one may not.

Full breakdown in [apple-contract.md](apple-contract.md#what-is-not-verified-here).

## Operational rules

- Keep App Store Connect credentials in Wrangler secrets, never in `wrangler.jsonc`.
- Treat the product allow-list as a deploy-time decision; adding a product is a config change.
- Treat notification UUID uniqueness as the idempotency boundary.
- Return a failure status when persistence fails, so Apple retries.
- Keep production and sandbox credentials and D1 data separated.
- Never expose the operational App Store Server API calls on an unauthenticated route.
