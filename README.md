# cf-worker-storekit2

Server-authoritative StoreKit 2 verification and entitlement persistence for Cloudflare Workers and D1.

This project is a Worker repository, not a hosted service. It gives you the Apple verification,
entitlement policy, D1 schema, idempotent App Store Server Notifications V2 handling, and a small
reference HTTP Worker. You supply your application's authentication and account/installation model.

## What it does

- Verifies Apple-signed transaction and notification JWS values with Apple’s official server library.
- Checks bundle ID, environment, transaction identity, and a closed product allow-list.
- Uses Apple transaction and subscription-status lookups when configured.
- Supports configurable fail-open/fail-closed behavior when Apple lookups are unavailable.
- Resolves paid, introductory-trial, grace-period, billing-retry, expired, revoked, and refunded states.
- Persists transaction audit rows, subscription projections, and notification replay state in D1.
- Uses D1 batches for atomic notification plus projection writes.
- Accepts valid transactionless V2 notification payloads without inventing entitlement state.
- Re-evaluates expiry when reading an entitlement instead of trusting an old boolean.

## What it does not do

- It does not authenticate your users, installations, or app-account tokens. Implement `src/auth.ts`.
- It does not grant entitlement from a client product ID, receipt, expiry, price, or local premium flag.
- It does not automatically reconcile missed notifications. Schedule your own Apple history/status
  reconciliation using the service APIs and operational procedures in `docs/operations.md`.
- It does not provide a dashboard, billing UI, webhook queue, analytics pipeline, or email service.
- It does not support StoreKit 1 receipt verification or legacy App Store Server Notifications V1.
- It does not make App Store Connect API credentials safe to expose to an iOS client; they remain
  Worker secrets.

## Five-minute setup

Prerequisites: Node.js 22+, an authenticated Wrangler session, and a Cloudflare account.

```bash
git clone https://github.com/YOUR_ORG/cf-worker-storekit2.git
cd cf-worker-storekit2
npm install
npx wrangler login
npx wrangler d1 create cf-worker-storekit2
```

Copy the returned database ID into `wrangler.jsonc` and choose your real values for:

- `STOREKIT_BUNDLE_ID`
- `STOREKIT_ALLOWED_PRODUCT_IDS`
- `STOREKIT_ALLOWED_ENVIRONMENTS`
- `STOREKIT_ALLOW_APPLE_LOOKUP_FALLBACK`

Generate binding types and apply the schema:

```bash
npm run cf:typegen
npm run db:migrate:local
npm run dev
```

Before deploying, replace the intentionally fail-closed `src/auth.ts` adapter with your existing
session/JWT/App Attest/authentication integration. It must return an `installationId` and the exact
authenticated `appBundleId`; never derive either from an untrusted request body or header.

Configure Apple credentials as Wrangler secrets:

```bash
npx wrangler secret put APP_STORE_CONNECT_ISSUER_ID
npx wrangler secret put APP_STORE_CONNECT_KEY_ID
npx wrangler secret put APP_STORE_CONNECT_PRIVATE_KEY
npx wrangler secret put APPLE_ROOT_CERTIFICATES_PEM
npx wrangler secret put APP_STORE_APP_APPLE_ID
```

Apply the remote migration and deploy:

```bash
npm run db:migrate:remote
npm run release:check
npm run deploy
```

The reference Worker exposes:

| Method | Path                             | Authentication             |
| ------ | -------------------------------- | -------------------------- |
| `POST` | `/v1/storekit/transactions/sync` | Your `src/auth.ts` adapter |
| `GET`  | `/v1/storekit/entitlement`       | Your `src/auth.ts` adapter |
| `POST` | `/v1/storekit/notifications`     | Apple JWS verification     |
| `GET`  | `/health`                        | Public                     |

Apple must be configured to send App Store Server Notifications V2 to the deployed notification URL.
Return success for handled notifications and an error for failures so Apple can retry. See
[`docs/operations.md`](docs/operations.md) for outage recovery and monitoring.

## Architecture

```text
your auth/router ─┐
                  ├─ storekit-service ── storekit.ts ── Apple SDK + Apple APIs
Apple webhook ────┘          │
                             └─ storekit-d1 ── Cloudflare D1
                                  │
                         entitlement policy core
```

The reusable public surface is [`src/storekit-module.ts`](src/storekit-module.ts). The reference
HTTP Worker is intentionally thin. The policy core has no Apple SDK, HTTP, or database dependency.

## Configuration and security

Read [`docs/configuration.md`](docs/configuration.md) before production use and
[`docs/security.md`](docs/security.md) before publishing an integration. Apple’s current server
contracts are linked in [`docs/apple-contract.md`](docs/apple-contract.md).

## Development

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npx wrangler deploy --dry-run --outdir=/tmp/cf-worker-storekit2-dry-run
```

Tests use injectable verifier/runtime boundaries and D1 fakes; no Apple private keys or production
transactions are stored in this repository. A real Apple-signed fixture test should be added only
with non-sensitive StoreKit test material.

## License

MIT. See [`LICENSE`](LICENSE).
