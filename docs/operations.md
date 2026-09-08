# Operations

## Notification handling

`POST /storekit/notifications` verifies the outer V2 payload, enforces the mutually exclusive
payload shape and `version === "2.0"`, checks the replay ledger, and updates the entitlement
projection.

By default it then **re-reads Apple's `Get All Subscription Statuses`** rather than trusting the
notification payload alone. The payload is a point-in-time snapshot that may be delivered late;
Apple's status endpoint is current. This is also what lets a `REFUND` or `REVOKE` revoke access even
though those payloads carry no subscription `status` field; the revocation date on the signed
transaction is enough. Set `STOREKIT_RECONCILE_NOTIFICATIONS=false` to skip the extra call.

Notifications without transaction data (`TEST`, summaries, external purchase tokens, app data) are
verified for outer identity and recorded without touching entitlement state.

### Response codes

| Status | Meaning                                                                                     |
| ------ | ------------------------------------------------------------------------------------------- |
| `200`  | Processed, or a duplicate. Returning 200 for a replay is deliberate; the event was handled. |
| `401`  | The payload did not verify. Never answer 200 to an unverified payload.                      |
| `503`  | Transient persistence failure. Apple retries, which is what you want.                       |

Apple retries non-2xx responses over a period of days, so a transient failure recovers on its own.

### Out-of-order delivery

Apple does not guarantee ordering. Every projection row carries `latest_signed_date`, **Apple's**
signing time, not the server clock, because a late-arriving old event has a _newer_ clock reading,
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
import { getStoreKitNotificationHistory, processStoreKitNotification } from "./storekit"

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
consumption data; responding lets Apple weigh your usage data in the decision. **Apple's window is
12 hours**, so it has to be answered from the webhook rather than a nightly batch — switch on the
notification type in your `onEvent` sink and respond inline. Only send data when `consentStatus`
reflects genuine consent.

Extensions produce a `RENEWAL_EXTENSION` notification, so the projection updates through the normal
webhook path; no separate write is needed.

## Inspecting state

```bash
npx wrangler d1 execute STOREKIT_DB --remote --command="
  SELECT installation_id, product_id, subscription_group_identifier, status,
         expires_at, access_expires_at, renewal_date, perpetual,
         auto_renew_status, expiration_intent, in_app_ownership_type, is_upgraded,
         revocation_date, revocation_type, latest_signed_date
  FROM storekit_subscriptions
  WHERE installation_id = 'ACCOUNT-ID'"
```

Read `access_expires_at`, never `expires_at`. During a billing grace period the subscription's own
`expires_at` is already in the past while the customer legitimately keeps access.

An account can hold more than one row: one per subscription group, plus any non-consumables. When a
customer says a product is missing, check for a second row before concluding the entitlement is
wrong.

`revocation_type` separates a refund from Family Sharing ending — `FAMILY_REVOKE` means nobody was
refunded and the organiser's subscription is unaffected. `in_app_ownership_type` says whether the
customer paid or a family organiser did, which is usually the answer when someone cannot find a
subscription to manage.

Active subscribers:

```bash
npx wrangler d1 execute STOREKIT_DB --remote --command="
  SELECT COUNT(*) FROM storekit_subscriptions
  WHERE status IN ('active_trial','active_paid','grace_period')
    AND (perpetual = 1 OR access_expires_at > datetime('now'))"
```

That counts entitlements, not people: an account holding two subscription groups contributes two.
Count `DISTINCT installation_id` for subscribers, and exclude Family Sharing recipients from a
revenue figure. `IS NOT` rather than `!=` on purpose — it is null-safe in SQLite, so rows written
before `in_app_ownership_type` existed still count, which is right because they are purchases:

```bash
npx wrangler d1 execute STOREKIT_DB --remote --command="
  SELECT COUNT(DISTINCT installation_id) FROM storekit_subscriptions
  WHERE status IN ('active_trial','active_paid','grace_period')
    AND (perpetual = 1 OR access_expires_at > datetime('now'))
    AND in_app_ownership_type IS NOT 'FAMILY_SHARED'"
```

## Troubleshooting

| Symptom                                                  | Likely cause                                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 503 `StoreKit verification is not configured.`           | A secret is missing. Check `GET /storekit/health`.                               |
| Every transaction rejected, stage `submitted_jws_decode` | Wrong or empty `APPLE_ROOT_CERTIFICATES_PEM`.                                    |
| Rejected with stage `submitted_jws_claims`               | Bundle ID, environment, or product not on the allow-list.                        |
| Production notifications fail, sandbox works             | `APP_STORE_APP_APPLE_ID` missing or wrong.                                       |
| `apple_transaction_lookup` failures, HTTP 401            | API key wrong, revoked, or lacking the In-App Purchase role.                     |
| Grace-period customers lose access                       | Gating on `expiresAt` instead of `accessExpiresAt`.                              |
| Webhook never fires                                      | V2 URL not set in App Store Connect.                                             |
| `nodejs_compat` errors at deploy                         | Flag missing, or `compatibility_date` too old.                                   |
| `409` on sync, event `..._ownership_conflict`            | The transaction is bound to another account. See below.                          |
| A second product never unlocks                           | Client gating on the top-level `productId` rather than the `entitlements` array. |
| Reported tier is the one the customer upgraded away from | A stale `isUpgraded` transaction; re-sync to pick up its replacement.            |
| A refund shows for a customer nobody refunded            | `family_revoked` read as `refunded`. Check `revocation_type`.                    |
| Entitlements stop mirroring to your own tables           | `storekit_entitlement_change_hook_failed` in your event sink.                    |

The failing stage is in your `onEvent` sink under `verificationStage`; it is never in the HTTP
response. Never copy JWS or credential values into logs or tickets.

## Ownership conflicts

A sync answers `409 OWNERSHIP_CONFLICT` when the transaction's entitlement is already bound to a
different account, and writes nothing. The event carries the transaction so it can be traced:

```json
{
  "event": "storekit_transaction_sync_ownership_conflict",
  "originalTransactionId": "2000000412345678",
  "environment": "Production"
}
```

A trickle is normal — a customer signing into a new account on the same device. A spike is worth
investigating: either a client is retrying a terminal error in a loop, or somebody is replaying
captured transactions.

Find who holds it:

```bash
npx wrangler d1 execute STOREKIT_DB --remote --command="
  SELECT installation_id, product_id, status, access_expires_at
  FROM storekit_subscriptions
  WHERE original_transaction_id = '2000000412345678'"
```

If the customer genuinely needs the purchase moved, verify them through your own support flow and run
that one sync with `allowAccountTransfer: true`. Do not set `STOREKIT_ALLOW_ACCOUNT_TRANSFER`
deployment-wide to clear a support ticket: it re-opens, for every request, the hole the default
exists to close.

## Entitlement change hook failures

A hook that throws is reported and swallowed, because the write has already committed and a non-2xx
answer would make Apple redeliver a notification that was in fact processed. The cost is that a
failing hook is silent unless you watch for it:

```json
{ "event": "storekit_entitlement_change_hook_failed", "message": "..." }
```

Alert on it. The projection stays correct while the hook is failing, so the symptom is your _own_
tables drifting out of step — which is invisible from the StoreKit data.

## Incident response

If D1 is unavailable, keep failure responses enabled so Apple retries, then reconcile notification
history after recovery. If Apple verification fails broadly, inspect only the structured stage and
operation diagnostics.
