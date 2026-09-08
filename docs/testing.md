# Testing your integration

What to test, where, and what this package already covers so you do not test it twice.

The short version: **test your tier rules against the policy kernel, test your integration against a
stubbed Apple, and use sandbox for the things only Apple can tell you.**

## What you do not need to test

The package's own suite covers these, so a test you write here duplicates one that already exists:

- Signature and certificate chain verification, including a forged chain, a tampered body, an expired
  chain and a wrong bundle id.
- Entitlement policy: grace periods, billing retry, trials versus paid introductory offers,
  non-consumables, Family Sharing, upgrades and every revocation type.
- Out-of-order notification delivery, the replay ledger, and the SQL behind all of it.

What is worth your time is the part the package cannot know about: **who your users are, what you
unlock, and what your app does when an entitlement changes.**

---

## 1. Tier rules, against the pure kernel

`resolveStoreKitEntitlementCore` has no Apple SDK, no D1, no HTTP and no clock of its own, and the
`/entitlement` subpath pulls in none of the Apple library. Feed it plain objects.

```ts
import { resolveStoreKitEntitlementCore } from "storekit-cloudflare-workers/entitlement"

const snapshot = resolveStoreKitEntitlementCore(
  {
    environment: "Sandbox",
    transaction: {
      transactionId: "tx-1",
      originalTransactionId: "otx-1",
      productId: "com.example.pro.annual",
      expiresDate: Date.parse("2099-01-01T00:00:00Z")
    },
    latestSubscriptionStatus: 1,
    subscriptionTransactions: [],
    verificationSource: "posted_jws"
  },
  new Date("2026-06-01T00:00:00Z")
)

expect(myTierFor(snapshot)).toBe("pro")
```

This is the cheapest place to pin the cases that cost money if you get them wrong: that a
`grace_period` customer keeps access, that a `billing_retry` customer sees a payment prompt rather
than a churn flow, and that `family_shared` does or does not count for you.

---

## 2. Your integration, against a stubbed Apple

Pass `runtimes` to supply an Apple runtime you control. Everything else stays real — your
`authenticate`, the entitlement policy, the D1 writes, the HTTP status codes.

The runtime's `verifier` is structural, so **fixtures can be plain JSON and the verifier can just
parse them.** No certificates, no signing keys, no App Store Connect credentials:

```ts
const transaction = {
  transactionId: "tx-1",
  originalTransactionId: "otx-1",
  bundleId: "com.example.app",
  productId: "com.example.pro.monthly",
  environment: "Sandbox",
  type: "Auto-Renewable Subscription",
  signedDate: Date.now(),
  expiresDate: Date.parse("2099-01-01T00:00:00Z")
}
const decode = async (jws: string) => JSON.parse(jws)

const storekit = createStoreKitHandler<Env>({
  authenticate: myAuthenticate,
  database: (env) => env.DB,
  runtimes: () => [
    {
      environment: "Sandbox",
      bundleId: "com.example.app",
      allowedProductIds: new Set(["com.example.pro.monthly"]),
      allowAppleLookupFallback: false,
      client: {
        getTransactionInfo: async () => ({
          signedTransactionInfo: JSON.stringify(transaction)
        }),
        getAllSubscriptionStatuses: async () => ({
          environment: "Sandbox",
          bundleId: "com.example.app",
          data: [
            {
              lastTransactions: [
                {
                  status: 1,
                  originalTransactionId: "otx-1",
                  signedTransactionInfo: JSON.stringify(transaction)
                }
              ]
            }
          ]
        })
      },
      verifier: {
        verifyAndDecodeTransaction: decode,
        verifyAndDecodeNotification: decode,
        verifyAndDecodeRenewalInfo: decode
      }
    }
  ]
})
```

Post `JSON.stringify(transaction)` as `signedTransactionJWS` and the whole stack runs. Note the body
validation requires at least 32 characters, which any real transaction fixture exceeds.

Worth covering here, because these are yours and not ours:

- `authenticate` returning `null` answers `401`, and your session logic decides when that happens.
- A second account syncing the same transaction answers `409`; make sure your client treats that as
  terminal rather than retrying it forever.
- `onEntitlementChange` firing, and your own tables being updated by it.
- Whatever you unlock when `proActive` flips.

### Turn the Apple fallback off in tests

```ts
STOREKIT_ALLOW_APPLE_LOOKUP_FALLBACK: "false"
```

`true` (the default) is right in production — a paying customer keeps access during an Apple outage.
It is wrong in a test suite, because a request that could not reach Apple **still succeeds**, quietly
resolving the entitlement from the client's own JWS.

This is not hypothetical. An earlier version of this package's own end-to-end test had a stub that
silently was not applied, so every request fell through to the real Apple API, failed, and degraded
to the submitted JWS. Six of seven tests passed. Setting this to `false` failed four of them
immediately and is what exposed it.

If your integration tests pass, that flag is on, and you never assert on which source was used, you
have not proved Apple was consulted.

### Apple's `LOCAL_TESTING` environment does not work here

Apple's SDK offers `Environment.LOCAL_TESTING`, which skips signature and chain verification. It is a
dead end for this package: `STOREKIT_ALLOWED_ENVIRONMENTS` accepts only `Sandbox` and `Production`,
so the entitlement read answers `503` even when a sync appears to work. That restriction is
deliberate — it keeps a production deployment from accepting anything but real Apple environments —
so use the stub verifier above instead.

---

## 3. Sandbox, for what only Apple can tell you

Some things no local test can establish, because they depend on Apple's servers and your App Store
Connect configuration:

| Only sandbox proves                                               | Why                                                                                                         |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Your `APPLE_ROOT_CERTIFICATES_PEM` holds Apple's real roots       | The suite supplies its own CA, so it proves the verifier enforces the rules, not that your secret is right. |
| Your App Store Connect key works and has the In-App Purchase role | A wrong or under-privileged key fails only against the real API.                                            |
| The webhook URL is reachable and verifying                        | `requestStoreKitTestNotification(env)` asks Apple to deliver a real one.                                    |
| Your product ids match `STOREKIT_ALLOWED_PRODUCT_IDS`             | A typo here rejects every real purchase.                                                                    |
| `APP_STORE_APP_APPLE_ID` is right                                 | Production notifications fail without it; sandbox does not notice.                                          |

Sandbox subscription periods are accelerated, so renewal, expiry and grace-period paths are all
reachable in one sitting. Force a billing failure from **Settings > Developer > Sandbox Apple
Account** to exercise `grace_period` and `billing_retry`.

`GET /storekit/health` reports every configuration problem at once, with secret presence but never a
value. Check it first — most sandbox failures are a missing secret rather than a code problem.

---

## Checking it end to end

The fastest proof that the whole chain works:

1. `GET /storekit/health` returns `200`.
2. `await requestStoreKitTestNotification(env)` and confirm a row lands in `storekit_notifications`.
3. Make a sandbox purchase, sync it, and confirm `GET /storekit/entitlement` reports `proActive`.
4. Refund it in sandbox and confirm the entitlement goes to `refunded`.

Step 4 is the one people skip, and refunds are where server-side StoreKit integrations most often
turn out to be wrong.
