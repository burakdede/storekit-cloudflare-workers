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
    switch (response as? HTTPURLResponse)?.statusCode {
    case 200:
        entitlement = try JSONDecoder().decode(Entitlement.self, from: data)
    case 409:
        // This purchase is already bound to a different account. Retrying will never succeed —
        // show a support path instead of a spinner. See "When the server answers 409" below.
        throw SyncError.ownedByAnotherAccount
    case 503:
        // Apple or the backend is briefly unavailable. Safe to retry with backoff; do not finish
        // the transaction, so StoreKit replays it.
        throw SyncError.temporarilyUnavailable
    default:
        throw SyncError.rejected
    }
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

## When the server answers 409

The first account to sync a transaction owns it. A sync from any other account is refused, so a
signed transaction that leaks cannot take a paying customer's access away.

The client consequence: **`409` is terminal, not transient.** Retrying it, or looping on it at every
launch, will never succeed.

```swift
catch SyncError.ownedByAnotherAccount {
    // Do not finish the transaction and do not retry on a timer.
    show("This purchase is already in use on another account.", action: .contactSupport)
}
```

It is most likely when someone signed into your app with a new account while keeping the same Apple
Account. Moving the purchase is a deliberate support action on the server side; see
[configuration.md](configuration.md#storekit_allow_account_transfer).

Passing `appAccountToken` at purchase, as the snippet above does, is what prevents this from
happening by accident in the first place.

## Read the entitlement

```swift
struct Entitlement: Decodable {
    let proActive: Bool
    let productId: String?
    let accessExpiresAt: Date?      // gate on this
    let expiresAt: Date?            // do NOT gate on this
    let renewalDate: Date?          // show this
    let isTrial: Bool
    let status: String
    let autoRenewStatus: Int?
    let autoRenewProductId: String?
    let inAppOwnershipType: String? // "PURCHASED" or "FAMILY_SHARED"
    let entitlements: [Entry]

    struct Entry: Decodable {
        let proActive: Bool
        let productId: String?
        let subscriptionGroupIdentifier: String?
        let accessExpiresAt: Date?
        let perpetual: Bool
        let status: String
    }
}

let entitlement: Entitlement = try await api.get("/storekit/entitlement")
if entitlement.proActive { unlockPro() }
```

**Selling one thing?** The top-level fields are all you need, and nothing above is required reading.

**Selling more than one?** Use `entitlements`, which carries one entry per subscription group. A
lifetime unlock has no group and appears as its own entry with `perpetual: true`. Gating a second
product on the top-level `productId` lets whichever entitlement ranks highest decide both:

```swift
let owns = Set(entitlement.entitlements.filter(\.proActive).compactMap(\.productId))
if owns.contains("com.example.pro.monthly") { unlockPro() }
if owns.contains("com.example.extra.storage") { unlockStorage() }
```

**Show `renewalDate`, not `expiresAt`.** During a billing grace period `expiresAt` is already in the
past — which is exactly when a customer opens the subscription screen to find out why.

`proActive` is the answer. It already accounts for billing grace periods, perpetual non-consumables,
refunds, and revocations, and it is re-evaluated at read time so a lapse needs no cron job.

**Gate on `accessExpiresAt`, never `expiresAt`.** During a billing grace period the subscription's
own `expiresAt` is already in the past while Apple keeps serving the customer. An app that reads
`expiresAt` locks out paying customers for the entire grace window.

## Handling each status in the UI

| `status`         | What the customer sees                                                           |
| ---------------- | -------------------------------------------------------------------------------- |
| `active_paid`    | Full access.                                                                     |
| `active_trial`   | Full access, plus days remaining and what happens when the trial ends.           |
| `grace_period`   | Full access **and** a "update your payment method" prompt. Do not lock them out. |
| `billing_retry`  | Locked, with a payment-update prompt — this is recoverable, not churn.           |
| `expired`        | Locked, with a resubscribe offer.                                                |
| `refunded`       | Locked. Terminal; do not offer a "restore" that appears to bring it back.        |
| `family_revoked` | Locked. The family organiser stopped sharing — offer their own subscription.     |
| `revoked`        | Locked. Apple reported a revocation with nothing to attribute it to.             |
| `upgraded`       | Transitional. This transaction was replaced; re-sync to pick up the new one.     |
| `family_shared`  | Locked, and only if you exclude shared purchases. Say why, or it reads as a bug. |
| `free`           | Never purchased.                                                                 |
| `unknown`        | Apple sent a status this version does not map. Treat as locked, and log it.      |

`autoRenewStatus == 0` means the customer has turned renewal off but still has access until
`accessExpiresAt` — that is the moment to run a win-back offer, not a lockout. The server reports
`eligibleWinBackOfferIds` when Apple says the customer qualifies for one.

`inAppOwnershipType == "FAMILY_SHARED"` means a family organiser is paying. Worth saying so in an
account screen: a customer who cannot find their own subscription to manage will otherwise open a
support ticket.

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
