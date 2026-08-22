# HTTP API

The three routes `createStoreKitHandler` mounts, with their exact request and response bodies. Paths
are overridable with the `paths` option; the defaults are shown.

| Method | Default path                  | Authentication            | Purpose                                           |
| ------ | ----------------------------- | ------------------------- | ------------------------------------------------- |
| `POST` | `/storekit/transactions/sync` | your `authenticate`       | Verify a signed StoreKit 2 transaction            |
| `GET`  | `/storekit/entitlement`       | your `authenticate`       | Read the current entitlement for the caller       |
| `POST` | `/storekit/notifications`     | Apple's JWS signature     | App Store Server Notifications V2 webhook         |
| `GET`  | `/storekit/health`            | none (add your own guard) | Configuration report, `createStoreKitWorker` only |

Every response is `application/json; charset=utf-8`. A method that does not match the table answers
`405`.

---

## `POST /storekit/transactions/sync`

Called by your iOS app after a purchase or restore, on `Transaction.updates`, and at launch. The
body carries **only Apple-signed material**: nothing the client asserts about status, price, expiry,
or tier is read.

### Request

```json
{
  "signedTransactionJWS": "eyJhbGciOiJFUzI1NiIsIng1YyI6...",
  "appAccountToken": "6a3f1c5e-6a3f-4c5e-8a3f-1c5e6a3f1c5e"
}
```

| Field                  | Type        | Required | Notes                                                                                           |
| ---------------------- | ----------- | -------- | ----------------------------------------------------------------------------------------------- |
| `signedTransactionJWS` | string      | yes      | `result.jwsRepresentation` from StoreKit 2. 32–16384 characters after trimming.                 |
| `appAccountToken`      | UUID string | no       | The token the client passed to `Product.purchase(options:)`. Must be a lowercase-or-upper UUID. |

Anything else in the body is ignored. A malformed body, a JWS outside the length bounds, or a
non-UUID `appAccountToken` answers `400` **without** calling Apple.

### Response `200`

The full entitlement snapshot, resolved from verified claims only:

```json
{
  "proActive": true,
  "productId": "com.example.app.pro.monthly",
  "expiresAt": "2026-09-21T10:04:12.000Z",
  "accessExpiresAt": "2026-09-21T10:04:12.000Z",
  "perpetual": false,
  "gracePeriodExpiresAt": null,
  "isTrial": false,
  "status": "active_paid",
  "environment": "Production",
  "originalTransactionId": "2000000412345678",
  "latestTransactionId": "2000000498765432",
  "webOrderLineItemId": "2000000012345678",
  "purchaseDate": "2026-08-21T10:04:12.000Z",
  "revocationDate": null,
  "revocationReason": null,
  "appAccountToken": "6a3f1c5e-6a3f-4c5e-8a3f-1c5e6a3f1c5e",
  "productType": "Auto-Renewable Subscription",
  "offerDiscountType": null,
  "signedDate": "2026-08-21T10:04:13.000Z",
  "autoRenewStatus": 1,
  "autoRenewProductId": "com.example.app.pro.monthly",
  "expirationIntent": null,
  "isInBillingRetryPeriod": null,
  "priceIncreaseStatus": null,
  "renewalPrice": 9990,
  "currency": "USD",
  "source": "apple_transaction_lookup",
  "resolvedAt": "2026-08-22T18:00:00.000Z"
}
```

