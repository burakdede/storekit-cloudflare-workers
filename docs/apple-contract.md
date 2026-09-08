# Apple contract references

This project follows Apple's StoreKit server contracts and the official Apple server library. Verify
these documents when Apple changes notification fields or API behavior:

- [App Store Server API](https://developer.apple.com/documentation/appstoreserverapi)
- [Get Transaction Info](https://developer.apple.com/documentation/appstoreserverapi/get-transaction-info)
- [Get All Subscription Statuses](https://developer.apple.com/documentation/AppStoreServerAPI/Get-All-Subscription-Statuses)
- [App Store Server Notifications V2](https://developer.apple.com/documentation/appstoreservernotifications/app-store-server-notifications-v2)
- [Receiving Notifications](https://developer.apple.com/documentation/appstoreservernotifications/receiving-app-store-server-notifications)
- [Responding to Notifications](https://developer.apple.com/documentation/AppStoreServerNotifications/responding-to-app-store-server-notifications)
- [JWSRenewalInfoDecodedPayload](https://developer.apple.com/documentation/appstoreserverapi/jwsrenewalinfodecodedpayload)
- [Get Notification History](https://developer.apple.com/documentation/appstoreserverapi/get-notification-history)
- [Send Consumption Information](https://developer.apple.com/documentation/appstoreserverapi/send-consumption-information)
- [Apple PKI root certificates](https://www.apple.com/certificateauthority/)

## Fields this module depends on

| Apple field                               | Why it matters here                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `status` (subscription)                   | 1 active, 2 expired, 3 billing retry, 4 grace period, 5 revoked        |
| `gracePeriodExpiresDate` (renewal info)   | The real access deadline during status 4; `expiresDate` has passed     |
| `offerDiscountType` (transaction)         | Distinguishes a free trial from a paid introductory offer              |
| `revocationDate` / `revocationReason`     | Refunds and family-sharing revocations; terminal                       |
| `revocationType` / `revocationPercentage` | Separates a refund from a family revoke; the proportion, in milliunits |
| `signedDate`                              | Apple's signing time, used to order out-of-order notification delivery |
| `type`                                    | Identifies a non-consumable, which never expires                       |
| `inAppOwnershipType` (transaction)        | `PURCHASED` vs `FAMILY_SHARED`; drives the family-sharing policy       |

The service intentionally treats Apple-signed data as authoritative only after signature, bundle,
environment, product, and transaction identity validation. It does not implement legacy receipt or
V1 notification flows.

## How conformance is verified

`@apple/app-store-server-library` is pinned to an exact version, so nothing about Apple's contract
changes silently at install time. Keeping that pin honest is the job of
`test/unit/storekit-apple-sdk-conformance.test.ts`, which exists because every other test in the
suite stubs the verifier boundary. That is the right design for exercising policy, but it means no
other test would notice Apple changing underneath us.

It covers three things.

**Value drift.** The entitlement policy compares against bare literals: `"FREE_TRIAL"`,
`"Non-Consumable"`, offer type `1`, status `1` through `5`, and the environment names. TypeScript
cannot catch a literal that stops matching Apple's enum, because both sides remain ordinary strings
and numbers. Each literal is therefore asserted equal to the SDK's own exported enum
(`OfferDiscountType`, `Type`, `OfferType`, `Status`, `Environment`, `RevocationReason`,
`AutoRenewStatus`, `ExpirationIntent`, `InAppOwnershipType`, `RevocationType`). Without this, an SDK bump could misclassify every trial as
paid, or revoke every non-consumable, with a green test suite.

**Shape drift.** Type-level assignments prove Apple's `JWSTransactionDecodedPayload` and
`JWSRenewalInfoDecodedPayload` still satisfy the policy's structural input types. A renamed or
retyped field fails `npm run typecheck` rather than failing silently at runtime.

**Real decoding.** The tests run a genuine `SignedDataVerifier` under `Environment.LOCAL_TESTING`,
Apple's own escape hatch for local StoreKit testing. It skips signature and certificate-chain
verification but still performs Apple's real base64 decoding, schema validation, and bundle and
environment claim checks. Real ES256-signed payloads pass through it into this module's claim
checks and entitlement policy, including a case that proves the grace-period behaviour on a
genuinely decoded `gracePeriodExpiresDate`.

The value assertions were mutation-tested rather than assumed: renaming `FREE_TRIAL` or
`Non-Consumable` in the source each fails exactly one test.

### When CI runs

| Trigger            | Purpose                                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull request       | Full gate: format, lint, typecheck, tests, Worker dry-run build.                                                                                      |
| Push to `main`     | Same gate.                                                                                                                                            |
| Weekly schedule    | Catches a break that lands without anyone touching this repository.                                                                                   |
| Dependabot PR      | An SDK bump must pass the conformance suite before it can be merged.                                                                                  |
| `apple-sdk-latest` | Advisory job running conformance against `@apple/app-store-server-library@latest`, so a breaking Apple release is visible before the bump PR arrives. |

The `apple-sdk-latest` job is `continue-on-error` deliberately. It is an early warning, and it must
never block a pull request on Apple's release timing.

## What is NOT verified here

Being explicit about the limits, because the sections above could otherwise read as a stronger
guarantee than they are.

| Not covered                           | Why                                                                                                                                           | What covers it instead                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Certificate chain validation          | `LOCAL_TESTING` skips it by design, and Apple's test certificates are not in the npm tarball (`files: ["dist"]` excludes `tests/resources/`). | Apple's own test suite. To test it here you would vendor their Apache-2.0 test CA from GitHub. |
| OCSP revocation checking              | Disabled: Apple's SDK OCSP path calls `Response.buffer()`, which the Workers runtime does not provide.                                        | Nothing. This is a documented, accepted limitation; see `docs/security.md`.                    |
| Apple's live API response shapes      | No test calls the real App Store Server API. It needs real credentials and a real subscriber.                                                 | Sandbox testing before release; see `docs/release-checklist.md`.                               |
| Apple's server-side behaviour changes | If Apple starts populating a field differently without changing the SDK, no static check can see it.                                          | Sandbox testing, and the weekly CI run only if the SDK itself changes.                         |
| Real notification delivery            | Apple's retry timing and delivery order cannot be reproduced locally.                                                                         | `requestStoreKitTestNotification` against a deployed Worker.                                   |

The practical consequence: **CI proves this module still agrees with the Apple SDK. It does not
prove the SDK still agrees with Apple's servers.** Sandbox testing is not optional before a
release, and the checklist treats it that way.

## Trademarks

This is an independent project, not affiliated with, endorsed by, or sponsored by Apple Inc. or
Cloudflare, Inc. Apple, App Store, StoreKit, and TestFlight are trademarks of Apple Inc. Cloudflare,
Cloudflare Workers, and D1 are trademarks of Cloudflare, Inc. They are used here only to identify
the services this software interoperates with.
