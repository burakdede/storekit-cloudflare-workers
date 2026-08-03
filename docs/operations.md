# Operations

## Notification handling

`POST /storekit/notifications` verifies the outer V2 payload, enforces the mutually exclusive
payload shape and `version === "2.0"`, checks the replay ledger, and updates the entitlement
projection.

By default it then **re-reads Apple's `Get All Subscription Statuses`** rather than trusting the
notification payload alone. The payload is a point-in-time snapshot that may be delivered late;
Apple's status endpoint is current. This is also what lets a `REFUND` or `REVOKE` revoke access even
though those payloads carry no subscription `status` field — the revocation date on the signed
transaction is enough. Set `STOREKIT_RECONCILE_NOTIFICATIONS=false` to skip the extra call.

Notifications without transaction data — `TEST`, summaries, external purchase tokens, app data — are
verified for outer identity and recorded without touching entitlement state.

### Response codes

| Status | Meaning                                                                                      |
| ------ | -------------------------------------------------------------------------------------------- |
| `200`  | Processed, or a duplicate. Returning 200 for a replay is deliberate — the event was handled. |
| `401`  | The payload did not verify. Never answer 200 to an unverified payload.                       |
| `503`  | Transient persistence failure. Apple retries, which is what you want.                        |

Apple retries non-2xx responses over a period of days, so a transient failure recovers on its own.

### Out-of-order delivery

Apple does not guarantee ordering. Every projection row carries `latest_signed_date` — **Apple's**
signing time, not the server clock, because a late-arriving old event has a _newer_ clock reading —
and an upsert only applies when the incoming signed date is at least as recent as the stored one.
Revocations bypass the guard because a refund is terminal and must always land.

When investigating "state looks stale", compare `latest_signed_date` on the row against the
notification you expected to land.

## Recovering from a webhook outage

Apple retains notification history, so missed events can be replayed through the same verified path.
The replay ledger makes this safe to run more than once.

First confirm the webhook is reachable:

```ts
await requestStoreKitTestNotification(env)
```

Then page through the outage window:

```ts
import {
  getStoreKitNotificationHistory,
  processStoreKitNotification
} from "./storekit"

let paginationToken: string | null = null
do {
  const page = await getStoreKitNotificationHistory(
    env,
    { startDate: outageStart, endDate: outageEnd },
    paginationToken
  )
  for (const entry of page.notificationHistory ?? []) {
    if (entry.signedPayload) {
      await processStoreKitNotification(entry.signedPayload, {
        apple: env,
        d1: env.STOREKIT_DB
      })
    }
  }
  paginationToken = page.paginationToken ?? null
} while (paginationToken)
```

## Other operational calls

All are privileged. Never expose them on an unauthenticated route.

| Function                                | Use                                                 |
| --------------------------------------- | --------------------------------------------------- |
| `requestStoreKitTestNotification`       | Prove the webhook is reachable and verifying        |
| `getStoreKitNotificationHistory`        | Reconcile after an outage                           |
| `getStoreKitTransactionHistory`         | Full signed history for a customer                  |
| `getStoreKitRefundHistory`              | Refunds for a customer                              |
| `lookUpStoreKitOrderId`                 | Resolve a customer-supplied order ID during support |
| `extendStoreKitSubscriptionRenewalDate` | Goodwill extension after an incident                |
| `sendStoreKitConsumptionInformation`    | Answer a `CONSUMPTION_REQUEST` notification         |

Apple sends `CONSUMPTION_REQUEST` when a customer requests a refund and has consented to share
consumption data; responding lets Apple weigh your usage data in the decision. Apple specifies a
response deadline, so handle it promptly rather than in a nightly batch, and only send data when
`consentStatus` reflects genuine consent.

Extensions produce a `RENEWAL_EXTENSION` notification, so the projection updates through the normal
webhook path — no separate write is needed.

## Inspecting state

```bash
npx wrangler d1 execute STOREKIT_DB --remote --command="
  SELECT installation_id, product_id, status, expires_at, access_expires_at, perpetual,
         auto_renew_status, expiration_intent, revocation_date, latest_signed_date
  FROM storekit_subscriptions
  WHERE installation_id = 'ACCOUNT-ID'"
```

Read `access_expires_at`, never `expires_at`. During a billing grace period the subscription's own
`expires_at` is already in the past while the customer legitimately keeps access.

Active subscribers:

```bash
npx wrangler d1 execute STOREKIT_DB --remote --command="
  SELECT COUNT(*) FROM storekit_subscriptions
  WHERE status IN ('active_trial','active_paid','grace_period')
    AND (perpetual = 1 OR access_expires_at > datetime('now'))"
```

## Troubleshooting

| Symptom                                                  | Likely cause                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| 503 `StoreKit verification is not configured.`           | A secret is missing. Check `GET /health`.                    |
| Every transaction rejected, stage `submitted_jws_decode` | Wrong or empty `APPLE_ROOT_CERTIFICATES_PEM`.                |
| Rejected with stage `submitted_jws_claims`               | Bundle ID, environment, or product not on the allow-list.    |
| Production notifications fail, sandbox works             | `APP_STORE_APP_APPLE_ID` missing or wrong.                   |
| `apple_transaction_lookup` failures, HTTP 401            | API key wrong, revoked, or lacking the In-App Purchase role. |
| Grace-period customers lose access                       | Gating on `expiresAt` instead of `accessExpiresAt`.          |
| Webhook never fires                                      | V2 URL not set in App Store Connect.                         |
| `nodejs_compat` errors at deploy                         | Flag missing, or `compatibility_date` too old.               |

The failing stage is in your `onEvent` sink under `verificationStage`; it is never in the HTTP
response. Never copy JWS or credential values into logs or tickets.

## Incident response

If D1 is unavailable, keep failure responses enabled so Apple retries, then reconcile notification
history after recovery. If Apple verification fails broadly, inspect only the structured stage and
operation diagnostics.
