# Apple contract references

This project follows Apple’s StoreKit server contracts and the official Apple server library. Verify
these documents when Apple changes notification fields or API behavior:

- [App Store Server API](https://developer.apple.com/documentation/appstoreserverapi)
- [Get Transaction Info](https://developer.apple.com/documentation/appstoreserverapi/get-transaction-info)
- [Get All Subscription Statuses](https://developer.apple.com/documentation/AppStoreServerAPI/Get-All-Subscription-Statuses)
- [App Store Server Notifications V2](https://developer.apple.com/documentation/appstoreservernotifications/app-store-server-notifications-v2)
- [Receiving Notifications](https://developer.apple.com/documentation/appstoreservernotifications/receiving-app-store-server-notifications)
- [Responding to Notifications](https://developer.apple.com/documentation/AppStoreServerNotifications/responding-to-app-store-server-notifications)

The service intentionally treats Apple-signed data as authoritative only after signature, bundle,
environment, product, and transaction identity validation. It does not implement legacy receipt or
V1 notification flows.
