# iOS client guide

How a StoreKit 2 app talks to this Worker. The rule behind every snippet: **send Apple-signed
material and read entitlement back from the server.** The client never tells the server what tier
the customer is on, and the server never believes it if it does.

## What the server needs

One field: `result.jwsRepresentation`, the Apple-signed JWS for a verified transaction. Nothing
else in the request influences entitlement.

## Sync after a purchase

```swift
import StoreKit

func purchase(_ product: Product, appAccountToken: UUID) async throws {
    // The token binds this purchase to your account id. Pin it server-side with
    // expectedAppAccountToken and a signed transaction can never be replayed onto someone else.
    let result = try await product.purchase(options: [.appAccountToken(appAccountToken)])

    guard case .success(let verification) = result,
          case .verified(let transaction) = verification else { return }

    try await syncWithServer(verification, appAccountToken: appAccountToken)
    await transaction.finish()   // only after your server has the transaction
}

func syncWithServer(
    _ verification: VerificationResult<Transaction>,
    appAccountToken: UUID? = nil
) async throws {
    var request = URLRequest(url: api.appendingPathComponent("storekit/transactions/sync"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(await session.accessToken())", forHTTPHeaderField: "Authorization")

    var body: [String: String] = ["signedTransactionJWS": verification.jwsRepresentation]
    if let appAccountToken { body["appAccountToken"] = appAccountToken.uuidString }
    request.httpBody = try JSONEncoder().encode(body)

    let (data, response) = try await URLSession.shared.data(for: request)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw SyncError.rejected }
    entitlement = try JSONDecoder().decode(Entitlement.self, from: data)
}
```

Call `transaction.finish()` **after** the sync succeeds. Finishing first means a network failure
loses the purchase from `Transaction.unfinished` and the customer pays for nothing.

## The three other times you must sync

```swift
// 1. At launch and on foreground: covers a renewal that happened while the app was closed.
for await entitlement in await refreshEntitlement() { … }

// 2. Transaction.updates: renewals, Ask to Buy approvals, purchases made on another device.
//    Start this listener at launch and never cancel it.
Task.detached {
    for await result in Transaction.updates {
        guard case .verified(let transaction) = result else { continue }
        try? await syncWithServer(result)
        await transaction.finish()
    }
}

// 3. Restore purchases: iterate what Apple currently entitles this Apple Account to.
func restore() async throws {
    try await AppStore.sync()
    for await result in Transaction.currentEntitlements {
        guard case .verified = result else { continue }
        try await syncWithServer(result)
    }
}
```

## Read the entitlement

```swift
struct Entitlement: Decodable {
    let proActive: Bool
    let productId: String?
    let accessExpiresAt: Date?      // gate on this
    let expiresAt: Date?            // do NOT gate on this
    let isTrial: Bool
    let status: String
    let autoRenewStatus: Int?
    let autoRenewProductId: String?
}

let entitlement: Entitlement = try await api.get("/storekit/entitlement")
if entitlement.proActive { unlockPro() }
```

`proActive` is the answer. It already accounts for billing grace periods, perpetual non-consumables,
refunds, and revocations, and it is re-evaluated at read time so a lapse needs no cron job.

**Gate on `accessExpiresAt`, never `expiresAt`.** During a billing grace period the subscription's
own `expiresAt` is already in the past while Apple keeps serving the customer. An app that reads
`expiresAt` locks out paying customers for the entire grace window.

## Handling each status in the UI

| `status`        | What the customer sees                                                           |
| --------------- | -------------------------------------------------------------------------------- |
| `active_paid`   | Full access.                                                                     |
| `active_trial`  | Full access, plus days remaining and what happens when the trial ends.           |
| `grace_period`  | Full access **and** a "update your payment method" prompt. Do not lock them out. |
| `billing_retry` | Locked, with a payment-update prompt — this is recoverable, not churn.           |
| `expired`       | Locked, with a resubscribe offer.                                                |
| `refunded`      | Locked. Terminal; do not offer a "restore" that appears to bring it back.        |
| `revoked`       | Locked (family sharing removed, or entitlement revoked).                         |
| `free`          | Never purchased.                                                                 |

`autoRenewStatus == 0` means the customer has turned renewal off but still has access until
`accessExpiresAt` — that is the moment to run a win-back offer, not a lockout.

## Offline and failure behaviour

Cache the last entitlement locally and keep serving it until `accessExpiresAt`. That is safe: the
value is server-issued and time-bounded. Re-sync on launch, foreground, and every
`Transaction.updates` event. Never grant access from a local StoreKit read alone — a jailbroken
device can forge it, which is the reason this Worker exists.

## Sandbox testing

- Sandbox subscription periods are accelerated: a month renews in minutes, so renewal, expiry and
  grace-period paths are all testable in one sitting.
- Force a billing failure from **Settings > Developer > Sandbox Apple Account** to exercise
  `grace_period` and `billing_retry`.
- Allow `Sandbox` in `STOREKIT_ALLOWED_ENVIRONMENTS` only where you mean to. Production Workers
  should list `Production` alone; see [configuration.md](configuration.md#environments).

## Do not send

- Product ids, prices, expiry dates, or a `isPro` flag as request fields. They are ignored, and
  believing them is exactly the bug this package prevents.
- `Transaction.currentEntitlements` decoded client-side as your source of truth.
- An installation id or device id as identity. Anyone can send one and claim another customer's
  subscription; identity comes from your own authenticated session, which is what `authenticate`
  reads.
