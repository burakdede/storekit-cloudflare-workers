# Configuration

`wrangler.jsonc` contains non-secret defaults and the D1 binding. Keep private keys and certificate
material out of the file and source control.

## Worker variables

| Variable                               | Required            | Meaning                                                       |
| -------------------------------------- | ------------------- | ------------------------------------------------------------- |
| `STOREKIT_ALLOWED_ENVIRONMENTS`        | yes                 | `Production`, `Sandbox`, or both, comma-separated.            |
| `STOREKIT_BUNDLE_ID`                   | yes                 | Exact App Store bundle ID.                                    |
| `STOREKIT_ALLOWED_PRODUCT_IDS`         | yes                 | Closed comma-separated product ID allow-list.                 |
| `STOREKIT_ALLOW_APPLE_LOOKUP_FALLBACK` | recommended `false` | If `false`, Apple API lookup failure fails sync closed.       |
| `STOREKIT_ALLOW_GRACE_PERIOD_ACCESS`   | recommended `true`  | Whether the policy grants access during billing grace period. |
| `STOREKIT_DB`                          | yes                 | D1 binding name used by this project.                         |

## Secrets

| Secret                          | Meaning                                                 |
| ------------------------------- | ------------------------------------------------------- |
| `APP_STORE_CONNECT_ISSUER_ID`   | App Store Connect API issuer ID.                        |
| `APP_STORE_CONNECT_KEY_ID`      | App Store Connect API key ID.                           |
| `APP_STORE_CONNECT_PRIVATE_KEY` | App Store Connect private key PEM.                      |
| `APPLE_ROOT_CERTIFICATES_PEM`   | Apple root certificate PEM bundle for JWS verification. |
| `APP_STORE_APP_APPLE_ID`        | Numeric Apple app ID for production verification.       |

Use separate secrets and Worker environments for production and sandbox. Preserve PEM newlines when
storing the private key and certificate bundle.

## Environment policy

Allowing `Sandbox` is an explicit server policy decision. A production Worker should usually allow
only `Production`. A staging Worker may allow only `Sandbox`. Do not allow a client-provided
environment to override this configuration.
