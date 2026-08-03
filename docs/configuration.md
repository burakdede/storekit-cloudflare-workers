# Configuration

Non-secret values go in `wrangler.jsonc` under `vars`. Everything in [Secrets](#secrets) must be set
with `wrangler secret put` and must never be committed.

Validate a deployment before it serves traffic:

```ts
import { assertStoreKitConfig, describeStoreKitConfig } from "./storekit"

assertStoreKitConfig(env) // throws, listing every problem at once

const report = describeStoreKitConfig(env)
// { valid: false, problems: ["APP_STORE_CONNECT_KEY_ID is required.", ...],
//   secretsPresent: { APP_STORE_CONNECT_KEY_ID: false, ... } }
```

`describeStoreKitConfig` reports secret **presence** only, never a value, so its output is safe to
log or expose on an operator dashboard. The reference Worker serves it from `GET /health`. It
catches the mistakes that actually happen: a `.p8` pasted without its PEM header, a root bundle
containing no certificate block, a non-numeric app ID, an empty product allow-list.

## Worker variables

| Variable                               | Required             | Meaning                                                                      |
| -------------------------------------- | -------------------- | ---------------------------------------------------------------------------- |
| `STOREKIT_ALLOWED_ENVIRONMENTS`        | yes                  | `Production`, `Sandbox`, or both comma-separated. Production is tried first. |
| `STOREKIT_BUNDLE_ID`                   | yes                  | Exact App Store bundle ID. Transactions for any other bundle are rejected.   |
| `STOREKIT_ALLOWED_PRODUCT_IDS`         | yes                  | Closed, comma-separated product allow-list.                                  |
| `APP_STORE_APP_APPLE_ID`               | production only      | Numeric app ID; Apple requires it to verify production notifications.        |
| `STOREKIT_ALLOW_APPLE_LOOKUP_FALLBACK` | no (default `true`)  | `false` fails sync closed when Apple's API is unreachable. See below.        |
| `STOREKIT_ALLOW_GRACE_PERIOD_ACCESS`   | no (default `true`)  | Whether a billing grace period keeps access. Apple's intent is that it does. |
| `STOREKIT_RECONCILE_NOTIFICATIONS`     | no (default `true`)  | Re-read Apple's status on each notification instead of trusting the payload. |
| `STOREKIT_ALLOW_SANDBOX_PRE_RELEASE`   | no (default `false`) | Allows sandbox transactions on a production deployment. See below.           |

Booleans accept `true/1/yes/on` and `false/0/no/off`; anything else falls back to the default.

Policy is read from `env`, so changing it is a `wrangler.jsonc` edit and a redeploy rather than a
source change. The equivalent `createStoreKitHandler` options override the variables when set.

## Secrets

| Secret                          | Where it comes from                                                          |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `APP_STORE_CONNECT_ISSUER_ID`   | App Store Connect → Integrations → App Store Connect API, above the key list |
| `APP_STORE_CONNECT_KEY_ID`      | Shown next to the key you generate                                           |
| `APP_STORE_CONNECT_PRIVATE_KEY` | The full `.p8` contents, `BEGIN`/`END` lines and newlines preserved          |
| `APPLE_ROOT_CERTIFICATES_PEM`   | Apple's PKI root certificates, converted to PEM and concatenated             |

### App Store Connect API key

**Users and Access → Integrations → App Store Connect API**, and generate a key with the **In-App
Purchase** role. The Admin-level Team key also works but grants far more than this needs.

Apple lets you download the `.p8` **once**.

```bash
npx wrangler secret put APP_STORE_CONNECT_PRIVATE_KEY < AuthKey_ABC123XYZ.p8
```

### Apple root certificates

The module verifies Apple's JWS certificate chains **offline** against these roots, so an empty or
malformed bundle means no signature can ever be trusted. Download them from
[Apple's PKI page](https://www.apple.com/certificateauthority/), convert to PEM, and concatenate:

```bash
for cert in AppleRootCA-G3 AppleComputerRootCertificate AppleIncRootCertificate; do
  openssl x509 -inform der -in "$cert.cer" -out "$cert.pem"
done
cat *.pem | npx wrangler secret put APPLE_ROOT_CERTIFICATES_PEM
```

`AppleRootCA-G3` signs current StoreKit JWS material; including the others is harmless and covers
older chains.

## The D1 binding

The module never assumes a binding name. It defaults to `env.STOREKIT_DB`; anything else is one
option:

```ts
createStoreKitHandler<Env>({
  authenticate,
  database: (env) => env.MY_EXISTING_DB
})
```

Calling the service layer directly, pass the binding itself: `{ apple: env, d1: env.MY_DB }`.

## `STOREKIT_ALLOW_APPLE_LOOKUP_FALLBACK`

A submitted transaction JWS is itself cryptographically verifiable, so when Apple's API is
unreachable the module can still resolve an entitlement from the signed expiry and revocation claims
it already checked.

- `true` (default) — a customer who paid keeps access during an Apple outage. The trade-off is that
  a signed-but-stale transaction can be replayed to extend access until its own signed expiry.
- `false` — sync answers 503 during an Apple outage. Choose this when a stale grant is worse than a
  temporary denial.

Either way the choice never weakens signature verification, and the source used is reported to your
event sink.

## `STOREKIT_ALLOW_SANDBOX_PRE_RELEASE`

Sandbox transactions are free, so accepting them on a production deployment means giving away paid
access. It defaults to off. If you enable it for TestFlight builds, gate it further in your
`authenticate` adapter by returning `sandboxAllowed` only for the specific builds you trust.

## Environments

Allowing `Sandbox` is a deliberate server policy decision, never something a client can influence. A
production Worker should normally allow only `Production`; a staging Worker only `Sandbox`. Keep
production and sandbox credentials and D1 databases separate.
