# Apple contract references

This project follows Apple's StoreKit server contracts and the official Apple server library. Verify
these documents when Apple changes notification fields or API behavior:

- [App Store Server API](https://developer.apple.com/documentation/appstoreserverapi)
- [Get Transaction Info](https://developer.apple.com/documentation/appstoreserverapi/get-transaction-info)
- [Get All Subscription Statuses](https://developer.apple.com/documentation/AppStoreServerAPI/Get-All-Subscription-Statuses)
- [App Store Server Notifications V2](https://developer.apple.com/documentation/appstoreservernotifications/app-store-server-notifications-v2)
- [Receiving Notifications](https://developer.apple.com/documentation/appstoreservernotifications/receiving-app-store-server-notifications)
- [Responding to Notifications](https://developer.apple.com/documentation/AppStoreServerNotifications/responding-to-app-store-server-notifications)
- [JWSRenewalInfoDecodedPayload](https://developer.apple.com/documentation/appstoreserverapi/jwsrenewalinfodecodedpayload)
- [Get Notification History](https://developer.apple.com/documentation/appstoreserverapi/get-notification-history)
- [Send Consumption Information](https://developer.apple.com/documentation/appstoreserverapi/send-consumption-information)
- [Apple PKI root certificates](https://www.apple.com/certificateauthority/)

## Fields this module depends on

| Apple field                             | Why it matters here                                                    |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `status` (subscription)                 | 1 active, 2 expired, 3 billing retry, 4 grace period, 5 revoked        |
| `gracePeriodExpiresDate` (renewal info) | The real access deadline during status 4; `expiresDate` has passed     |
| `offerDiscountType` (transaction)       | Distinguishes a free trial from a paid introductory offer              |
| `revocationDate` / `revocationReason`   | Refunds and family-sharing revocations; terminal                       |
| `signedDate`                            | Apple's signing time, used to order out-of-order notification delivery |
| `type`                                  | Identifies a non-consumable, which never expires                       |

The service intentionally treats Apple-signed data as authoritative only after signature, bundle,
environment, product, and transaction identity validation. It does not implement legacy receipt or
V1 notification flows.

## Trademarks

This is an independent project, not affiliated with, endorsed by, or sponsored by Apple Inc. or
Cloudflare, Inc. Apple, App Store, StoreKit, and TestFlight are trademarks of Apple Inc. Cloudflare,
Cloudflare Workers, and D1 are trademarks of Cloudflare, Inc. They are used here only to identify
the services this software interoperates with.
