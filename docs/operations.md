# Operations

## Notification handling

`POST /v1/storekit/notifications` verifies the outer V2 signed payload, validates the mutually
exclusive payload shape, records the notification UUID, and optionally updates the subscription
projection when transaction data is present. Duplicate UUIDs return success without duplicating state.

If D1 persistence fails, the route returns a failure response. Apple can retry unsuccessful V2 posts.
The endpoint should remain reachable over HTTPS and should not depend on user authentication.

## Missed notifications

Notifications are not a complete reconciliation mechanism. After an outage, use Apple’s App Store
Server API to retrieve current subscription statuses and transaction history, and use notification
history to identify missed V2 events. Re-run verified transaction sync or build a controlled
reconciliation job around the exported service functions.

## Deployment checks

Run:

```bash
npm run release:check
npm run db:migrate:remote
npm run deploy
```

Confirm the deployed Worker has the `STOREKIT_DB` binding, all Apple secrets, the intended allowed
environment/product set, and observability enabled. Send Apple’s test notification after configuring
the App Store Connect notification URL.

## Incident response

If Apple verification fails broadly, inspect only structured stage/operation diagnostics. Do not copy
JWS or credential values into logs or tickets. If D1 is unavailable, keep failure responses enabled so
Apple retries and reconcile notification history after recovery.