See [Entitlement fields](#entitlement-fields) for what each one means and which to gate features on.

---

## `GET /storekit/entitlement`

Reads the stored projection and **re-evaluates expiry at read time**, so a subscription that lapsed
since the last write reports `proActive: false` without any cron job.

### Response `200`

```json
{
  "proActive": true,
  "productId": "com.example.app.pro.monthly",
  "expiresAt": "2026-09-21T10:04:12.000Z",
  "accessExpiresAt": "2026-09-21T10:04:12.000Z",
  "isTrial": false,
  "status": "active_paid",
  "environment": "Production",
  "autoRenewStatus": 1,
  "autoRenewProductId": "com.example.app.pro.monthly",
  "appAccountToken": "6a3f1c5e-6a3f-4c5e-8a3f-1c5e6a3f1c5e",
  "resolvedAt": "2026-08-22T18:00:00.000Z"
}
```

A caller with no stored purchase is not an error. They get `proActive: false`, `status: "free"`, and
nulls, so a client can treat this route as "what tier is this user on" with no special-casing.

---

## `POST /storekit/notifications`

Apple's App Store Server Notifications V2 webhook. Apple authenticates itself with a JWS signature,
so `authenticate` is never called for this route — do not put a bearer-token gate in front of it.

### Request

Apple's own body:

```json
{ "signedPayload": "eyJhbGciOiJFUzI1NiIsIng1YyI6..." }
```

### Response `200`

```json
{ "processed": true, "replayed": false }
```

`replayed: true` means the notification UUID was already in the ledger; the projection was not
written a second time. Duplicate delivery is normal — Apple retries — and is not an error.

### Status codes Apple sees

| Status | When                                                         | What Apple does              |
| ------ | ------------------------------------------------------------ | ---------------------------- |
| `200`  | Processed, or recognised as a replay                         | Stops retrying               |
| `400`  | Body is not JSON, or `signedPayload` is missing/out of range | Retries                      |
| `401`  | Signature, bundle, environment, or product check failed      | Retries                      |
| `503`  | Apple credentials missing, or D1 unavailable                 | Retries for up to three days |
| `500`  | Anything unexpected                                          | Retries                      |

Retrying on `5xx` is deliberate: a transient D1 failure must not silently drop a renewal. See
[operations.md](operations.md#recovering-from-a-webhook-outage) for replaying a longer outage from
Apple's notification history.

---

## Error responses

Every failure has the same shape:

```json
{ "code": "VALIDATION_ERROR", "message": "StoreKit transaction could not be verified." }
```

| Status | `code`                 | Meaning                                                               |
| ------ | ---------------------- | --------------------------------------------------------------------- |
| `400`  | `VALIDATION_ERROR`     | Malformed request, or Apple-signed material that failed verification  |
| `401`  | `UNAUTHORIZED`         | `authenticate` returned `null`, or a notification failed verification |
| `405`  | `METHOD_NOT_ALLOWED`   | Wrong method for the path                                             |
| `503`  | `UPSTREAM_UNAVAILABLE` | Apple credentials are missing, or D1 is temporarily unavailable       |
| `500`  | `INTERNAL_ERROR`       | Unexpected failure                                                    |

**Verification failures never explain which check rejected them.** A forged payload and a wrong
bundle ID produce the same `400`, so probing teaches an attacker nothing. The stage that failed goes
to your `onEvent` sink instead, as `verificationStage`:

```ts
createStoreKitHandler<Env>({
  authenticate,
  onEvent: (event) => console.log(JSON.stringify(event))
})
```

Structured events carry no secrets, no signed payloads, and no bearer tokens. See
[security.md](security.md#what-is-never-logged-or-returned).

---

## Entitlement fields

| Field                    | Type              | What it is                                                                                        |
| ------------------------ | ----------------- | ------------------------------------------------------------------------------------------------- |
| `proActive`              | boolean           | **Gate features on this.** Access right now, already accounting for grace periods and perpetuity. |
| `accessExpiresAt`        | ISO string / null | When access actually lapses. `null` for a perpetual purchase. **Never gate on `expiresAt`.**      |
| `expiresAt`              | ISO string / null | The subscription's own expiry, which is already in the past during a billing grace period.        |
| `gracePeriodExpiresAt`   | ISO string / null | Apple's grace-period deadline, when one is running.                                               |
| `perpetual`              | boolean           | True for a non-consumable, whose entitlement never lapses.                                        |
| `isTrial`                | boolean           | A **free** trial, keyed off `offerDiscountType` — not paid introductory offers.                   |
| `status`                 | string            | See the table below.                                                                              |
| `productId`              | string / null     | The product currently granting access.                                                            |
| `environment`            | string            | `Production` or `Sandbox`.                                                                        |
| `autoRenewStatus`        | 0/1 / null        | `0` = the customer turned off renewal; access continues until `accessExpiresAt`.                  |
| `autoRenewProductId`     | string / null     | What renews next, which differs from `productId` after an upgrade or downgrade.                   |
| `expirationIntent`       | 1–4 / null        | Why it expired: `1` cancelled, `2` billing error, `3` price-increase refusal, `4` unavailable.    |
| `isInBillingRetryPeriod` | boolean / null    | Apple is retrying payment.                                                                        |
| `priceIncreaseStatus`    | 0/1 / null        | `0` = the customer has not consented to a price rise yet.                                         |
| `renewalPrice`           | number / null     | In milliunits of `currency` (`9990` = 9.99).                                                      |
| `currency`               | string / null     | ISO 4217.                                                                                         |
| `originalTransactionId`  | string / null     | The stable id for the whole subscription lifecycle. Use it as your join key to Apple.             |
| `latestTransactionId`    | string / null     | The most recent transaction behind this snapshot.                                                 |
| `webOrderLineItemId`     | string / null     | Identifies a single renewal period.                                                               |
| `appAccountToken`        | string / null     | The UUID your client pinned at purchase.                                                          |
| `purchaseDate`           | ISO string / null | Original purchase time.                                                                           |
| `revocationDate`         | ISO string / null | Set on a refund or family-sharing revocation. Terminal.                                           |
| `revocationReason`       | 0/1 / null        | `1` = refunded for an app issue, `0` = other.                                                     |
| `productType`            | string / null     | Apple's type, e.g. `Auto-Renewable Subscription`, `Non-Consumable`.                               |
| `offerDiscountType`      | string / null     | `FREE_TRIAL`, `PAY_AS_YOU_GO`, `PAY_UP_FRONT`.                                                    |
| `signedDate`             | ISO string / null | Apple's signing time, which is the out-of-order write guard.                                      |
| `source`                 | string            | `posted_jws`, `apple_transaction_lookup`, or `app_store_history`.                                 |
| `resolvedAt`             | ISO string        | When this answer was computed.                                                                    |

### `status` values

| Value           | Access | Meaning                                                                                 |
| --------------- | ------ | --------------------------------------------------------------------------------------- |
| `active_paid`   | yes    | Paid and current.                                                                       |
| `active_trial`  | yes    | In a **free** trial.                                                                    |
| `grace_period`  | yes¹   | Renewal failed; Apple is retrying and still serving the customer.                       |
| `perpetual`²    | yes    | Non-consumable, reported through `perpetual: true` with `status: "active_paid"`.        |
| `billing_retry` | no     | Retrying with no grace period left. Prompt for a payment update, do not treat as churn. |
| `expired`       | no     | Lapsed.                                                                                 |
| `revoked`       | no     | Family sharing or entitlement revoked.                                                  |
| `refunded`      | no     | Refunded. Terminal, and it can arrive after a newer renewal.                            |
| `free`          | no     | No purchase on record.                                                                  |
| `unknown`       | no     | Apple returned a status this version does not map.                                      |

¹ Controlled by `STOREKIT_ALLOW_GRACE_PERIOD_ACCESS`, which defaults to `true` (Apple's intent).
² Not a distinct `status` string; check the `perpetual` boolean.
