# Security policy

## Reporting a vulnerability

**Do not open a public issue** for a suspected vulnerability or a credential exposure.

Use GitHub's [private vulnerability reporting](../../security/advisories/new) on this repository.
If that is unavailable to you, contact the maintainer directly and say only that you have a
security report; do not include details in the first message.

Please include:

- What an attacker can achieve, and the preconditions they need.
- The affected file or function, and a reproduction if you have one.
- The version or commit you tested.

**Never include** an App Store Connect private key, an Apple bearer token, a signed transaction or
notification payload, or a customer identifier. Describe the shape of the data instead. Nothing in
a real payload is needed to explain a vulnerability, and sending one turns your report into a
second incident.

Expect an acknowledgement within a few days. Please give a reasonable window to ship a fix before
disclosing publicly.

## Scope

In scope: anything that lets a party obtain or retain entitlement they did not pay for, bind a
purchase to the wrong account, bypass a verification or identity check, or extract a secret through
a log or an HTTP response.

Out of scope, because they are documented and deliberate:

- **`src/auth.ts` returns `null`.** It fails closed on purpose. Authentication is the adopter's
  responsibility; see [`docs/security.md`](docs/security.md).
- **OCSP revocation checking is disabled.** Apple's SDK OCSP path calls `Response.buffer()`, which
  the Workers runtime does not provide. Signature and certificate chain validation are unaffected.
- **`STOREKIT_ALLOW_APPLE_LOOKUP_FALLBACK=true` accepts a signed but stale transaction while
  Apple's API is unreachable.** This is a configurable trade-off, documented in
  [`docs/configuration.md`](docs/configuration.md). Set it to `false` to fail closed.
- **The notification webhook is unauthenticated at the HTTP layer.** Apple authenticates by JWS
  signature; there is no bearer token to check. Rate limiting belongs in front of the route.

If you believe one of the above is exploitable beyond what is documented, that is in scope; please
report it.

## For adopters

Read [`docs/security.md`](docs/security.md) before deploying. The two controls people most often
miss are pinning `expectedAppAccountToken`, which is what stops a signed transaction being replayed
onto another account, and gating access on `accessExpiresAt` rather than `expiresAt`.
